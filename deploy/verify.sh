#!/usr/bin/env bash
#
# Life OS 线上自检（可反复执行，只读为主）
#
#   sudo bash deploy/verify.sh
#
# 设计约束：
# - **不使用管理员密码**：认证类用例只验证"未登录必须被拒"等无需凭据的行为；
#   需要登录的检查请人工在浏览器完成，本脚本不读取、不传播也不重置任何密码。
# - 不修改生产数据：需要写库的验证一律在测试库进行（见 npm test）。
#
set -uo pipefail

DOMAIN="${DOMAIN:-life.o2lin1.com}"
BASE="https://$DOMAIN"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pass=0
fail=0
warn=0

ok()   { printf '  ✅ %s\n' "$*"; pass=$((pass + 1)); }
bad()  { printf '  ❌ %s\n' "$*" >&2; fail=$((fail + 1)); }
note() { printf '  ⚠️  %s\n' "$*"; warn=$((warn + 1)); }
head2() { printf '\n── %s ──\n' "$*"; }

# ── 1. 服务 ────────────────────────────────────────────────────
head2 '服务状态'
for svc in lifeos-api lifeos-worker; do
  state="$(systemctl is-active "$svc" 2>/dev/null || true)"
  enabled="$(systemctl is-enabled "$svc" 2>/dev/null || true)"
  if [ "$state" = "active" ] && [ "$enabled" = "enabled" ]; then
    ok "$svc 运行中且开机自启"
  else
    bad "$svc 状态异常（active=$state enabled=$enabled）"
  fi
done
kaoyan_state="$(systemctl is-active kaoyan 2>/dev/null || true)"
if [ "$kaoyan_state" = "inactive" ]; then
  ok 'kaoyan 保持 inactive（本轮未启停、未改自启）'
else
  note "kaoyan 当前为 $kaoyan_state（本轮不应改动它）"
fi

# ── 2. 监听与反代 ──────────────────────────────────────────────
head2 '网络与反代'
if ss -tln | grep -q '127.0.0.1:8890'; then ok 'API 仅监听 127.0.0.1:8890'; else bad 'API 未监听 8890'; fi
if ss -tln | grep -qE '0\.0\.0\.0:5432|\*:5432'; then bad 'PostgreSQL 暴露到公网'; else ok 'PostgreSQL 未暴露公网'; fi

http_code="$(curl -s -o /dev/null -w '%{http_code}' "http://$DOMAIN/" || echo 000)"
[ "$http_code" = "301" ] || [ "$http_code" = "308" ] && ok "HTTP 跳转 HTTPS（$http_code）" || bad "HTTP 未跳转 HTTPS（$http_code）"

https_code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/" || echo 000)"
[ "$https_code" = "200" ] && ok "HTTPS 首页 200" || bad "HTTPS 首页 $https_code"

# ── 3. 安全响应头 ──────────────────────────────────────────────
head2 '安全响应头'
hdrs="$(curl -s -D - -o /dev/null "$BASE/" || true)"
for h in 'X-Content-Type-Options: nosniff' 'X-Frame-Options: DENY' 'Referrer-Policy: same-origin'; do
  printf '%s' "$hdrs" | grep -qi "^${h%%:*}" && ok "首页含 ${h%%:*}" || bad "首页缺少 ${h%%:*}"
done

# ── 4. API 缓存控制（A5）──────────────────────────────────────
head2 'API 缓存控制（A5）'
for path in /api/health /api/auth/me /api/status /api/notifications/jobs /api/definitely-not-exist; do
  cc="$(curl -s -D - -o /dev/null "$BASE$path" | grep -i '^cache-control' | tr -d '\r' | head -1)"
  case "$cc" in
    *no-store*) ok "$path 带 no-store（$cc）" ;;
    *) bad "$path 缺少 no-store（${cc:-无 Cache-Control}）" ;;
  esac
done

# ── 5. 认证隔离（无需凭据）─────────────────────────────────────
head2 '认证隔离（不涉及凭据）'
for path in /api/auth/me /api/status /api/notifications/jobs /api/notifications/providers; do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE$path")"
  [ "$code" = "401" ] && ok "未登录访问 $path → 401" || bad "未登录访问 $path → $code（应为 401）"
done

# 登录限速使用不存在的探针账号，避免影响真实管理员
head2 '登录限速（探针账号，不触碰 admin）'
last=""
for i in 1 2 3 4 5 6; do
  last="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/login" \
      -H 'content-type: application/json' \
      -d '{"username":"verify-probe-does-not-exist","password":"probe-wrong-password"}')"
