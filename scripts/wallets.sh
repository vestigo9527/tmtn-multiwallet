#!/usr/bin/env bash
# 多钱包（钱包 1 = 本机主后端，钱包 2..7 = Docker 容器）的总控脚本。
#
#   scripts/wallets.sh status                  # 7 个钱包一览：容器 / 后端 / 登录 / 地址 / 实盘开关
#   scripts/wallets.sh signin                  # 依次登录钱包 1..7（打印登录链接 + 配对码，等你扫码）
#   scripts/wallets.sh signin 3 5              # 只登录指定的钱包
#   scripts/wallets.sh lock                    # 登录后把地址写死进每个钱包（防止扫错账号下单）
#   scripts/wallets.sh live 3 4                # 让钱包 3、4 真实下单（LIVE_TRADE=1）
#   scripts/wallets.sh quote 3 4               # 改回只报价
#   scripts/wallets.sh peers                   # 打印 / 写入主后端的 WALLET_PEERS
#   scripts/wallets.sh label                   # 看 7 个钱包的备注名
#   scripts/wallets.sh label 3 主号A           # 给钱包 3 备注「主号A」（会重建该容器，登录不丢）
#   scripts/wallets.sh add 8 钱包8-打新        # 以后加第 8 个钱包：建容器 + 备注 + 同步 peers
#
# 钱包 1 走本机 baw；钱包 N（N≥2）走容器 tmtn-walletN，端口 127.0.0.1:(8787+N)，配置在 wallets/walletN/。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# shellcheck source=scripts/labels.sh
source "$ROOT/scripts/labels.sh"     # 钱包备注名（wallets/labels.env）
max_slot() {   # 现有钱包最大编号（没有就 1）
  local d n max=1
  for d in wallets/wallet*/; do
    [ -d "$d" ] || continue
    n="${d#wallets/wallet}"; n="${n%/}"
    case "$n" in ''|*[!0-9]*) continue ;; esac
    [ "$n" -gt "$max" ] && max="$n"
  done
  echo "$max"
}
WALLETS="${TMTN_WALLETS:-$(max_slot)}"   # 一共几个钱包：默认按 wallets/walletN 目录探测
HOST_PORT="$(grep -E '^PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' )"; HOST_PORT="${HOST_PORT:-8787}"
HOST_PORT="$(grep -E '^PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' )"; HOST_PORT="${HOST_PORT:-8787}"
port_of() { echo $((8787 + $1)); }
url_of()  { if [ "$1" = 1 ]; then echo "http://127.0.0.1:$HOST_PORT"; else echo "http://127.0.0.1:$(port_of "$1")"; fi; }
name_of() { echo "tmtn-wallet$1"; }

die() { echo "✗ $*" >&2; exit 1; }
ok()  { echo "✓ $*"; }

# 用容器里的 baw（N≥2）或本机 baw（N=1）
baw() {
  local n="$1"; shift
  if [ "$n" = 1 ]; then command baw "$@"; else docker exec "$(name_of "$n")" baw "$@"; fi
}

json_field() { node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    let j={};try{j=JSON.parse(s)}catch(e){}
    const d=j.data||j;const v=d[process.argv[1]];
    console.log(v===undefined||v===null?"":v);
  });' "$1"; }

cmd_status() {
  local n info
  printf '%-6s %-14s %-10s %-16s %-10s %-12s %s\n' 序号 备注 容器 后端 登录 实盘 地址
  for n in $(seq 1 "$WALLETS"); do
    local cont="本机" be="连不上" auth="-" live="-" addr="-"
    if [ "$n" != 1 ]; then
      cont="$(docker ps --filter "name=^$(name_of "$n")\$" --format '{{.State}}' 2>/dev/null)"
      [ -n "$cont" ] && cont="up" || cont="down"
    fi
    if info="$(curl -fsS -m 3 "$(url_of "$n")/api/wallet-info" 2>/dev/null)"; then
      local line; line="$(printf '%s' "$info" | node -e '
        let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=JSON.parse(s||"{}");
        const map={ok:"已登录",wrong_account:"账号不对",checking:"检查中",logged_out:"未登录"};
        console.log([map[i.auth]||i.auth||"?", (i.address||"-").slice(0,10)+"…", i.bnb??"-"].join("\t"));});')"
      auth="$(printf '%s' "$line" | cut -f1)"
      addr="$(printf '%s' "$line" | cut -f2)"
      be="up"
    fi
    if [ "$n" != 1 ] && [ -f "wallets/wallet$n/live" ]; then
      [ "$(cat "wallets/wallet$n/live")" = 1 ] && live="真实下单" || live="只报价"
    elif [ "$n" = 1 ]; then
      [ "$(grep -E '^LIVE_TRADE=' .env | tail -1 | cut -d= -f2-)" = 1 ] && live="真实下单" || live="只报价"
    fi
    printf '%-6s %-14s %-10s %-16s %-10s %-12s %s\n' "$n" "$(label_of "$n")" "$cont" "$be" "$auth" "$live" "$addr"
  done
}

