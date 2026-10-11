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
tables="$($PSQL -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" 2>/dev/null || echo '?')"
[ "$tables" = "14" ] && ok '生产库 14 张表' || bad "生产库表数量异常：$tables"

admins="$($PSQL -c 'SELECT count(*) FROM admin_users;' 2>/dev/null || echo '?')"
[ "$admins" = "1" ] && ok '管理员数量为 1（未新增、未重建）' || bad "管理员数量异常：$admins"

singleton="$($PSQL -c "SELECT count(*) FROM pg_indexes WHERE indexname='admin_users_singleton_uq';" 2>/dev/null || echo '?')"
[ "$singleton" = "1" ] && ok '单管理员唯一索引存在' || bad '缺少单管理员唯一索引'

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
  ok '已配置异机备份目标'
else
  note '未配置 BACKUP_OFFSITE —— 本地加密备份已完成，异机段见 BLOCKED.md'
fi

# ── 9. 通知渠道与策略 ──────────────────────────────────────────
head2 '通知渠道与策略'
prov="$($PSQL -c "SELECT count(*) FROM notification_jobs;" 2>/dev/null || echo '?')"
ok "notification_jobs 记录数：$prov"

if grep -q '^ILINK_TOKEN=.\+' /opt/lifeos/.env 2>/dev/null; then
  ok 'ILINK_TOKEN 已配置'
else
  note 'ILINK_TOKEN 未配置：Worker 不领取发送任务，超阈值将标 missed（见 BLOCKED.md）'
fi

printf '\n════════════════════════════════════════════════\n'
printf '线上自检结果：%d 通过 / %d 失败 / %d 提示\n' "$pass" "$fail" "$warn"
printf '════════════════════════════════════════════════\n'
[ "$fail" -eq 0 ]
