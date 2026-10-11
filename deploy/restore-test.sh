#!/usr/bin/env bash
#
# Life OS 备份恢复演练（验收 A3）
#
# 修复要点（原脚本会把恢复错误报告成通过）：
#   1. 所有恢复 SQL 启用 ON_ERROR_STOP=1 —— 遇到任何 ERROR 立即失败；
#   2. 除表数量外，还校验**必需表齐全**、迁移记录存在、管理员数量符合单管理员不变量；
#   3. 支持加密备份：先用 GPG 私钥解密，再恢复；
#   4. 只操作名称以 _test 结尾的独立测试库，并拒绝与生产库同名；
#   5. 无论成功失败都只清理本次创建的测试库；
#   6. 任一环节失败 → 非零退出。
#
# 用法：
#   sudo -u postgres ./deploy/restore-test.sh [备份文件]
#   （不传参数时自动挑选 daily 目录中最新的备份，加密或未加密均可）
#
set -Eeuo pipefail

TEST_DB="${TEST_DB:-lifeos_restore_test}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/lifeos}"
ENV_FILE="${ENV_FILE:-/opt/lifeos/.env}"

log() { printf '[restore-test] %s\n' "$*"; }
err() { printf '[restore-test][ERROR] %s\n' "$*" >&2; }

CREATED_TEST_DB=0
TMP_PLAIN=""

cleanup() {
  local code=$?
  [ -n "$TMP_PLAIN" ] && rm -f "$TMP_PLAIN"
  if [ "$CREATED_TEST_DB" = "1" ]; then
    psql_admin -q -c "DROP DATABASE IF EXISTS \"$TEST_DB\";" >/dev/null 2>&1 \
      && log "已清理测试库 $TEST_DB" \
      || err "测试库 $TEST_DB 清理失败，请人工检查"
  fi
  exit $code
}
trap cleanup EXIT

# 以 postgres 身份执行管理语句（脚本既可由 postgres 直接跑，也可由 root 跑）
psql_admin() {
  if [ "$(id -un)" = "postgres" ]; then
    psql "$@"
  else
    sudo -n -u postgres psql "$@"
  fi
}

# ── 0. 安全守卫：测试库名必须独立且不与生产库同名 ──────────────
if ! printf '%s' "$TEST_DB" | grep -Eq '^[a-z0-9_]+_test$'; then
  err "拒绝执行：测试库名必须以 _test 结尾且只含小写字母数字下划线，当前为「$TEST_DB」"
  exit 2
fi

PROD_DB=""
if [ -r "$ENV_FILE" ]; then
  prod_url="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)"
  if [ -n "$prod_url" ]; then
    PROD_DB="$(printf '%s' "$prod_url" | sed -E 's#^.*/([^/?]+)(\?.*)?$#\1#')"
  fi
fi
if [ -n "$PROD_DB" ] && [ "$TEST_DB" = "$PROD_DB" ]; then
  err "拒绝执行：测试库名与生产库同名（$PROD_DB）；本脚本绝不对生产库执行 DROP"
  exit 2
fi

# ── 1. 选择备份文件 ────────────────────────────────────────────
BACKUP_FILE="${1:-}"

if [ -z "$BACKUP_FILE" ]; then
  DAILY_DIR="$BACKUP_ROOT/daily"

  # 备份按 A8 要求是 700/600。权限不足时必须明确说"读不到"，
  # 而不是含糊地报"没有备份"——那会把运维引向完全错误的排错方向。
  # 注意：父目录若是 700，子目录连 stat 都做不到，因此两层都要判断。
  if [ -d "$BACKUP_ROOT" ] && { [ ! -r "$BACKUP_ROOT" ] || [ ! -x "$BACKUP_ROOT" ]; }; then
    err "备份根目录不可读：$BACKUP_ROOT（权限 $(stat -c %a "$BACKUP_ROOT" 2>/dev/null || echo '?')，当前身份 $(id -un)）"
    err "请以 root 运行本脚本（脚本内部会以 postgres 执行 psql）：sudo bash $0"
    exit 2
  fi
  if [ -d "$DAILY_DIR" ] && [ ! -r "$DAILY_DIR" ]; then
    err "备份目录不可读：$DAILY_DIR（权限 $(stat -c %a "$DAILY_DIR" 2>/dev/null || echo '?')，当前身份 $(id -un)）"
    err "请以 root 运行本脚本（脚本内部会以 postgres 执行 psql）：sudo bash $0"
    exit 2
  fi

  BACKUP_FILE="$(find "$DAILY_DIR" -maxdepth 1 -type f \
      \( -name 'lifeos-*.sql.gz' -o -name 'lifeos-*.sql.gz.gpg' \) \
      -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2- || true)"
