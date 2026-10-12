#!/usr/bin/env bash
#
# 端到端演练：整条通知链路（API 写入 → 真实 Worker 进程 → HTTP 发送 → 标记已送达）
#
# 为什么需要它：单元测试只覆盖零件（分类函数、退避、租约），
# 而"真实 Worker 进程能否把任务领走、发出、正确落库"从未被端到端验证过。
#
# 用本地模拟端点充当 iLink，因此**不需要真实凭据**；
# 模拟端点严格按协议应答，并记录收到的请求供断言。
# 全程只操作测试库，不触碰生产。
#
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MOCK_PORT=8899

WORK="$(mktemp -d /tmp/lifeos-notify-e2e-XXXXXX)"
WORKER_PID=""
MOCK_PID=""

cleanup() {
  [ -n "$WORKER_PID" ] && kill "$WORKER_PID" 2>/dev/null || true
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

pass=0; fail=0
ok()  { printf '  ✅ %s\n' "$*"; pass=$((pass+1)); }
bad() { printf '  ❌ %s\n' "$*" >&2; fail=$((fail+1)); }

TEST_URL="$(grep '^DATABASE_URL=' /opt/lifeos/.env 2>/dev/null | cut -d= -f2- | sed 's#/lifeos$#/lifeos_test#')"
[ -n "$TEST_URL" ] || { echo "无法取得测试库连接串" >&2; exit 1; }

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

# ── 2. 造一条待发任务（直接写测试库，模拟 API 已排入队列）──────
JOB_KEY="e2e:$(date +%s)-$RANDOM"
psql "$TEST_URL" -q -v ON_ERROR_STOP=1 <<SQL
TRUNCATE notification_attempts, notification_jobs RESTART IDENTITY CASCADE;
INSERT INTO notification_jobs
  (subject_type, subject_id, title, body, fire_at, status, idempotency_key, max_attempts)
VALUES
  ('system', gen_random_uuid(), '端到端演练提醒', '验证 Worker 是否真正发出', now() - interval '1 second', 'pending', '$JOB_KEY', 3);
SQL
ok "已排入一条待发任务"

# ── 3. 启动真实 Worker 进程（指向测试库与模拟端点）─────────────
cd "$REPO_ROOT"
DATABASE_URL="$TEST_URL" \
ILINK_TOKEN='e2e-token' \
ILINK_TO_USER_ID='e2e-recipient' \
ILINK_CONTEXT_TOKEN='e2e-context' \
ILINK_BASE_URL="http://127.0.0.1:$MOCK_PORT" \
WORKER_POLL_MS=1000 \
node --import tsx src/worker/index.ts > "$WORK/worker.log" 2>&1 &
WORKER_PID=$!
ok "已启动独立 Worker 进程（pid $WORKER_PID）"

# ── 4. 等待并断言 ─────────────────────────────────────────────
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

# 尝试记录必须落库
attempts="$(psql "$TEST_URL" -tA -c "SELECT count(*) FROM notification_attempts a JOIN notification_jobs j ON j.id = a.job_id WHERE j.idempotency_key = '$JOB_KEY' AND a.success")"
[ "${attempts:-0}" -ge 1 ] && ok "已记录成功的发送尝试（$attempts 条）" || bad "未记录发送尝试"

# ── 5. 断言模拟端点收到的请求符合协议 ─────────────────────────
raw="$(curl -s --max-time 5 "http://127.0.0.1:$MOCK_PORT/_received")"
count="$(printf '%s' "$raw" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s||"[]").length))')"
[ "$count" = "1" ] && ok "模拟端点收到恰好 1 次请求" || bad "请求次数异常：$count"

printf '%s' "$raw" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const r = JSON.parse(s||"[]")[0] ?? {};
  const checks = [
    [r.url === "/ilink/bot/sendmessage", "端点为 /ilink/bot/sendmessage"],
    [r.method === "POST", "方法为 POST"],
    [r.authorization === "Bearer e2e-token", "带 Bearer 鉴权头"],
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
