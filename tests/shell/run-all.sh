#!/usr/bin/env bash
#
# shell 级验证入口：逐个执行同目录下的 t-*.sh 测试脚本。
# 任一脚本失败即整体非零退出，不吞错。
#
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fail=0
for script in "$DIR"/t-*.sh; do
  [ -e "$script" ] || continue
  name="$(basename "$script")"
  printf '\n──────── %s ────────\n' "$name"
  if bash "$script"; then
    printf '✅ %s 通过\n' "$name"
  else
    printf '❌ %s 失败\n' "$name"
    fail=$((fail + 1))
  fi
done

if [ "$fail" -gt 0 ]; then
  printf '\nshell 级验证：%d 个脚本失败\n' "$fail" >&2
  exit 1
fi

printf '\nshell 级验证：全部通过\n'
