#!/usr/bin/env bash
#
# 一次性置备备份所需的密钥（在 lisahost 上以 root 运行）
#
# 生成两样东西：
#   1. GPG 密钥对：公钥留在本机用于加密，私钥用于恢复时解密。
#      私钥**绝不能**放到备份目标上，否则加密形同虚设。
#   2. SSH 密钥对：用于把加密备份推到异机目标。
#
# 本脚本**不会**修改任何远端主机。授权需要你（或经你确认后）在目标主机执行
# 脚本最后打印的那条命令。
#
set -Eeuo pipefail

GPG_NAME="${GPG_NAME:-Life OS Backup}"
GPG_EMAIL="${GPG_EMAIL:-lifeos-backup@localhost}"
SSH_KEY="${SSH_KEY:-/root/.ssh/lifeos_backup_ed25519}"

log() { printf '[setup] %s\n' "$*"; }

if [ "$(id -u)" != "0" ]; then
  echo "请以 root 运行（密钥需要写入 /root）" >&2
  exit 2
fi

# ── 1. GPG 密钥对 ──────────────────────────────────────────────
if gpg --list-secret-keys "$GPG_EMAIL" >/dev/null 2>&1; then
  log "GPG 密钥已存在，跳过生成"
else
  log "生成无口令 GPG 密钥对（无人值守解密所需；请务必做好私钥托管）…"
  gpg --batch --yes --quiet --gen-key <<EOF
%no-protection
Key-Type: eddsa
Key-Curve: ed25519
Key-Usage: sign
Subkey-Type: ecdh
Subkey-Curve: cv25519
Subkey-Usage: encrypt
Name-Real: $GPG_NAME
Name-Email: $GPG_EMAIL
Expire-Date: 0
%commit
EOF
fi

FPR="$(gpg --list-secret-keys --with-colons "$GPG_EMAIL" | awk -F: '/^fpr:/ {print $10; exit}')"
log "GPG 指纹：$FPR"
log "请把下面这行写入 /opt/lifeos/.env（用于加密）："
echo "    BACKUP_GPG_RECIPIENT=$FPR"

EXPORT_DIR="/root/lifeos-backup-keys"
install -d -m 700 "$EXPORT_DIR"
if [ ! -f "$EXPORT_DIR/lifeos-backup-private.asc" ]; then
  gpg --batch --yes --armor --output "$EXPORT_DIR/lifeos-backup-private.asc" --export-secret-keys "$FPR"
  chmod 600 "$EXPORT_DIR/lifeos-backup-private.asc"
  log "私钥已导出到 $EXPORT_DIR/lifeos-backup-private.asc"
fi
gpg --batch --yes --armor --output "$EXPORT_DIR/lifeos-backup-public.asc" --export "$FPR"
chmod 600 "$EXPORT_DIR/lifeos-backup-public.asc"

# ── 2. 异机 SSH 密钥 ───────────────────────────────────────────
if [ ! -f "$SSH_KEY" ]; then
  log "生成异机备份专用 SSH 密钥…"
  install -d -m 700 "$(dirname "$SSH_KEY")"
  ssh-keygen -t ed25519 -N '' -C "lifeos-backup@$(hostname)" -f "$SSH_KEY" >/dev/null
  chmod 600 "$SSH_KEY"
  chmod 644 "$SSH_KEY.pub"
else
  log "SSH 密钥已存在：$SSH_KEY"
fi

PUB="$(cat "$SSH_KEY.pub")"

cat <<EOF

════════════════════════════════════════════════════════════════════
下一步（需要你确认后执行，本脚本不会自行修改远端）

1) 把加密公钥配置到 /opt/lifeos/.env：
     BACKUP_GPG_RECIPIENT=$FPR

2) 在**备份目标主机**上授权本机的备份公钥（最小权限：禁转发、禁 pty）：
     公钥内容：
       $PUB
     在目标主机上执行：
       install -d -m 700 /var/backups/lifeos/daily /var/backups/lifeos/weekly
       echo 'no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty $PUB' >> /root/.ssh/authorized_keys
       chmod 600 /root/.ssh/authorized_keys

3) 配置异机目标到 /opt/lifeos/.env：
     BACKUP_OFFSITE=root@<目标主机>:/var/backups/lifeos
     # 如非默认端口再加：BACKUP_OFFSITE_PORT=22

4) 私钥托管（重要）：
     $EXPORT_DIR/lifeos-backup-private.asc
     请复制到你自己的密码管理器或离线介质保存，**不要**放在备份目标主机上。
     该私钥丢失 = 异机备份永久无法解密。

5) 验证：sudo /opt/lifeos/deploy/backup.sh
════════════════════════════════════════════════════════════════════
EOF