done
[ "$last" = "429" ] && ok "连续失败后触发限速（第 6 次 $last）" || bad "限速未触发（第 6 次 $last）"

# ── 6. 数据库不变量 ────────────────────────────────────────────
head2 '数据库不变量'
PSQL='sudo -n -u postgres psql -d lifeos -tA'
# 表数量断言改为"必需表清单 + 下限"。
# 原先硬编码 `= 14`，V1.1 新增三张 wechat_* 表后必然误报
# （自检本应发现结构缺失，而不是因为**新增**表而失败）。
REQUIRED_TABLES='users audit_logs csv_import_batches events expected_bills notification_attempts notification_jobs notification_rules payments sessions settings subscription_price_history subscriptions tasks wechat_inbox wechat_operations wechat_outbox'
tables="$($PSQL -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" 2>/dev/null || echo '?')"
missing_tables=''
for t in $REQUIRED_TABLES; do
  exists="$($PSQL -c "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='$t';" 2>/dev/null || echo '')"
  [ "$exists" = "1" ] || missing_tables="$missing_tables $t"
done
required_count="$(printf '%s\n' $REQUIRED_TABLES | wc -l | tr -d ' ')"
if [ -n "$missing_tables" ]; then
  bad "生产库缺少必需表：$missing_tables"
elif [ "$tables" -lt "$required_count" ] 2>/dev/null; then
  bad "生产库表数量异常：$tables（至少应有 $required_count 张）"
else
  ok "生产库表结构完整（$tables 张，必需 $required_count 张齐备）"
fi

# V1.1：活动草稿的偏唯一索引是"同时最多一个草稿"的数据库级保证
op_uq="$($PSQL -c "SELECT 1 FROM pg_indexes WHERE indexname='wechat_operations_active_uq';" 2>/dev/null || echo '')"
[ "$op_uq" = "1" ] && ok 'wechat_operations 活动草稿唯一索引存在' || bad '缺少 wechat_operations_active_uq（同时最多一个草稿失去数据库保证）'

# 多用户改造后，账号**数量**不再是不变量（可以有很多个），
# 但"至少有一个启用中的管理员"仍然是硬性要求：否则没有任何人能再管理账号。
user_count="$($PSQL -c 'SELECT count(*) FROM users;' 2>/dev/null || echo '?')"
enabled_admins="$($PSQL -c 'SELECT count(*) FROM users WHERE is_admin AND disabled_at IS NULL;' 2>/dev/null || echo '?')"
if [ "$user_count" = '?' ]; then
  bad '无法读取 users 表（迁移未应用？）'
elif [ "$user_count" -lt 1 ] 2>/dev/null; then
  bad "账号数量为 $user_count，至少应有 1 个"
elif [ "$enabled_admins" -lt 1 ] 2>/dev/null; then
  bad '没有任何启用中的管理员：账号管理将无人可用'
else
  ok "账号 $user_count 个，其中启用中的管理员 $enabled_admins 个"
fi

# 反向断言：单管理员唯一索引必须已删除。
# 若它还在（例如误用 drizzle-kit 默认输出重建过表），第二个账号根本插不进去。
singleton="$($PSQL -c "SELECT count(*) FROM pg_indexes WHERE indexname='admin_users_singleton_uq';" 2>/dev/null || echo '?')"
[ "$singleton" = '0' ] && ok '单管理员唯一索引已解除（可创建多账号）' || bad '单管理员唯一索引仍存在：第二个账号无法创建'

if [ "$($PSQL -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='admin_users';" 2>/dev/null || echo '?')" = '0' ]; then
  ok '旧表 admin_users 已不存在（已重命名为 users）'
else
  bad 'admin_users 表仍然存在：users 迁移未生效或未完成'
fi

# 强制改密与禁用链路依赖这四列，逐列检查以免"迁移看起来成功但缺列"
for col in is_admin disabled_at must_change_password password_changed_at; do
  has="$($PSQL -c "SELECT count(*) FROM information_schema.columns WHERE table_name='users' AND column_name='$col';" 2>/dev/null || echo '?')"
  [ "$has" = '1' ] && ok "users.$col 存在" || bad "users 缺少 $col 列"
done

fk="$($PSQL -c "SELECT count(*) FROM information_schema.columns WHERE table_name='notification_jobs' AND column_name='failure_kind';" 2>/dev/null || echo '?')"
[ "$fk" = "1" ] && ok 'notification_jobs.failure_kind 存在' || bad '缺少 failure_kind 列'

