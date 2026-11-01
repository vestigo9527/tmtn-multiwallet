#!/usr/bin/env bash
# 钱包备注名（label）：wallets/labels.env 里一行一个 WALLET_LABEL_N=备注
# 由 scripts/add-wallet.sh 与 scripts/wallets.sh 共同 source；默认值「钱包 N」
#
#   source scripts/labels.sh; label_of 3        # 取钱包 3 的备注
#   source scripts/labels.sh; label_set 3 主号   # 写钱包 3 的备注
set -uo pipefail

LABELS_FILE="${LABELS_FILE:-wallets/labels.env}"

label_of() {   # N → 备注（没有就 "钱包 N"）
  local n="$1" v=""
  if [ -f "$LABELS_FILE" ]; then
    v="$(grep -E "^WALLET_LABEL_${n}=" "$LABELS_FILE" 2>/dev/null | tail -1 | cut -d= -f2-)" || v=""
  fi
  [ -z "$v" ] && v="钱包 $n"
  printf '%s\n' "$v"
}

label_set() {  # N 备注...
  local n="$1"; shift
  local v="$*"
  [ -z "$v" ] && { echo "✗ 备注不能是空的" >&2; return 1; }
  mkdir -p "$(dirname "$LABELS_FILE")"; touch "$LABELS_FILE"
  if grep -qE "^WALLET_LABEL_${n}=" "$LABELS_FILE" 2>/dev/null; then
    LABEL_V="$v" LABEL_N="$n" node -e '
      const fs=require("fs");const f=process.argv[1];const n=process.env.LABEL_N;
      const re=new RegExp("^WALLET_LABEL_"+n+"=");
      const out=fs.readFileSync(f,"utf8").split("\n").map((l)=>re.test(l)?"WALLET_LABEL_"+n+"="+process.env.LABEL_V:l).join("\n");
      fs.writeFileSync(f,out);' "$LABELS_FILE"
  else
    printf 'WALLET_LABEL_%s=%s\n' "$n" "$v" >> "$LABELS_FILE"
  fi
  printf '%s\n' "$v"
}

labels_all() {  # 打印全部：N<TAB>备注
  local n max=0 d
  for d in wallets/wallet*/; do
    [ -d "$d" ] || continue
    n="${d#wallets/wallet}"; n="${n%/}"
    case "$n" in ''|*[!0-9]*) continue ;; esac
    [ "$n" -gt "$max" ] && max="$n"
  done
  [ "$max" -lt 1 ] && max=1
  for n in $(seq 1 "$max"); do printf '%s\t%s\n' "$n" "$(label_of "$n")"; done
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  case "${1:-list}" in
    list) labels_all ;;
    get)  label_of "${2:?用法: labels.sh get N}" ;;
    set)  shift; label_set "$@" ;;
    *) echo "用法：scripts/labels.sh list | get N | set N 备注" ;;
  esac
fi
