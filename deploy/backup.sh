#!/usr/bin/env bash
#
# Life OS 加密备份（PRD FR-08，验收 A8）
#
# 行为契约：
#   1. 先在本地生成并**验证**加密产物，成功后才轮转历史，失败绝不删除上一份可恢复副本；
#   2. 强制加密（GPG 公钥加密），加密私钥不得存放在同一目标；
#   3. 目录 700、文件 600，避免同机其他账户可读；
#   4. 可选异机上传（rsync over SSH），且远端**只轮转本项目备份**；
#   5. 任一环节失败：输出可见错误 + 非零退出（cron 可据此告警），不吞错。
#
# 需要的环境（写在 /opt/lifeos/.env，权限 600）：
#   DATABASE_URL              必填
#   BACKUP_GPG_RECIPIENT      必填，加密公钥（邮箱或指纹）
#   BACKUP_OFFSITE            可选，形如 user@host:/path/ ；未设置则跳过异机段
#   BACKUP_SSH_KEY            可选，异机上传使用的私钥（默认 /root/.ssh/lifeos_backup_ed25519）
#   BACKUP_OFFSITE_PORT       可选，SSH 端口
#
set -Eeuo pipefail

BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/lifeos}"
DAILY_KEEP="${DAILY_KEEP:-7}"
WEEKLY_KEEP="${WEEKLY_KEEP:-4}"
# 与常量表达式唯一索引无关；这里只是备份文件名的前缀
PREFIX="lifeos"

log() { printf '[backup] %s\n' "$*"; }
err() { printf '[backup][ERROR] %s\n' "$*" >&2; }

# 任何未捕获失败都必须以非零码退出，且明确说明未完成的阶段
trap 'code=$?; err "脚本在第 $LINENO 行失败（退出码 $code）：本次备份未完成；已保留上一份可恢复副本，未做任何删除"; exit $code' ERR

# ── 0. 读取配置 ────────────────────────────────────────────────
ENV_FILE="${ENV_FILE:-/opt/lifeos/.env}"
[ -r "$ENV_FILE" ] || { err "无法读取 $ENV_FILE（需要 root 权限）"; exit 2; }

# shellcheck disable=SC1090
set -a
. "$ENV_FILE"
set +a

: "${DATABASE_URL:?缺少 DATABASE_URL}"
: "${BACKUP_GPG_RECIPIENT:?缺少 BACKUP_GPG_RECIPIENT：备份必须加密，请先配置加密公钥}"

command -v pg_dump >/dev/null || { err "找不到 pg_dump"; exit 2; }
command -v gpg >/dev/null || { err "找不到 gpg"; exit 2; }

# ── 1. 准备目录（最小权限）─────────────────────────────────────
install -d -m 700 "$BACKUP_ROOT" "$BACKUP_ROOT/daily" "$BACKUP_ROOT/weekly"

# 同一天手动重跑也必须产生新文件：固定日期名配合 rsync --ignore-existing
# 会保留远端旧包并让大小校验失败，还会覆盖本地当天上一次的备份。
STAMP="$(date +%Y-%m-%dT%H%M%S)-$$"
BASENAME="$PREFIX-$STAMP.sql.gz.gpg"
PLAIN="$BACKUP_ROOT/.$BASENAME.plain.$$"
DAILY_TARGET="$BACKUP_ROOT/daily/$BASENAME"

cleanup_tmp() { rm -f "$PLAIN" "$PLAIN.gz"; }
trap 'cleanup_tmp' EXIT

# ── 2. 导出并加密到临时文件 ────────────────────────────────────
log "导出数据库…"
umask 077
pg_dump "$DATABASE_URL" --no-owner --no-privileges --clean --if-exists \
  | gzip -9 > "$PLAIN.gz"

log "使用受信公钥加密…"
gpg --batch --yes --trust-model always \
    --recipient "$BACKUP_GPG_RECIPIENT" \
    --output "$PLAIN" --encrypt "$PLAIN.gz"

# 验证产物确实是可用的加密包，而不是空文件或损坏文件
gpg --batch --list-packets "$PLAIN" >/dev/null 2>&1 || { err "加密产物校验失败"; exit 3; }
[ -s "$PLAIN" ] || { err "加密产物为空"; exit 3; }

# ── 3. 落盘（成功后才有权轮转历史）─────────────────────────────
install -m 600 "$PLAIN" "$DAILY_TARGET"
log "已生成 $DAILY_TARGET ($(du -h "$DAILY_TARGET" | cut -f1))"

if [ "$(date +%u)" = "7" ]; then
  install -m 600 "$PLAIN" "$BACKUP_ROOT/weekly/$BASENAME"
  log "已归档周备份"
