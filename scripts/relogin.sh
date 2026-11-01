#!/usr/bin/env bash
# relogin.sh —— 单个钱包重新登录（命令行兜底版，和管理台走同一套流程）
#
#   bash scripts/relogin.sh 1            钱包 1（本机 baw）
#   bash scripts/relogin.sh 3            钱包 3（容器 tmtn-wallet3）
#
# 流程：查会话 → 已登录就直接退出 → signout 清残留 → 停 3 秒 → signin 取码
#       → 前台挂 verify 等扫码 → 扫码成功后打印地址
#
# 纪律（血的教训）：
#   1. 取到码必须立刻挂 verify，只出码不 verify 等于白扫；
#   2. 同一台设备同一时间只能有一张活码，别并行开两轮；
#   3. 千万别 kill 正在等扫码的 verify —— 币安侧流程会悬空，之后新码一路
#      AUTH_REJECTED，要再 signout 一次才能救回来。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

N="${1:-}"
if [[ -z "$N" || ! "$N" =~ ^[0-9]+$ ]]; then
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi

# 钱包 N 的 baw 执行前缀
bawrun() {
  if [[ "$N" == "1" ]]; then
    baw "$@"
  else
    docker exec "tmtn-wallet${N}" baw "$@"
  fi
}

label="$N"
[[ -f "$ROOT/scripts/labels.sh" ]] && label="$(bash "$ROOT/scripts/labels.sh" get "$N" 2>/dev/null || echo "$N")"

echo "── 钱包 ${N}（${label}）"

# ① 会话可用就不动它
st="$(bawrun --json wallet status 2>/dev/null || true)"
if grep -q '"status"[[:space:]]*:[[:space:]]*"CONNECTED"' <<<"$st"; then
  addr="$(bawrun --json wallet address 2>/dev/null | grep -oE '0x[0-9a-fA-F]{40}' | head -1 || true)"
  echo "✓ 已经是登录状态，不重新扫码${addr:+（${addr}）}"
  exit 0
fi

# ② 清残留流程，停 3 秒再取码
echo "· signout 清残留流程"
bawrun --json auth signout >/dev/null 2>&1 || true
sleep 3

# ③ 取码
out="$(bawrun --json auth signin 2>/dev/null || true)"
parsed="$(printf '%s' "$out" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try{
    const raw=JSON.parse(s.match(/\{[\s\S]*\}/)[0]);
    const j=(raw.data&&(raw.data.qrCodeId||raw.data.urlForWeb))?raw.data:raw;
    if(!j.qrCodeId) return console.log("\t\t\t");
    console.log([j.qrCodeId,j.urlForWeb,j.pairingCode,j.expireAt].join("\t"));
  }catch(e){ console.log("\t\t\t"); }
})')"
IFS=$'\t' read -r qid url code exp <<<"$parsed"

if [[ -z "${qid:-}" || -z "${url:-}" ]]; then
  echo "✗ 取码失败（币安侧可能有上一轮流程没结束）："
  printf '%s\n' "$out" | head -20
  echo "  → 隔 2~3 分钟再跑一次本脚本；别连续猛点"
  exit 2
fi

left=$(( (exp / 1000) - $(date +%s) ))
echo
echo "  二维码： $url"
echo "  配对码： $code"
echo "  有效期： ${left}s"
echo
echo "  手机币安 App 扫码确认后，本脚本会自动打印结果…"
echo

# ④ 前台挂 verify（绝不 kill）
bawrun --json auth verify --qrCodeId "$qid" 2>/dev/null | tee /tmp/relogin-$N.out | sed 's/^/  /'
if grep -q '"status"[[:space:]]*:[[:space:]]*"SUCCESS"' /tmp/relogin-$N.out; then
  addr="$(bawrun --json wallet address 2>/dev/null | grep -oE '0x[0-9a-fA-F]{40}' | head -1 || true)"
  echo "✓ 登录成功${addr:+：$addr}"
  rm -f /tmp/relogin-$N.out
  exit 0
fi
echo "✗ 没有拿到 SUCCESS，看上面的输出；隔 2~3 分钟再试一次"
exit 3
