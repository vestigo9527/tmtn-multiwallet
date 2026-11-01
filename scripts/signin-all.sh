#!/usr/bin/env bash
# signin-all.sh [N ...] —— 批量给「未登录」的钱包出码
#
#   bash scripts/signin-all.sh          # 检查全部钱包，只给未登录的出码
#   bash scripts/signin-all.sh 3 5      # 只处理钱包 3 和 5
#
# 取码/等扫码/写结果全部复用 scripts/qr-session.sh：
#   一个钱包 = 一个独立后台进程，signout → 取码 → 常驻 verify，
#   结果写 wallets/signin/N.json（码）与 N.result（结果）。
# 本脚本只负责：判断谁没登录、并行拉起进程、把码汇总打印出来。
#
# 已登录的钱包一律跳过，绝不对它 signout。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/labels.sh"

UIDIR="$ROOT/wallets/signin"
mkdir -p "$UIDIR"
mkdir -p "$ROOT/data"

max_slot() {
  local m=1 n f
  for f in "$ROOT"/wallets/wallet*; do
    [ -d "$f" ] || continue
    n="$(basename "$f" | sed -E 's/^wallet([0-9]+)$/\1/')"
    [ -n "$n" ] && [ "$n" -gt "$m" ] && m="$n"
  done
  echo "$m"
}

status_of() {
  local n="$1" out
  if [ "$n" = "1" ]; then out="$(baw --json wallet status 2>/dev/null)"
  else out="$(docker exec "tmtn-wallet$n" baw --json wallet status 2>/dev/null)"; fi
  printf '%s' "$out" | grep -q '"CONNECTED"'
}

jget() { node -e 'try{const j=require(process.argv[1]);const v=j[process.argv[2]];console.log(v===undefined?"":v)}catch{console.log("")}' "$1" "$2" 2>/dev/null; }

if [ "$#" -gt 0 ]; then SLOTS="$*"; else SLOTS="$(seq 1 "$(max_slot)")"; fi

todo=""
echo "── 检查 $(echo "$SLOTS" | wc -w | tr -d ' ') 个钱包的登录状态"
for n in $SLOTS; do
  if status_of "$n"; then
    printf '  ✓ 钱包 %s（%s）已登录，跳过\n' "$n" "$(label_of "$n")"
  else
    printf '  · 钱包 %s（%s）未登录，准备出码\n' "$n" "$(label_of "$n")"
    todo="$todo $n"
  fi
done

if [ -z "$todo" ]; then
  echo "✓ 全部已登录，没有需要处理的钱包"
  exit 0
fi

echo "── 拉起取码进程（每个钱包一个独立进程，日志 data/qr-N.log）"
for n in $todo; do
  nohup bash "$ROOT/scripts/qr-session.sh" "$n" >>"$ROOT/data/qr-$n.log" 2>&1 &
  printf '  → 钱包 %s 进程 pid %s\n' "$n" "$!"
done

echo "── 最多等 40 秒拿码"
deadline=$(( $(date +%s) + 40 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  left=0
  for n in $todo; do
    f="$UIDIR/$n.json"
    if [ -f "$f" ]; then
      u="$(jget "$f" urlForWeb)"
      [ -n "$u" ] && continue
    fi
    left=1
  done
  [ "$left" = 0 ] && break
  sleep 1
done

echo
echo "════ 扫码清单 ════"
for n in $todo; do
  f="$UIDIR/$n.json"
  u="$(jget "$f" urlForWeb)"; c="$(jget "$f" pairingCode)"; e="$(jget "$f" expireAt)"
  lab="$(label_of "$n")"
  if [ -z "$u" ]; then
    printf '钱包 %-2s %-14s ✗ 没拿到码，看 data/qr-%s.log\n' "$n" "$lab" "$n"
    continue
  fi
  exp="$(node -e 'const t=Number(process.argv[1]);console.log(t?new Date(t).toLocaleTimeString("zh-CN",{hour12:false}):"-")' "$e" 2>/dev/null)"
  printf '钱包 %-2s %-14s 配对码 %-8s 有效到 %s\n' "$n" "$lab" "$c" "$exp"
  printf '         %s\n' "$u"
  printf '         本地二维码页： http://127.0.0.1:8899/qr?slot=%s\n' "$n"
done
echo "════════════════"
echo "提示：verify 进程会在后台一直等扫码，扫码成功后 wallets/signin/N.result 变 SUCCESS，"
echo "      管理台 http://127.0.0.1:8899 那张卡片自动变「已登录」。"
echo "      码 5 分钟有效；过期后重跑本脚本，或直接在管理台点「换一张二维码」。"
