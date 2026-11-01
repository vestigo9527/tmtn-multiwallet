#!/usr/bin/env bash
# qr-session.sh N —— 在一个独立的后台进程里跑完整个扫码登录流程
#
#   bash scripts/qr-session.sh 1
#
# 流程：wallet status（已登录就直接退出，不动会话）→ auth signout → 停 3 秒
#       → auth signin 拿二维码 → 前台常驻 auth verify 等扫码 → 结果写文件
#
# 产出（管理台直接读）：
#   wallets/signin/N.json    {"slot":1,"urlForWeb":"…","pairingCode":"…","qrCodeId":"…","expireAt":…,"pid":…}
#   wallets/signin/N.result  {"status":"SUCCESS"|"EXPIRED"|"FAILED","raw":"…","at":…}
#
# 纪律：verify 一旦挂上就绝不 kill —— 杀掉它会让币安侧的登录流程悬空，
#       之后同一设备的取码一律 AUTH_REJECTED。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
N="${1:-}"
if [ -z "$N" ]; then echo "用法：bash scripts/qr-session.sh <钱包号 N>"; exit 2; fi

UIDIR="$ROOT/wallets/signin"
mkdir -p "$UIDIR"
JSON="$UIDIR/$N.json"
RES="$UIDIR/$N.result"

bawc() {
  if [ "$N" = "1" ]; then baw "$@"
  else docker exec "tmtn-wallet$N" baw "$@"
  fi
}

say() { echo "$(date +%H:%M:%S) [qr$N] $*"; }

# 1) 已登录就别动它
st="$(bawc --json wallet status 2>/dev/null)"
if printf '%s' "$st" | grep -q '"CONNECTED"'; then
  say "已经是登录状态，不动会话"
  printf '{"status":"SUCCESS","raw":"already connected","at":%s}\n' "$(date +%s)" > "$RES"
  exit 0
fi

# 2) 真的要重新登录：先清掉上一张码和旧结果，免得页面读到残留的 SUCCESS 或过期码
rm -f "$JSON" "$RES"

# 3) 清残留会话 → 停 3 秒 → 取码
say "signout 清残留流程"
bawc --json auth signout >/dev/null 2>&1
sleep 3

say "取码"
out="$(bawc --json auth signin 2>/dev/null)"
if ! printf '%s' "$out" | grep -q '"urlForWeb"'; then
  say "取码失败：$(printf '%s' "$out" | tr -d '\n' | cut -c1-160)"
  printf '{"status":"FAILED","raw":%s,"at":%s}\n' \
    "$(printf '%s' "$out" | QR_PID=$$ node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(s.slice(0,400))))')" \
    "$(date +%s)" > "$RES"
  exit 1
fi

printf '%s' "$out" | QR_PID=$$ node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const m=/\{[\s\S]*\}/.exec(s); const raw=m?JSON.parse(m[0]):{};
  const d=raw.data&&(raw.data.urlForWeb||raw.data.qrCodeId)?raw.data:raw;
  const obj={slot:Number(process.argv[1]),urlForWeb:d.urlForWeb,pairingCode:d.pairingCode,
             qrCodeId:d.qrCodeId,expireAt:Number(d.expireAt),pid:Number(process.env.QR_PID||0),at:Date.now()};
  require("fs").writeFileSync(process.argv[2],JSON.stringify(obj,null,1)+"\n");
})' "$N" "$JSON"

url="$(node -e 'console.log(require(process.argv[1]).urlForWeb)' "$JSON" 2>/dev/null)"
code="$(node -e 'console.log(require(process.argv[1]).pairingCode)' "$JSON" 2>/dev/null)"
say "出码 $code → $url"
say "挂 verify 等扫码（绝不 kill）"

# 4) 常驻等扫码；成功/失败都写结果（verify 挂上后绝不 kill）
qid="$(node -e 'console.log(require(process.argv[1]).qrCodeId)' "$JSON" 2>/dev/null)"
vout="$(bawc --json auth verify --qrCodeId "$qid" 2>&1)"
printf '%s' "$vout" > "$UIDIR/$N.verify.log"
if printf '%s' "$vout" | grep -q '"SUCCESS"'; then
  say "✓ 登录成功"
  printf '{"status":"SUCCESS","raw":"ok","at":%s}\n' "$(date +%s)" > "$RES"
else
  say "✗ verify 结束：$(printf '%s' "$vout" | tr -d '\n' | cut -c1-160)"
  printf '{"status":"FAILED","raw":%s,"at":%s}\n' \
    "$(printf '%s' "$vout" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(s.slice(0,400))))')" \
    "$(date +%s)" > "$RES"
fi