# ── 7. 迁移一致性（仓库 vs 已应用）─────────────────────────────
head2 '迁移一致性（A4）'
mcount="$($PSQL -c 'SELECT count(*) FROM drizzle.__drizzle_migrations;' 2>/dev/null || echo '?')"
repo_count="$(find "$REPO_ROOT/drizzle" -maxdepth 1 -name '*.sql' | wc -l)"
if [ "$mcount" = "$repo_count" ]; then
  ok "已应用迁移数 $mcount 与仓库 SQL 数一致"
else
  bad "已应用 $mcount 条，仓库有 $repo_count 个 SQL —— 交付与运行不一致"
fi

applied="$($PSQL -c 'SELECT left(hash,16) FROM drizzle.__drizzle_migrations ORDER BY id;' 2>/dev/null | tr -d ' ' | sort)"
from_repo="$(cd "$REPO_ROOT" && for f in drizzle/*.sql; do sha256sum "$f" | cut -c1-16; done | sort)"
if [ "$applied" = "$from_repo" ]; then
  ok '已应用迁移哈希与仓库 SQL 完全一致'
else
  bad "迁移哈希不一致：已应用=[$(echo $applied | tr '\n' ' ')] 仓库=[$(echo $from_repo | tr '\n' ' ')]"
fi

# ── 8. 备份 ────────────────────────────────────────────────────
head2 '加密备份（A8）'
bdir=/var/backups/lifeos
dperm="$(stat -c %a "$bdir" 2>/dev/null || echo missing)"
[ "$dperm" = "700" ] && ok "备份目录权限 700" || bad "备份目录权限 $dperm（应为 700）"

latest="$(find "$bdir/daily" -name '*.gpg' -type f -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)"
if [ -n "$latest" ]; then
  fperm="$(stat -c %a "$latest")"
  [ "$fperm" = "600" ] && ok "最新备份权限 600" || bad "最新备份权限 $fperm"
  if gpg --batch --quiet --decrypt "$latest" 2>/dev/null | gzip -t 2>/dev/null; then
    ok "最新备份可解密且 gzip 完整（$(basename "$latest")）"
  else
    bad "最新备份无法解密或已损坏：$latest"
  fi
  plaintext="$(find "$bdir" -name '*.sql.gz' -type f 2>/dev/null | wc -l)"
  [ "$plaintext" = "0" ] && ok '备份目录中无明文 .sql.gz 残留' || note "存在 $plaintext 个未加密的备份文件"
else
  bad '找不到任何加密备份'
fi

if grep -q '^BACKUP_OFFSITE=.\+' /opt/lifeos/.env 2>/dev/null; then
  OFFSITE="$(grep '^BACKUP_OFFSITE=' /opt/lifeos/.env | cut -d= -f2-)"
  OFFSITE_HOST="${OFFSITE%%:*}"
  OFFSITE_DIR="${OFFSITE#*:}"

  # 不只看配置存在，而是真的验证"能不能连上、远端有没有备份"——
  # 只检查配置会把"配了但从没传成功"误判为通过
  if ssh -o BatchMode=yes -o ConnectTimeout=10 "$OFFSITE_HOST" true 2>/dev/null; then
    remote_count="$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$OFFSITE_HOST" \
      "find '$OFFSITE_DIR/daily' -maxdepth 1 -type f -name 'lifeos-*.sql.gz.gpg' 2>/dev/null | wc -l" 2>/dev/null || echo 0)"
    if [ "${remote_count:-0}" -ge 1 ]; then
      remote_latest="$(ssh -o BatchMode=yes "$OFFSITE_HOST" \
        "find '$OFFSITE_DIR/daily' -maxdepth 1 -type f -name 'lifeos-*.sql.gz.gpg' -printf '%f\n' 2>/dev/null | sort | tail -1" 2>/dev/null)"
      ok "异机备份可达，远端已有 $remote_count 份（最新：$remote_latest）"
    else
      bad "异机目标可达，但远端没有任何备份——上传从未成功"
    fi
  else
    bad "无法连接异机备份目标 $OFFSITE_HOST"
  fi
else
  note '未配置 BACKUP_OFFSITE —— 本地加密备份已完成，异机段见 BLOCKED.md'
fi

