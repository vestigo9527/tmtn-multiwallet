#!/usr/bin/env bash
# 一次性给所有钱包登录：每轮给没登录的钱包各开一个登录链接（二维码 5 分钟有效），
# 生成一个本地页面 wallets/signin.html（自动倒计时），你按页面顺序扫；过期的下一轮自动重开。
#
#   scripts/signin-all.sh                 # 钱包 1..7（TMTN_WALLETS 可改）
#   scripts/signin-all.sh 3 4             # 只弄这两个
#   ROUNDS=20 scripts/signin-all.sh       # 最多开 20 轮（每轮约 5 分钟）
#
# 钱包 1 用本机 baw，钱包 N（N≥2）用容器 tmtn-walletN。登录成功后地址自动记录到 wallets/login.json，
# 全部登录完成后跑 scripts/wallets.sh lock 把地址写死进各钱包配置。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

WALLETS="${TMTN_WALLETS:-7}"
ROUNDS="${ROUNDS:-12}"
OUT="wallets"; mkdir -p "$OUT"
PAGE="$OUT/signin.html"
STATE="$OUT/login.json"
UIDIR="wallets/signin"

die() { echo "✗ $*" >&2; exit 1; }

name_of() { echo "tmtn-wallet$1"; }
baw() {
  local n="$1"; shift
  if [ "$n" = 1 ]; then command baw "$@"; else docker exec "$(name_of "$n")" baw "$@"; fi
}
jf() { node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    let j={};try{j=JSON.parse(s)}catch(e){}
    const d=j.data||j;const v=d[process.argv[1]];
    console.log(v===undefined||v===null?"":v);
  });' "$1"; }

# 已登录就直接跳过：status=CONNECTED 且能拿到 address
evm_addr() {   # baw --json wallet address → 第一个 0x 地址（BSC 与 EVM 链同一个）
  node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      let j={};try{j=JSON.parse(s)}catch(e){}
      const d=j.data||j;const a=(d.addresses||[]).map((x)=>x.address).filter((x)=>/^0x[0-9a-fA-F]{40}$/.test(x));
      console.log(a[0]||"");
    });'
}

status_of() {
  local n="$1" out st addr
  out="$(baw "$n" --json wallet status 2>/dev/null)"
  st="$(printf '%s' "$out" | jf status)"
  addr="$(printf '%s' "$out" | jf address)"
  [ -z "$addr" ] && [ "$st" = CONNECTED ] && addr="$(baw "$n" --json wallet address 2>/dev/null | evm_addr)"
  echo "${st}|${addr}"
}

ts() { date +%H:%M:%S; }

TARGETS="${*:-}"
[ -z "$TARGETS" ] && TARGETS="$(seq 1 "$WALLETS")"

# 登录结果汇总（钱包号 -> 地址）
node -e 'const fs=require("fs");const p=process.argv[1];let j={};try{j=JSON.parse(fs.readFileSync(p,"utf8"))}catch(e){};fs.writeFileSync(p,JSON.stringify(j,null,2))' "$STATE"

node_done() { node -e 'const fs=require("fs");let j={};try{j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch(e){};console.log(j[process.argv[2]]?"1":"0")' "$STATE" "$1"; }
node_set() { node -e 'const fs=require("fs");const p=process.argv[1];let j={};try{j=JSON.parse(fs.readFileSync(p,"utf8"))}catch(e){};j[process.argv[2]]={address:process.argv[3]||null,at:new Date().toISOString()};fs.writeFileSync(p,JSON.stringify(j,null,2))' "$STATE" "$1" "$2"; }

