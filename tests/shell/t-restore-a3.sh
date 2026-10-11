#!/usr/bin/env bash
#
# A3 回归：恢复演练必须对错误 SQL 失败，且支持加密备份取回恢复。
#
# 原缺陷：psql 未启用 ON_ERROR_STOP，脚本只看表数量，导致恢复出错仍报"通过"。
#
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/deploy/restore-test.sh"
TEST_DB_NAME="lifeos_a3_restore_test"

WORK="$(mktemp -d /tmp/lifeos-a3-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

pass_count=0
fail_count=0

ok()   { printf '  ✅ %s\n' "$*"; pass_count=$((pass_count + 1)); }
bad()  { printf '  ❌ %s\n' "$*" >&2; fail_count=$((fail_count + 1)); }

echo "→ 取测试库连接串"
TEST_URL="$(grep '^DATABASE_URL=' /opt/lifeos/.env 2>/dev/null | cut -d= -f2- | sed 's#/lifeos$#/lifeos_test#')"
if [ -z "$TEST_URL" ]; then
  echo "无法取得测试库连接串（需要读取 /opt/lifeos/.env 的权限）" >&2
  exit 1
fi

echo "→ 准备一份含 1 个管理员的合法备份（不接触生产库）"
psql "$TEST_URL" -q -v ON_ERROR_STOP=1 <<'SQL'
TRUNCATE admin_users, sessions, audit_logs RESTART IDENTITY CASCADE;
INSERT INTO admin_users (username, password_hash) VALUES ('restore-probe', 'x');
INSERT INTO settings (key, value) VALUES ('restore.probe', '{"v":1}'::jsonb)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
SQL
pg_dump "$TEST_URL" --no-owner --no-privileges --clean --if-exists | gzip -9 > "$WORK/valid.sql.gz"

echo '→ 构造一份：14 张表都建好、但最后调用不存在函数的错误 SQL'
{
  psql "$TEST_URL" -tA -v ON_ERROR_STOP=1 -c \
    "SELECT string_agg(format('CREATE TABLE probe_%s (id int);', g), E'\n')
     FROM generate_series(1, 14) g;"
  echo "SELECT lifeos_function_that_does_not_exist();"
} > "$WORK/broken.sql"
gzip -9 -c "$WORK/broken.sql" > "$WORK/broken.sql.gz"

# ── 1. 安全守卫：非 _test 结尾的库名必须被拒绝 ────────────────
echo "→ 用例 1：库名守卫"
set +e
out="$(TEST_DB=lifeos bash "$SCRIPT" "$WORK/valid.sql.gz" 2>&1)"; code=$?
set -e
if [ "$code" -ne 0 ] && printf '%s' "$out" | grep -q '必须以 _test 结尾'; then
  ok "拒绝非测试库名（退出码 $code）"
else
  bad "库名守卫失效（退出码 $code）：$out"
fi

# ── 2. 故意错误的 SQL 恢复必须失败 ────────────────────────────
echo "→ 用例 2：错误 SQL 必须失败（原缺陷会报成功）"
set +e
out="$(TEST_DB="$TEST_DB_NAME" bash "$SCRIPT" "$WORK/broken.sql.gz" 2>&1)"; code=$?
set -e
if [ "$code" -eq 0 ]; then
  bad "恢复了错误 SQL 却返回成功 —— 这正是原缺陷"
else
  ok "错误 SQL 导致非零退出（退出码 $code）"
fi
if printf '%s' "$out" | grep -q '通过：备份可完整恢复'; then
  bad '输出中仍打印了「通过」结论，属假通过'
else
  ok '未打印「通过」结论'
fi

# ── 3. 合法备份（明文 gz）必须通过 ────────────────────────────
echo "→ 用例 3：合法备份恢复应通过"
set +e
out="$(TEST_DB="$TEST_DB_NAME" bash "$SCRIPT" "$WORK/valid.sql.gz" 2>&1)"; code=$?
set -e
if [ "$code" -eq 0 ] && printf '%s' "$out" | grep -q '通过：备份可完整恢复'; then
  ok "合法备份恢复通过并给出结论"
else
  bad "合法备份恢复失败（退出码 $code）：$out"
fi

# ── 4. 加密备份取回 → 解密 → 恢复 ─────────────────────────────
echo "→ 用例 4：加密备份的取回与恢复"
FPR="$(gpg --list-secret-keys --with-colons 2>/dev/null | awk -F: '/^fpr:/ {print $10; exit}')"
if [ -z "$FPR" ]; then
  bad "找不到 GPG 私钥，无法验证加密备份恢复"
else
  gpg --batch --yes --trust-model always --recipient "$FPR" \
      --output "$WORK/valid.sql.gz.gpg" --encrypt "$WORK/valid.sql.gz"
  set +e
  out="$(TEST_DB="$TEST_DB_NAME" bash "$SCRIPT" "$WORK/valid.sql.gz.gpg" 2>&1)"; code=$?
  set -e
  if [ "$code" -eq 0 ] && printf '%s' "$out" | grep -q '通过：备份可完整恢复'; then
    ok "加密备份可解密并完整恢复"
  else
    bad "加密备份恢复失败（退出码 $code）：$out"
  fi
fi

# ── 5. 最小权限备份：非 root 运行必须给出明确的权限提示而不是"找不到" ──
echo "→ 用例 5：以 postgres 身份读取 700/600 备份必须明确报权限问题"
if [ "$(id -u)" = "0" ]; then
  SECURE_DIR="$WORK/secure"
  # 让 postgres 能进到 $WORK，使报错精确指向 $SECURE_DIR 本身
  chmod 755 "$WORK"
  mkdir -p "$SECURE_DIR/daily" "$SECURE_DIR/weekly"
  install -m 600 "$WORK/valid.sql.gz" "$SECURE_DIR/daily/lifeos-2026-01-01.sql.gz"
  chmod 700 "$SECURE_DIR" "$SECURE_DIR/daily" "$SECURE_DIR/weekly"
  set +e
  # 必须用 env 显式传递：sudo 默认 env_reset 会剥离 BACKUP_ROOT，否则测的不是预期场景
  out="$(sudo -u postgres env BACKUP_ROOT="$SECURE_DIR" bash "$SCRIPT" 2>&1)"; code=$?
  set -e
  if [ "$code" -ne 0 ] && printf '%s' "$out" | grep -q '不可读\|请以 root'; then
    ok "正确报告权限问题并给出 root 运行提示"
  else
    bad "权限场景报错信息不明确（退出码 $code）：$out"
  fi
else
  echo '  （跳过：非 root，无法构造该场景）'
fi

# ── 6. 测试库必须被清理，不残留 ───────────────────────────────
echo "→ 用例 6：测试库清理"
left="$(sudo -n -u postgres psql -tA -c \
  "SELECT count(*) FROM pg_database WHERE datname='$TEST_DB_NAME';" 2>/dev/null || echo '?')"
if [ "$left" = "0" ]; then
  ok "测试库已清理"
else
  bad "测试库残留（count=$left）"
fi

echo
printf 'A3 结果：%d 通过 / %d 失败\n' "$pass_count" "$fail_count"
[ "$fail_count" -eq 0 ]