cmd_signin() {
  local ns="${*:-}"; [ -z "$ns" ] && ns="$(seq 1 "$WALLETS")"
  local n out id url code
  for n in $ns; do
    echo
    echo "════════ 钱包 ${n}（$( [ "$n" = 1 ] && echo 本机 || echo "容器 $(name_of "$n")" )）════════"
    if [ "$n" != 1 ]; then
      docker ps --filter "name=^$(name_of "$n")\$" --format '{{.State}}' | grep -q running \
        || { echo "✗ 容器 $(name_of "$n") 没在运行：scripts/add-wallet.sh $n 先建好"; continue; }
    fi
    out="$(baw "$n" --json auth signin 2>&1)"
    id="$(printf '%s' "$out" | json_field qrCodeId)"
    url="$(printf '%s' "$out" | json_field urlForWeb)"
    code="$(printf '%s' "$out" | json_field pairingCode)"
    [ -n "$id" ] || { echo "✗ 拿不到登录链接，原始输出："; printf '%s\n' "$out" | head -20; continue; }
    echo "  1) 浏览器打开：$url"
    echo "  2) 用【钱包 $n 对应的币安账号】扫页面上的二维码"
    echo "  3) App 里的配对码必须是：$code  —— 不一致就取消，重新跑本命令"
    echo "  等待确认（最多 5 分钟）…"
    baw "$n" --json auth verify --qrCodeId "$id" >/tmp/tmtn-signin-$n.json 2>&1
    node -e '
      const fs=require("fs");let j={};try{j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch(e){}
      const d=j.data||j;
      if(d.status==="SUCCESS"||d.address) console.log("  ✓ 登录成功"+((d.address||d.walletAddress)?("："+(d.address||d.walletAddress)):""));
      else console.log("  ✗ 没完成（"+((d.status)||"未知")+"），可以重新跑：scripts/wallets.sh signin '"$n"'");' /tmp/tmtn-signin-$n.json
    sleep 1
    echo "  当前状态：$(baw "$n" --json wallet status 2>&1 | json_field status)"
  done
  echo
  cmd_status
}

cmd_lock() {
  local n info addr f changed=0
  local seen=""
  for n in $(seq 1 "$WALLETS"); do
    info="$(curl -fsS -m 3 "$(url_of "$n")/api/wallet-info" 2>/dev/null)" || { echo "钱包 ${n}：后端连不上，跳过"; continue; }
    addr="$(printf '%s' "$info" | json_field address)"
    case "$addr" in 0x????????????????????????????????????????) ;; *) echo "钱包 ${n}：还没登录，跳过"; continue ;; esac
    case "$seen" in *"$addr"*) echo "✗ 钱包 $n 的地址 $addr 和别的钱包重复了（扫错账号）：scripts/wallets.sh signin $n 重新扫"; continue ;; esac
    seen="$seen $addr"
    if [ "$n" = 1 ]; then
      grep -q '^WALLET_ADDRESS=' .env && sed -i.bak "s/^WALLET_ADDRESS=.*/WALLET_ADDRESS=$addr/" .env || printf 'WALLET_ADDRESS=%s\n' "$addr" >> .env
      echo "钱包 1：WALLET_ADDRESS=$addr 写进 .env（重启主后端后生效）"; changed=1
    else
      f="wallets/wallet$n/address"
      if [ -f "$f" ] && [ "$(cat "$f")" = "$addr" ] && grep -qF "WALLET_ADDRESS: \"$addr\"" "wallets/wallet$n/docker-compose.yml"; then
        echo "钱包 ${n}：锁定的是 ${addr}（无需改动）"; continue
      fi
      echo "钱包 ${n}：锁定 $addr …"; scripts/add-wallet.sh "$n" --address "$addr" >/tmp/tmtn-lock-$n.log 2>&1 \
        && echo "  ✓ 已锁定并重建容器（日志 /tmp/tmtn-lock-$n.log）" || { echo "  ✗ 失败，看 /tmp/tmtn-lock-$n.log"; }
      changed=1
    fi
  done
  echo; cmd_status
  [ "$changed" = 1 ] && echo && echo "提示：钱包 1 的 WALLET_ADDRESS 改了要重启主后端才生效。"
}

