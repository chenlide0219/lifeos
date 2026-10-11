#!/usr/bin/env bash
#
# 备份恢复演练：把最近一次备份恢复到临时数据库并校验表结构（PRD FR-08 验证项）
#
# 用法：sudo -u postgres ./deploy/restore-test.sh [备份文件]
#
set -euo pipefail

TEST_DB="${TEST_DB:-lifeos_restore_test}"
BACKUP_FILE="${1:-$(ls -1t /var/backups/lifeos/daily/lifeos-*.sql.gz 2>/dev/null | head -1)}"

if [ -z "$BACKUP_FILE" ] || [ ! -f "$BACKUP_FILE" ]; then
  echo "找不到备份文件，请先执行 backup.sh" >&2
  exit 1
fi

echo "[restore-test] 使用备份：$BACKUP_FILE"

psql -q -c "DROP DATABASE IF EXISTS $TEST_DB;"
psql -q -c "CREATE DATABASE $TEST_DB;"

gunzip -c "$BACKUP_FILE" | psql -q -d "$TEST_DB"

echo "[restore-test] 恢复后的表："
psql -d "$TEST_DB" -c "\dt"

COUNT=$(psql -tA -d "$TEST_DB" -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';")
echo "[restore-test] public schema 表数量：$COUNT"

if [ "$COUNT" -lt 10 ]; then
  echo "[restore-test] 失败：表数量异常，恢复可能不完整" >&2
  exit 1
fi

psql -q -c "DROP DATABASE $TEST_DB;"
echo "[restore-test] 通过：备份可完整恢复（临时库已清理）"