render_page() {
  # 每个钱包一张卡：序号 / 链接 / 配对码 / 倒计时 / 状态
  local cards="" n url code exp st
  for n in $TARGETS; do
    if [ "$(node_done "$n")" = 1 ]; then
      cards+="<div class=card done><h2>钱包 $n ✓ 已登录</h2><p class=addr>$(node -e 'const j=require("./'"$STATE"'");console.log(j[process.argv[1]].address||"")' "$n")</p></div>"
      continue
    fi
    url="$(cat "$UIDIR/$n.url" 2>/dev/null)"; code="$(cat "$UIDIR/$n.code" 2>/dev/null)"; exp="$(cat "$UIDIR/$n.exp" 2>/dev/null)"
    st="$(cat "$UIDIR/$n.st" 2>/dev/null || echo 待扫)"
    [ -z "$url" ] && continue
    cards+="<div class=card data-exp=$exp><h2>钱包 $n</h2><a href=\"$url\" target=_blank>$url</a><p class=code>配对码 <b>$code</b></p><p class=left></p><p class=st>$st</p></div>"
  done
  cat > "$PAGE" <<HTML
<!doctype html><meta charset=utf-8><title>TMTN 7 钱包登录</title>
<meta http-equiv=refresh content=20>
<style>
body{font:15px/1.6 -apple-system,sans-serif;background:#0f1115;color:#e6e6e6;margin:0;padding:24px}
h1{font-size:18px;color:#f0b90b}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px;margin-top:16px}
.card{background:#181b21;border:1px solid #24272e;border-radius:12px;padding:14px}
.card h2{margin:0 0 8px;font-size:15px}
.card a{color:#4da3ff;word-break:break-all;font-size:13px}
.code b{font-size:20px;letter-spacing:2px;color:#f0b90b}
.done{border-color:#2e7d32}.done h2{color:#66bb6a}
.addr{font-family:ui-monospace;font-size:12px;word-break:break-all;color:#8b949e}
.left{color:#8b949e;font-size:13px}.st{color:#ffa726;font-size:13px}
</style>
<h1>TMTN 多钱包登录 · 共 ${WALLETS} 个 · 页面每 20 秒自动刷新</h1>
<p style="color:#8b949e;font-size:13px">顺序：打开链接 → 手机币安 App 扫码 → 核对 App 里显示的配对码与卡片上的<b>配对码</b>一致 → 确认。二维码 5 分钟过期，过期后本页会自动换成新链接。</p>
<div class=grid>${cards}</div>
<script>
for(const c of document.querySelectorAll('.card[data-exp]')){
  const exp=+c.dataset.exp, el=c.querySelector('.left');
  const t=()=>{const s=Math.round((exp-Date.now())/1000);el.textContent=s>0?('剩余 '+Math.floor(s/60)+':'+String(s%60).padStart(2,'0')):'已过期，等下一页';};
  t();setInterval(t,1000);
}
</script>
HTML
  echo "  页面已更新：$ROOT/$PAGE"
}

echo "════ 钱包登录：$(echo $TARGETS | tr '\n' ' ') ════"
for n in $TARGETS; do
  if [ "$n" != 1 ]; then
    docker ps --filter "name=^$(name_of "$n")\$" --format '{{.State}}' | grep -q running || die "容器 $(name_of "$n") 没运行，先跑 scripts/add-wallet.sh $n"
  fi
done

for r in $(seq 1 "$ROUNDS"); do
  todo=""
  for n in $TARGETS; do
    if [ "$(node_done "$n")" = 1 ]; then continue; fi
    IFS='|' read -r st addr <<<"$(status_of "$n")"
    if [ "$st" = "CONNECTED" ] || [ -n "$addr" ]; then
      node_set "$n" "$addr"; echo "  ✓ 钱包 $n 已登录：$addr"; continue
    fi
    todo="$todo $n"
  done
  [ -z "$todo" ] && { echo "✓ 全部登录完成"; render_page; break; }

  echo "[$(ts)] 第 $r/$ROUNDS 轮，开登录：$todo"
  mkdir -p "$UIDIR"; : > "$UIDIR/ids"
  for n in $todo; do
    out="$(baw "$n" --json auth signin 2>"$UIDIR/$n.err")"
    id="$(printf '%s' "$out" | jf qrCodeId)"
    url="$(printf '%s' "$out" | jf urlForWeb)"
    code="$(printf '%s' "$out" | jf pairingCode)"
    exp="$(printf '%s' "$out" | jf expireAt)"
    if [ -z "$id" ]; then
      echo "  ✗ 钱包 $n 拿不到登录链接：$(printf '%s' "$out" | head -3 | tr '\n' ' ')"
      continue
    fi
    printf '%s\n' "$url" > "$UIDIR/$n.url"; printf '%s\n' "$code" > "$UIDIR/$n.code"
    printf '%s\n' "$exp" > "$UIDIR/$n.exp"; printf '待扫\n' > "$UIDIR/$n.st"
    printf '%s %s\n' "$n" "$id" >> "$UIDIR/ids"
    echo "  钱包 $n → $url  配对码 $code"
  done

  render_page
  if [ "$r" = 1 ]; then command open "$PAGE" 2>/dev/null || true; fi

  # 并行等结果：每 5 秒查一次 verify（baw verify 本身会阻塞到出结果或过期，用后台 + 超时兜底）
  pids=""
  while read -r n id; do
    ( baw "$n" --json auth verify --qrCodeId "$id" >"$UIDIR/$n.verify" 2>"$UIDIR/$n.verify.err" ) &
    pids="$pids $!"
  done < "$UIDIR/ids"
  # 最长等 5 分 20 秒，期间成功一个就记一个
  deadline=$(( $(date +%s) + 320 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    while read -r n id; do
      [ "$(node_done "$n")" = 1 ] && continue
      st="$(cat "$UIDIR/$n.st" 2>/dev/null)"
      addr="$(node -e '
        const fs=require("fs");const p=process.argv[1];let j={};try{j=JSON.parse(fs.readFileSync(p,"utf8"))}catch(e){}
        const d=j.data||j;console.log(d.status==="SUCCESS"?(d.address||d.walletAddress||""):"")' "$UIDIR/$n.verify" 2>/dev/null)"
      [ -z "$addr" ] && grep -q '"status": *"SUCCESS"' "$UIDIR/$n.verify" 2>/dev/null && addr="$(baw "$n" --json wallet address 2>/dev/null | evm_addr)"
      if [ -n "$addr" ]; then
        node_set "$n" "$addr"; printf '✓ 已登录 %s\n' "$addr" > "$UIDIR/$n.st"
        echo "  ✓ 钱包 $n 登录成功：$addr"
      elif grep -q '"status": *"\(EXPIRED\|FAILED\|CANCELED\|DECLINED\)"' "$UIDIR/$n.verify" 2>/dev/null; then
        printf '过期/取消，下一轮重开\n' > "$UIDIR/$n.st"
      fi
    done < "$UIDIR/ids"
    remaining=0
    for n in $todo; do [ "$(node_done "$n")" = 1 ] || remaining=$((remaining+1)); done
    [ "$remaining" = 0 ] && break
    sleep 5
  done
  for p in $pids; do kill "$p" 2>/dev/null; done; wait 2>/dev/null
  render_page
done

echo
bash scripts/wallets.sh status
done_n=0; for n in $TARGETS; do [ "$(node_done "$n")" = 1 ] && done_n=$((done_n+1)); done
echo
echo "完成 $done_n / $(echo $TARGETS | wc -w | tr -d ' ') 个"
[ -s "$STATE" ] && echo "登录记录：$ROOT/$STATE" && cat "$STATE"
echo "下一步：scripts/wallets.sh lock   # 把地址写死进各钱包，防止扫错账号下单"
