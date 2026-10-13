#!/usr/bin/env bash
#
# 端到端演练：整条通知链路（API 写入 → 真实 Worker 进程 → HTTP 发送 → 标记已送达）
#
# 为什么需要它：单元测试只覆盖零件（分类函数、退避、租约），
# 而"真实 Worker 进程能否把任务领走、发出、正确落库"从未被端到端验证过。
#
# 用本地模拟端点充当 iLink，因此**不需要真实微信**；
# 模拟端点严格按协议应答，并记录收到的请求供断言。
# 全程只操作测试库，不触碰生产。
#
# ⚠️ 多用户改造后（2026-10-13）本脚本的夹具变了：
#   - 发送凭据**不再来自 ILINK_* 环境变量**（那条全局兜底已被有意移除，
#     因为一个全局凭据无法归属到任何账号）。现在必须在测试库里造一个
#     `wechat_accounts` 行（每个账号一份绑定），Worker 只领取"该账号自己可发送"的任务。
#   - 密文必须用**应用自己的** `seal()` 生成：手写密文格式会在加密算法或 AAD
#     变更时静默失效（表现为"渠道看起来已配置但发不出去"）。
#   - `notification_jobs` / `notification_attempts` 现在都有 `user_id NOT NULL`。
#
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MOCK_PORT=8899
E2E_PREFIX="e2e-notify"

WORK="$(mktemp -d /tmp/lifeos-notify-e2e-XXXXXX)"
WORKER_PID=""
MOCK_PID=""
TEST_URL=""

cleanup() {
  [ -n "$WORKER_PID" ] && kill "$WORKER_PID" 2>/dev/null || true
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null || true
  # 清掉演练账号（含其 wechat_accounts 与提醒任务，都是 ON DELETE CASCADE）
  if [ -n "$TEST_URL" ]; then
    psql "$TEST_URL" -q -c "DELETE FROM users WHERE username LIKE '${E2E_PREFIX}-%'" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

pass=0; fail=0
ok()  { printf '  ✅ %s\n' "$*"; pass=$((pass+1)); }
bad() { printf '  ❌ %s\n' "$*" >&2; fail=$((fail+1)); }

TEST_URL="$(grep '^DATABASE_URL=' /opt/lifeos/.env 2>/dev/null | cut -d= -f2- | sed 's#/lifeos$#/lifeos_test#')"
[ -n "$TEST_URL" ] || { echo "无法取得测试库连接串" >&2; exit 1; }

# SESSION_SECRET 只在本进程内传递，绝不打印（密文要用它生成，Worker 也要用它解开）
SESSION_SECRET_VALUE="$(grep '^SESSION_SECRET=' /opt/lifeos/.env 2>/dev/null | cut -d= -f2-)"
[ -n "$SESSION_SECRET_VALUE" ] || { echo "无法取得 SESSION_SECRET（凭据密文需要它）" >&2; exit 1; }

# ── 1. 模拟 iLink 端点 ─────────────────────────────────────────
cat > "$WORK/mock-ilink.mjs" <<'EOF'
import http from 'node:http';
const received = [];
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url === '/_received') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(received));
      return;
    }
    received.push({
      url: req.url,
      method: req.method,
      authorization: req.headers.authorization ?? null,
      authorizationType: req.headers.authorizationtype ?? null,
      uin: req.headers['x-wechat-uin'] ?? null,
      body,
    });
    // 严格按协议应答：业务码为 0 才算接受
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ret: 0, errcode: 0, message_id: 'mock-message-1' }));
  });
}).listen(Number(process.env.MOCK_PORT ?? 8899), '127.0.0.1', () => {
  console.log('mock ilink listening');
});
EOF

MOCK_PORT="$MOCK_PORT" node "$WORK/mock-ilink.mjs" > "$WORK/mock.log" 2>&1 &
MOCK_PID=$!
sleep 1
if curl -s --max-time 5 "http://127.0.0.1:$MOCK_PORT/_received" > /dev/null; then
  ok "模拟 iLink 端点已启动（127.0.0.1:$MOCK_PORT）"
else
  bad "模拟端点启动失败"; cat "$WORK/mock.log" >&2; exit 1
fi

