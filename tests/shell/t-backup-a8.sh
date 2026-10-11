#!/usr/bin/env bash
#
# A8 回归：加密备份、最小权限、轮转，以及"失败不得删除最后可恢复副本"。
#
# 全部在临时 BACKUP_ROOT 与临时 ENV_FILE 上进行，不触碰生产备份目录。
#
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/deploy/backup.sh"

WORK="$(mktemp -d /tmp/lifeos-a8-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

pass_count=0
fail_count=0
ok()  { printf '  ✅ %s\n' "$*"; pass_count=$((pass_count + 1)); }
bad() { printf '  ❌ %s\n' "$*" >&2; fail_count=$((fail_count + 1)); }

TEST_URL="$(grep '^DATABASE_URL=' /opt/lifeos/.env 2>/dev/null | cut -d= -f2- | sed 's#/lifeos$#/lifeos_test#')"
[ -n "$TEST_URL" ] || { echo "无法取得测试库连接串" >&2; exit 1; }

FPR="$(gpg --list-secret-keys --with-colons 2>/dev/null | awk -F: '/^fpr:/ {print $10; exit}')"
[ -n "$FPR" ] || { echo "找不到 GPG 密钥" >&2; exit 1; }

new_root() { local d="$WORK/$1"; mkdir -p "$d"; printf '%s' "$d"; }
env_file() { # $1=path  $2=recipient(可空)  $3=offsite(可空)
  {
    echo "DATABASE_URL=$TEST_URL"
    [ -n "${2:-}" ] && echo "BACKUP_GPG_RECIPIENT=$2"
    [ -n "${3:-}" ] && echo "BACKUP_OFFSITE=$3"
    echo "DAILY_KEEP=7"
    echo "WEEKLY_KEEP=4"
  } > "$1"
  chmod 600 "$1"
}

echo '→ 用例 1：未配置加密公钥时必须失败（备份强制加密）'
ROOT1="$(new_root root1)"; ENV1="$WORK/env1"
env_file "$ENV1" "" ""
set +e
out="$(BACKUP_ROOT="$ROOT1" ENV_FILE="$ENV1" bash "$SCRIPT" 2>&1)"; code=$?
set -e
if [ "$code" -ne 0 ] && printf '%s' "$out" | grep -q 'BACKUP_GPG_RECIPIENT'; then
  ok "未加密即拒绝执行（退出码 $code）"
else
  bad "未配置加密公钥却继续执行（退出码 $code）：$out"
fi

echo '→ 用例 2：正常备份产出加密文件，目录 700 / 文件 600'
ROOT2="$(new_root root2)"; ENV2="$WORK/env2"
env_file "$ENV2" "$FPR" ""
set +e
out="$(BACKUP_ROOT="$ROOT2" ENV_FILE="$ENV2" bash "$SCRIPT" 2>&1)"; code=$?
set -e
if [ "$code" -eq 0 ]; then ok "备份成功"; else bad "备份失败（$code）：$out"; fi

ART="$(find "$ROOT2/daily" -name '*.gpg' -type f | head -1)"
if [ -n "$ART" ]; then
  ok "产出加密备份 $(basename "$ART")"
  perm="$(stat -c %a "$ART")"
  [ "$perm" = "600" ] && ok "文件权限 600" || bad "文件权限应为 600，实际 $perm"
  dperm="$(stat -c %a "$ROOT2/daily")"
  [ "$dperm" = "700" ] && ok "目录权限 700" || bad "目录权限应为 700，实际 $dperm"

  # 产物必须真的是加密的（不带私钥无法得到明文 SQL）
  if gpg --batch --quiet --decrypt "$ART" 2>/dev/null | gzip -t 2>/dev/null; then
    ok "加密产物可用私钥解密并解压，内容可恢复"
  else
    bad "加密产物无法解密/解压"
  fi

  # 产物是 .sql.gz.gpg：解密后仍是 gzip，需再解压才能看到明文 SQL
  if gpg --batch --quiet --decrypt "$ART" 2>/dev/null | gunzip 2>/dev/null | grep -q 'CREATE TABLE'; then
    ok "解密后可见建表语句，确认是真实数据库备份"
  else
    bad "解密内容不含建表语句"
  fi