# ── 9. V1.1 关键配置是否齐备 ───────────────────────────────────
#
# 存在的理由：`.env` 不随代码同步，新增配置项极易静默漏掉。
# V1.1 上线时服务器只有官方 Jev key、没有任何中转配置，导致文档承诺的
# "官方不可用时回退中转"在线上**根本不存在**，且没有任何报错提示。
# 这里把"静默缺失"变成显式检查。
head2 'V1.1 关键配置'
env_has() { grep -qE "^$1=.+" /opt/lifeos/.env 2>/dev/null; }

if env_has 'JEV_OFFICIAL_API_KEY'; then
  ok 'Jev 官方密钥已配置'
  if env_has 'JEV_BASE_URL' && env_has 'JEV_API_KEY'; then
    ok 'Jev 中转已配置（官方失效时可回退）'
  else
    bad '缺少 Jev 中转配置（JEV_BASE_URL / JEV_API_KEY）：官方端点一旦失效将无法回退，自然语言功能整体不可用'
  fi
else
  bad '缺少 JEV_OFFICIAL_API_KEY：自然语言创建与查询不可用（确定性命令仍可用）'
fi

env_has 'DEEPSEEK_API_KEY' && ok 'DeepSeek 已配置' || bad '缺少 DEEPSEEK_API_KEY：无法把一句话解析成草稿'

# 开关状态：关闭是合法运维手段，但要显式提示影响范围
if grep -qE '^WECHAT_INBOUND_ENABLED=0' /opt/lifeos/.env 2>/dev/null; then
  note 'WECHAT_INBOUND_ENABLED=0：微信业务输入已关闭（主动提醒不受影响）'
else
  ok '业务输入开关为开启状态'
fi
if grep -qE '^WECHAT_MODEL_CALLS=0' /opt/lifeos/.env 2>/dev/null; then
  bad 'WECHAT_MODEL_CALLS=0：模型调用被关闭，生产环境不应如此（自然语言路径不可用）'
else
  ok '模型调用开关为开启状态'
fi

# ── 10. 通知渠道与策略 ─────────────────────────────────────────
head2 '通知渠道与策略'
prov="$($PSQL -c "SELECT count(*) FROM notification_jobs;" 2>/dev/null || echo '?')"
ok "notification_jobs 记录数：$prov"

wechat_bound="$($PSQL -c "SELECT count(*) FROM settings WHERE key='wechat.private-channel' AND coalesce(value->>'account','') <> '';" 2>/dev/null || echo '?')"
if [ "$wechat_bound" = '1' ]; then
  ok '微信扫码凭据已绑定（不读取或展示 token）'
elif grep -q '^ILINK_TOKEN=.\+' /opt/lifeos/.env 2>/dev/null; then
  ok 'ILINK_TOKEN 已通过旧式配置设置'
else
  note '微信尚未扫码绑定：Worker 不领取发送任务，超阈值将标 missed（见 BLOCKED.md）'
fi

printf '\n════════════════════════════════════════════════\n'
# ── 11. 密钥不得出现在前端构建产物（PRD FR-01 验收项）──────────
head2 '前端构建产物不含密钥'
DIST=/opt/lifeos/dist/web
if [ -d "$DIST" ]; then
  leaks=0
  checked=0
  while IFS= read -r line; do
    case "$line" in
      MIMO_API_KEY=*|DEEPSEEK_API_KEY=*|SESSION_SECRET=*|ILINK_TOKEN=*|ILINK_CONTEXT_TOKEN=*)
        value="${line#*=}"
        [ -z "$value" ] && continue
        checked=$((checked + 1))
        if grep -rqF "$value" "$DIST" 2>/dev/null; then
          bad "构建产物中出现密钥（来自 ${line%%=*}）"
          leaks=$((leaks + 1))
        fi
        ;;
    esac
  done < <(grep -E '^(MIMO_API_KEY|DEEPSEEK_API_KEY|SESSION_SECRET|ILINK_TOKEN|ILINK_CONTEXT_TOKEN)=' /opt/lifeos/.env 2>/dev/null)
  [ "$leaks" -eq 0 ] && ok "已核查 $checked 个密钥值，均未出现在前端构建产物中"
  if grep -rqE 'postgresql://|DATABASE_URL' "$DIST" 2>/dev/null; then
    bad '构建产物中出现数据库连接串'
  else
    ok '构建产物中无数据库连接串'
  fi
else
  bad "找不到前端构建产物目录 $DIST"
fi

printf '线上自检结果：%d 通过 / %d 失败 / %d 提示\n' "$pass" "$fail" "$warn"
printf '════════════════════════════════════════════════\n'
[ "$fail" -eq 0 ]