# ── 2. 用应用自己的 seal() 生成凭据密文 ────────────────────────
cat > "$WORK/seal.ts" <<EOF
import { seal } from '${REPO_ROOT}/src/server/lib/wechat-state';
// 凭据里的 baseUrl 指向模拟端点：Worker 会用它作为该账号的发送地址
const creds = {
  token: 'e2e-token',
  userId: 'e2e-recipient',
  botId: 'e2e-bot',
  baseUrl: 'http://127.0.0.1:${MOCK_PORT}',
};
process.stdout.write(JSON.stringify({ account: seal(creds), context: seal('e2e-context') }));
EOF

if ! SEALED="$(cd "$REPO_ROOT" && SESSION_SECRET="$SESSION_SECRET_VALUE" node --import tsx "$WORK/seal.ts" 2>"$WORK/seal.err")"; then
  bad "生成凭据密文失败（seal() 调用出错）"; cat "$WORK/seal.err" >&2; exit 1
fi
ACCOUNT_ENC="$(printf '%s' "$SEALED" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).account))')"
CONTEXT_ENC="$(printf '%s' "$SEALED" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).context))')"
[ -n "$ACCOUNT_ENC" ] && [ -n "$CONTEXT_ENC" ] && ok "已用应用的 seal() 生成凭据与上下文密文" || { bad "密文为空"; exit 1; }

# ── 3. 在测试库里造一个"已绑定可发送"的账号 + 一条待发任务 ──────
JOB_KEY="e2e:$(date +%s)-$RANDOM"
E2E_USER="${E2E_PREFIX}-$(date +%s)"

# 分两条独立语句执行，且加 `-q`：
#   - 把 `DELETE` 与 `INSERT ... RETURNING` 塞进同一个 `psql -c` 会让 psql 打印
#     DELETE 的命令标签并与后面的 SQL 拼在一起（报 `syntax error at or near "0"`）；
#   - 即使只有 INSERT，`psql -tA -c "... RETURNING id"` 也会在 id 之后**再打印一行命令标签**
#     `INSERT 0 1`，于是捕获到的值会变成 `8INSERT01`（真的这样挂过）。
#     所以既要 `-q` 抑制标签，又只取第一行，并校验它确实是数字。
psql "$TEST_URL" -q -v ON_ERROR_STOP=1 -c "DELETE FROM users WHERE username LIKE '${E2E_PREFIX}-%';"
USER_ID="$(psql "$TEST_URL" -qtA -v ON_ERROR_STOP=1 -c "
  INSERT INTO users (username, password_hash)
  VALUES ('${E2E_USER}', 'e2e-not-a-real-hash')
  RETURNING id;")"
USER_ID="$(printf '%s' "$USER_ID" | head -1 | tr -d '[:space:]')"
case "$USER_ID" in
  ''|*[!0-9]*) bad "演练账号 id 取值异常：[$USER_ID]（期望纯数字）"; exit 1 ;;
esac
[ "$USER_ID" -gt 0 ] || { bad "演练账号 id 非正数：$USER_ID"; exit 1; }

psql "$TEST_URL" -q -v ON_ERROR_STOP=1 <<SQL
-- 每账号一份微信绑定：有凭据 + 有上下文 + 窗口未用尽 => 可发送
INSERT INTO wechat_accounts (user_id, generation, revision, account_enc, context_enc, cursor, used)
VALUES ($USER_ID, gen_random_uuid(), gen_random_uuid(), '$ACCOUNT_ENC', '$CONTEXT_ENC', '', 0);

INSERT INTO notification_jobs
  (user_id, subject_type, subject_id, title, body, fire_at, status, idempotency_key, max_attempts)
VALUES
  ($USER_ID, 'system', gen_random_uuid(), '端到端演练提醒', '验证 Worker 是否真正发出',
   now() - interval '1 second', 'pending', '$JOB_KEY', 3);
SQL
ok "已为账号 $E2E_USER（id=$USER_ID）建立绑定并排入一条待发任务"

# ── 4. 启动真实 Worker 进程 ────────────────────────────────────
# 刻意**不设** ILINK_* ：发送凭据只能来自该账号自己的 wechat_accounts 行。
# 如果这里仍然发得出去，说明环境变量通道又回来了（那是跨账号泄露的入口）。
cd "$REPO_ROOT"
DATABASE_URL="$TEST_URL" \
SESSION_SECRET="$SESSION_SECRET_VALUE" \
WORKER_POLL_MS=1000 \
node --import tsx src/worker/index.ts > "$WORK/worker.log" 2>&1 &
WORKER_PID=$!
ok "已启动独立 Worker 进程（pid $WORKER_PID，未提供任何 ILINK_* 凭据）"

