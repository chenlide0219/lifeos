#!/usr/bin/env bash
#
# Life OS 数据库备份（PRD FR-08）
#
# - 每日备份，保留最近 7 个日备份 + 4 个周备份；
# - 支持 GPG 加密（设置 BACKUP_GPG_RECIPIENT）；
# - 支持异机/对象存储（设置 BACKUP_RCLONE_REMOTE）；
# - 失败即非零退出，便于 cron 邮件告警。
#
set -euo pipefail

BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/lifeos}"
DAILY_KEEP="${DAILY_KEEP:-7}"
WEEKLY_KEEP="${WEEKLY_KEEP:-4}"

# shellcheck disable=SC1091
set -a
. /opt/lifeos/.env
set +a

: "${DATABASE_URL:?缺少 DATABASE_URL}"

STAMP="$(date +%Y-%m-%d)"
mkdir -p "$BACKUP_ROOT/daily" "$BACKUP_ROOT/weekly"

TARGET="$BACKUP_ROOT/daily/lifeos-$STAMP.sql.gz"

# 自定义格式不可用时退回纯 SQL；--clean 让恢复可直接覆盖
pg_dump "$DATABASE_URL" --no-owner --no-privileges --clean --if-exists \
  | gzip -9 > "$TARGET.tmp"
mv "$TARGET.tmp" "$TARGET"

# 可选：GPG 加密（加密后删除明文）
if [ -n "${BACKUP_GPG_RECIPIENT:-}" ]; then
  gpg --batch --yes --trust-model always \
      --recipient "$BACKUP_GPG_RECIPIENT" \
      --output "$TARGET.gpg" --encrypt "$TARGET"
  rm -f "$TARGET"
  TARGET="$TARGET.gpg"
fi

echo "[backup] 已生成 $TARGET ($(du -h "$TARGET" | cut -f1))"

# 每周日额外保留一份周备份
if [ "$(date +%u)" = "7" ]; then
  cp -f "$TARGET" "$BACKUP_ROOT/weekly/"
  echo "[backup] 已归档周备份"
fi

# 轮转：按修改时间倒序删除超期文件（兼容加密与未加密两种后缀）
# 用 find 而非 ls：ls 在通配符无匹配时返回非零，配合 pipefail 会误杀脚本
rotate() {
  local dir="$1" keep="$2"
  find "$dir" -maxdepth 1 -type f \( -name 'lifeos-*.sql.gz' -o -name 'lifeos-*.sql.gz.gpg' \) \
    -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn \
    | tail -n +$((keep + 1)) \
    | cut -d' ' -f2- \
    | xargs -r rm -f
}
rotate "$BACKUP_ROOT/daily" "$DAILY_KEEP"
rotate "$BACKUP_ROOT/weekly" "$WEEKLY_KEEP"

# 可选：推送异机/对象存储（PRD 要求具备异机或对象存储能力）
if [ -n "${BACKUP_RCLONE_REMOTE:-}" ]; then
  rclone copy "$TARGET" "$BACKUP_RCLONE_REMOTE" --quiet
  echo "[backup] 已同步到 $BACKUP_RCLONE_REMOTE"
fi

echo "[backup] 完成：日备份 $(find "$BACKUP_ROOT/daily" -maxdepth 1 -type f | wc -l) 份，周备份 $(find "$BACKUP_ROOT/weekly" -maxdepth 1 -type f | wc -l) 份"