fi

if [ -z "$BACKUP_FILE" ]; then
  err "找不到任何备份文件（搜索目录：$BACKUP_ROOT/daily）"
  exit 2
fi

# 备份目录按 A8 要求是 700、文件 600；以 postgres 身份运行会读不到自己的备份。
# 这里把"不存在"和"无权限"区分开，避免给出误导性的排错方向。
if [ ! -e "$BACKUP_FILE" ]; then
  err "备份文件不存在：$BACKUP_FILE"
  exit 2
fi
if [ ! -r "$BACKUP_FILE" ]; then
  err "无法读取备份文件：$BACKUP_FILE"
  err "该文件为最小权限（600）且目录为 700；请以 root 运行本脚本（脚本内部会以 postgres 执行 psql）："
  err "    sudo bash $0 [备份文件]"
  exit 2
fi
log "使用备份：$BACKUP_FILE"

# ── 2. 需要时解密 ──────────────────────────────────────────────
WORK_FILE="$BACKUP_FILE"
case "$BACKUP_FILE" in
  *.gpg)
    command -v gpg >/dev/null || { err "备份已加密但找不到 gpg"; exit 2; }
    TMP_PLAIN="$(mktemp /tmp/lifeos-restore.XXXXXX.sql.gz)"
    chmod 600 "$TMP_PLAIN"
    log "解密备份…"
    gpg --batch --yes --quiet --output "$TMP_PLAIN" --decrypt "$BACKUP_FILE"
    WORK_FILE="$TMP_PLAIN"
    ;;
esac

# gzip 完整性检查：损坏的备份必须在这里就失败，而不是恢复出一半
gzip -t "$WORK_FILE" || { err "备份 gzip 完整性校验失败：$WORK_FILE"; exit 3; }
log "gzip 完整性校验通过"

# ── 3. 建立独立测试库 ──────────────────────────────────────────
log "重建测试库 $TEST_DB …"
psql_admin -q -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$TEST_DB\";"
psql_admin -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$TEST_DB\";"
CREATED_TEST_DB=1

# ── 4. 恢复（ON_ERROR_STOP=1，遇错立即失败）────────────────────
log "恢复中（ON_ERROR_STOP=1）…"
if ! gunzip -c "$WORK_FILE" | psql_admin -q -v ON_ERROR_STOP=1 -d "$TEST_DB" > /tmp/lifeos-restore.log 2>&1; then
  err "恢复失败，psql 输出如下："
  sed -n '1,40p' /tmp/lifeos-restore.log >&2
  exit 4
fi
log "恢复完成，无 SQL 错误"

# ── 5. 结构与必要数据校验 ──────────────────────────────────────
REQUIRED_TABLES="admin_users audit_logs csv_import_batches events expected_bills
notification_attempts notification_jobs notification_rules payments sessions
settings subscription_price_history subscriptions tasks"

missing=""
for t in $REQUIRED_TABLES; do
  found="$(psql_admin -tA -v ON_ERROR_STOP=1 -d "$TEST_DB" \
    -c "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='$t';")"
  [ "$found" = "1" ] || missing="$missing $t"
done
if [ -n "$missing" ]; then
  err "恢复后缺少必需表：$missing"
  exit 5
fi
log "必需表齐全：$(printf '%s' "$REQUIRED_TABLES" | wc -w) 张"

migration_count="$(psql_admin -tA -v ON_ERROR_STOP=1 -d "$TEST_DB" \
  -c "SELECT count(*) FROM drizzle.__drizzle_migrations;" 2>/dev/null || echo 0)"
if [ "${migration_count:-0}" -lt 1 ]; then
  err "恢复后找不到迁移记录（drizzle.__drizzle_migrations 为空）"
  exit 5
fi
log "迁移记录：$migration_count 条"

# 必要数据：单管理员是产品不变量
admin_count="$(psql_admin -tA -v ON_ERROR_STOP=1 -d "$TEST_DB" -c "SELECT count(*) FROM admin_users;")"
case "$admin_count" in
  1) log "管理员数量校验通过：1" ;;
  0) err "恢复后管理员数量为 0；生产备份应恰好包含 1 个管理员，请核对备份来源"; exit 5 ;;
  *) err "恢复后管理员数量为 $admin_count，违反单管理员不变量"; exit 5 ;;
esac

setting_count="$(psql_admin -tA -v ON_ERROR_STOP=1 -d "$TEST_DB" -c "SELECT count(*) FROM settings;")"
[ "${setting_count:-0}" -ge 1 ] || { err "恢复后 settings 表为空，默认设置缺失"; exit 5; }
log "默认设置校验通过：$setting_count 条"

log "通过：备份可完整恢复，结构、迁移记录与必要数据均已校验"