else
  bad "未找到任何加密备份产物"
fi

echo '→ 用例 3：轮转保留 DAILY_KEEP 份，且绝不删除最新一份'
ROOT3="$(new_root root3)"; ENV3="$WORK/env3"
env_file "$ENV3" "$FPR" ""
mkdir -p "$ROOT3/daily" "$ROOT3/weekly"
for i in $(seq 1 10); do
  f="$ROOT3/daily/lifeos-2026-01-$(printf '%02d' "$i").sql.gz.gpg"
  echo "old" > "$f"
  touch -d "2026-01-$i 03:30" "$f"
done
set +e
out="$(BACKUP_ROOT="$ROOT3" ENV_FILE="$ENV3" bash "$SCRIPT" 2>&1)"; code=$?
set -e
[ "$code" -eq 0 ] || bad "轮转用例执行失败（$code）：$out"
kept="$(find "$ROOT3/daily" -name 'lifeos-*.sql.gz.gpg' -type f | wc -l)"
[ "$kept" -eq 7 ] && ok "轮转后保留 7 份（DAILY_KEEP）" || bad "轮转后应为 7 份，实际 $kept"
newest="$(find "$ROOT3/daily" -name 'lifeos-*.sql.gz.gpg' -printf '%T@ %p\n' | sort -rn | head -1 | cut -d' ' -f2-)"
if gpg --batch --quiet --decrypt "$newest" 2>/dev/null | gzip -t 2>/dev/null; then
  ok "最新一份是本次新生成的可用备份"
else
  bad "最新一份不是本次生成的可用备份"
fi

echo '→ 用例 4：加密失败必须非零退出，且不删除上一份可恢复副本'
ROOT4="$(new_root root4)"; ENV4="$WORK/env4"
mkdir -p "$ROOT4/daily" "$ROOT4/weekly"
PRECIOUS="$ROOT4/daily/lifeos-2026-01-01.sql.gz.gpg"
echo "precious-last-recoverable-copy" > "$PRECIOUS"
touch -d "2026-01-01 03:30" "$PRECIOUS"
env_file "$ENV4" "nonexistent-key@invalid.invalid" ""
set +e
out="$(BACKUP_ROOT="$ROOT4" ENV_FILE="$ENV4" bash "$SCRIPT" 2>&1)"; code=$?
set -e
if [ "$code" -ne 0 ]; then ok "加密失败导致非零退出（$code）"; else bad "加密失败却返回 0"; fi
if [ -f "$PRECIOUS" ] && grep -q 'precious-last-recoverable-copy' "$PRECIOUS"; then
  ok "上一份可恢复副本完好保留"
else
  bad "失败时删除了上一份可恢复副本 —— 违反安全底线"
fi

echo '→ 用例 5：异机不可达必须非零退出，且本地备份仍保留'
ROOT5="$(new_root root5)"; ENV5="$WORK/env5"
env_file "$ENV5" "$FPR" "root@203.0.113.1:/var/backups/lifeos"
set +e
out="$(BACKUP_ROOT="$ROOT5" ENV_FILE="$ENV5" BACKUP_SSH_KEY=/nonexistent/key bash "$SCRIPT" 2>&1)"; code=$?
set -e
if [ "$code" -ne 0 ]; then ok "异机上传失败导致非零退出（$code）"; else bad "异机不可达却返回 0"; fi
local_kept="$(find "$ROOT5/daily" -name 'lifeos-*.sql.gz.gpg' -type f | wc -l)"
[ "$local_kept" -ge 1 ] && ok "本地加密备份已保留（$local_kept 份）" || bad "本地备份丢失"

echo
printf 'A8 结果：%d 通过 / %d 失败\n' "$pass_count" "$fail_count"
[ "$fail_count" -eq 0 ]