cmd_toggle() {
  local want="$1"; shift
  local ns="${*:-}"; [ -z "$ns" ] && die "要指定钱包编号，例如 scripts/wallets.sh $([ "$want" = 1 ] && echo live || echo quote) 3 4"
  local n
  for n in $ns; do
    if [ "$n" = 1 ]; then
      sed -i.bak "s/^LIVE_TRADE=.*/LIVE_TRADE=$want/" .env
      echo "钱包 1：LIVE_TRADE=$want 写进 .env（重启主后端后生效）"
    else
      echo "$want" > "wallets/wallet$n/live" 2>/dev/null || { echo "钱包 $n 还没建，先 scripts/add-wallet.sh $n"; continue; }
      scripts/add-wallet.sh "$n" --$([ "$want" = 1 ] && echo live || echo quote-only) >/tmp/tmtn-live-$n.log 2>&1 \
        && echo "钱包 ${n}：$([ "$want" = 1 ] && echo 真实下单 || echo 只报价)" || echo "钱包 ${n}：失败，看 /tmp/tmtn-live-$n.log"
    fi
  done
  echo
  echo "别忘了在页面右上角钱包菜单里打开对应钱包的「参与下单」。"
}


cmd_label() {
  local n="${1:-}" naming
  if [ -z "$n" ]; then labels_all; return; fi
  shift || true
  naming="$*"
  [ -z "$naming" ] && { echo "用法：scripts/wallets.sh label 3 主号A"; return 1; }
  case "$n" in *[!0-9]*) die "钱包序号要是数字：$n" ;; esac
  label_set "$n" "$naming" >/dev/null
  ok "钱包 $n 的备注改成「${naming}」"
  if [ "$n" = 1 ]; then
    bak=".env.bak-$(date +%Y%m%d-%H%M%S)"; cp -p .env "$bak"
    LABEL_V="$naming" node -e '
      const fs=require("fs");const s=fs.readFileSync(".env","utf8").split("\n").map((l)=>l.startsWith("WALLET_LABEL=")?"WALLET_LABEL="+process.env.LABEL_V:l).join("\n");
      fs.writeFileSync(".env",s);'
    ok "主后端 .env 的 WALLET_LABEL 也改了（重启主后端后页面上显示新备注）"
  else
    echo "→ 重建容器让新备注生效（登录信息在 wallets/wallet$n/baw，不会丢）"
    bash scripts/add-wallet.sh "$n" >/tmp/tmtn-label-$n.log 2>&1 && ok "容器 $(name_of "$n") 已更新" || echo "  ✗ 失败，看 /tmp/tmtn-label-$n.log"
    bash scripts/add-wallet.sh --peers --write-env >/dev/null 2>&1 && ok "WALLET_PEERS 已同步"
  fi
  echo; cmd_status
}

cmd_add() {
  local n="${1:-}" naming="${2:-}"
  [ -z "$n" ] && { echo "用法：scripts/wallets.sh add 8 [备注名]"; return 1; }
  case "$n" in *[!0-9]*) die "钱包序号要是数字：$n" ;; esac
  [ "$n" = 1 ] && die "钱包 1 是本机主后端，不用 add；加新钱包从 2 开始，编号接着往后排"
  [ -d "wallets/wallet$n" ] && echo "! 钱包 $n 已经存在，等同重新配置它"
  [ -n "$naming" ] && label_set "$n" "$naming" >/dev/null
  bash scripts/wallet-net.sh up >/dev/null 2>&1 || echo "! 代理通道没起来，先跑 scripts/wallet-net.sh up"
  echo "→ 建钱包 ${n}（端口 $(port_of "$n")，备注「$(label_of "$n")」）"
  bash scripts/add-wallet.sh "$n" || die "建容器失败"
  bash scripts/add-wallet.sh --peers --write-env >/dev/null 2>&1 && ok "WALLET_PEERS 已写进 .env（主后端重启后认到新钱包）"
  echo
  echo "下一步："
  echo "  1) scripts/wallets.sh signin $n      # 用第 $n 个币安账号扫码（二维码 5 分钟有效）"
  echo "  2) scripts/wallets.sh lock           # 把地址写死进配置"
  echo "  3) 重启主后端让 WALLET_PEERS 生效：kill \$(lsof -ti tcp:\$HOST_PORT) 后 nohup npm run live > data/live.log 2>&1 &"
}

case "${1:-}" in
  status) cmd_status ;;
  signin) shift; cmd_signin "$@" ;;
  lock)   cmd_lock ;;
  live)   shift; cmd_toggle 1 "$@" ;;
  quote)  shift; cmd_toggle 0 "$@" ;;
  peers)  shift; scripts/add-wallet.sh --peers "$@" ;;
  label)  shift; cmd_label "$@" ;;
  add)    shift; cmd_add "$@" ;;
  *) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