fi

# ── 4. 本地轮转：仅在新备份已就绪后执行 ────────────────────────
rotate_local() {
  local dir="$1" keep="$2" total
  total=$(find "$dir" -maxdepth 1 -type f -name "$PREFIX-*.sql.gz.gpg" | wc -l)
  # 安全底线：无论配置如何，至少保留 2 份（当前这份 + 上一份）
  local effective=$(( keep < 2 ? 2 : keep ))
  [ "$total" -le "$effective" ] && return 0

  find "$dir" -maxdepth 1 -type f -name "$PREFIX-*.sql.gz.gpg" -printf '%T@ %p\n' \
    | sort -rn \
    | tail -n +$((effective + 1)) \
    | cut -d' ' -f2- \
    | xargs -r rm -f
}
rotate_local "$BACKUP_ROOT/daily" "$DAILY_KEEP"
rotate_local "$BACKUP_ROOT/weekly" "$WEEKLY_KEEP"
log "本地保留：日 $(find "$BACKUP_ROOT/daily" -maxdepth 1 -type f | wc -l) 份，周 $(find "$BACKUP_ROOT/weekly" -maxdepth 1 -type f | wc -l) 份"

# ── 5. 异机上传（可选）─────────────────────────────────────────
if [ -n "${BACKUP_OFFSITE:-}" ]; then
  OFFSITE_HOST="${BACKUP_OFFSITE%%:*}"
  OFFSITE_DIR="${BACKUP_OFFSITE#*:}"
  SSH_KEY="${BACKUP_SSH_KEY:-/root/.ssh/lifeos_backup_ed25519}"
  SSH_PORT_ARG=()
  [ -n "${BACKUP_OFFSITE_PORT:-}" ] && SSH_PORT_ARG=(-p "$BACKUP_OFFSITE_PORT")

  # -e 里带上密钥与端口，使 rsync 的远端命令同样使用该密钥
  RSYNC_SSH="ssh -i $SSH_KEY -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 -o ConnectionAttempts=1 -o ServerAliveInterval=5 -o ServerAliveCountMax=1 ${SSH_PORT_ARG[*]:-}"

  log "异机上传到 $OFFSITE_HOST:$OFFSITE_DIR …"
  # --ignore-existing：已存在的同名文件不覆盖，避免半截文件覆盖完好副本
  rsync -a --ignore-existing --timeout=30 \
        -e "$RSYNC_SSH" \
        "$DAILY_TARGET" "$OFFSITE_HOST:$OFFSITE_DIR/daily/"

  # 校验远端确实存在且大小一致，否则视为上传失败
  remote_size=$(ssh -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 -o ConnectionAttempts=1 -o ServerAliveInterval=5 -o ServerAliveCountMax=1 "${SSH_PORT_ARG[@]}" \
      "$OFFSITE_HOST" "stat -c %s '$OFFSITE_DIR/daily/$BASENAME'" 2>/dev/null || echo missing)
  if [ "$remote_size" = "missing" ]; then
    err "远端未找到上传产物 $BASENAME，上传判定失败"
    exit 4
  fi
  local_size=$(stat -c %s "$DAILY_TARGET")
  [ "$remote_size" = "$local_size" ] || { err "远端大小 $remote_size 与本地 $local_size 不一致，上传判定失败"; exit 4; }
  log "异机上传已校验（大小一致：$local_size 字节）"

  # 远端轮转：只匹配本项目备份文件名，绝不触碰目标目录中的其他文件
  ssh -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 -o ConnectionAttempts=1 -o ServerAliveInterval=5 -o ServerAliveCountMax=1 "${SSH_PORT_ARG[@]}" "$OFFSITE_HOST" \
    "install -d -m 700 '$OFFSITE_DIR/daily' '$OFFSITE_DIR/weekly' 2>/dev/null;
     find '$OFFSITE_DIR/daily' -maxdepth 1 -type f -name '$PREFIX-*.sql.gz.gpg' -printf '%T@ %p\n' \
       | sort -rn | tail -n +$((DAILY_KEEP + 1)) | cut -d' ' -f2- | xargs -r rm -f;
     find '$OFFSITE_DIR/weekly' -maxdepth 1 -type f -name '$PREFIX-*.sql.gz.gpg' -printf '%T@ %p\n' \
       | sort -rn | tail -n +$((WEEKLY_KEEP + 1)) | cut -d' ' -f2- | xargs -r rm -f"
  log "远端轮转完成（仅限 $PREFIX-*.sql.gz.gpg）"
else
  log "未配置 BACKUP_OFFSITE，跳过异机上传（本地加密备份已完成）"
fi

log "完成"