# ── 5. 等待并断言 ─────────────────────────────────────────────
status=""
for _ in $(seq 1 30); do
  sleep 1
  status="$(psql "$TEST_URL" -tA -c "SELECT status FROM notification_jobs WHERE idempotency_key = '$JOB_KEY'")"
  [ "$status" = "sent" ] && break
done

if [ "$status" = "sent" ]; then
  ok "Worker 已把任务标记为 sent"
else
  bad "任务未在 30 秒内送达（当前状态：$status）"
  echo '--- worker 日志 ---' >&2
  tail -20 "$WORK/worker.log" >&2
fi

# 尝试记录必须落库，且**归属与任务一致**（复合外键会强制这一点，这里再验一次）
attempts="$(psql "$TEST_URL" -tA -c "SELECT count(*) FROM notification_attempts a JOIN notification_jobs j ON j.id = a.job_id WHERE j.idempotency_key = '$JOB_KEY' AND a.success")"
[ "${attempts:-0}" -ge 1 ] && ok "已记录成功的发送尝试（$attempts 条）" || bad "未记录发送尝试"

mismatch="$(psql "$TEST_URL" -tA -c "SELECT count(*) FROM notification_attempts a JOIN notification_jobs j ON j.id = a.job_id WHERE j.idempotency_key = '$JOB_KEY' AND a.user_id <> j.user_id")"
[ "${mismatch:-0}" = "0" ] && ok "发送尝试的归属与任务一致" || bad "有 $mismatch 条发送尝试归属与任务不一致"

# ── 6. 断言模拟端点收到的请求符合协议 ─────────────────────────
raw="$(curl -s --max-time 5 "http://127.0.0.1:$MOCK_PORT/_received")"
# 接收轮询会打 getupdates，但只有发送请求算数；按 URL 过滤后再断言
sent_raw="$(printf '%s' "$raw" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const all = JSON.parse(s||"[]");
  process.stdout.write(JSON.stringify(all.filter(r => r.url === "/ilink/bot/sendmessage")));
})')"
count="$(printf '%s' "$sent_raw" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s||"[]").length))')"
[ "$count" = "1" ] && ok "模拟端点收到恰好 1 次发送请求" || bad "发送请求次数异常：$count"

printf '%s' "$sent_raw" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const r = JSON.parse(s||"[]")[0] ?? {};
  const checks = [
    [r.url === "/ilink/bot/sendmessage", "端点为 /ilink/bot/sendmessage"],
    [r.method === "POST", "方法为 POST"],
    [r.authorization === "Bearer e2e-token", "带 Bearer 鉴权头（来自该账号自己的绑定）"],
    [r.authorizationType === "ilink_bot_token", "带 AuthorizationType"],
    [Boolean(r.uin), "带 X-WECHAT-UIN"],
  ];
  try {
    const b = JSON.parse(r.body);
    checks.push([b.msg?.to_user_id === "e2e-recipient", "收件人正确"]);
    checks.push([b.msg?.message_type === 2 && b.msg?.message_state === 2, "消息类型与状态符合协议"]);
    checks.push([Array.isArray(b.msg?.item_list) && b.msg.item_list[0]?.type === 1, "文本消息结构正确"]);
    checks.push([typeof b.msg?.context_token === "string", "携带 context_token"]);
    checks.push([b.msg?.client_id?.startsWith("lifeos:") === true, "client_id 由幂等键派生（供下游去重）"]);
    checks.push([Boolean(b.base_info?.channel_version), "携带 channel_version"]);
  } catch { checks.push([false, "请求体是合法 JSON"]); }
  let failed = 0;
  for (const [pass, label] of checks) {
    console.log((pass ? "  ✅ " : "  ❌ ") + label);
    if (!pass) failed++;
  }
  process.exit(failed > 0 ? 1 : 0);
});
' && ok "请求内容完全符合 iLink 协议" || bad "请求内容与协议不符"

echo
printf '通知链路端到端演练：%d 通过 / %d 失败\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
