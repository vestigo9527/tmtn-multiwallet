#!/usr/bin/env bash
# 容器出网代理通道（macOS + colima，本机 Clash 只监听 127.0.0.1 时必需）
#
#   本机 Clash(127.0.0.1:7890)  ←ssh -R←  colima 虚拟机(127.0.0.1:17890)
#                                   ↑ socat 监听 0.0.0.0:17891
#                                   容器 → 172.31.0.1:17891 → 墙面外
#
#   scripts/wallet-net.sh up       启动通道（ssh 反向隧道 + 虚拟机里 socat）
#   scripts/wallet-net.sh status   看通道是否在
#   scripts/wallet-net.sh down     关掉
#   scripts/wallet-net.sh env      打印应写进 .env 的 WALLET_PROXY=...
#
# 前提：本机代理在 127.0.0.1:${PROXY_PORT}（默认 7890，Clash 默认端口）
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
mkdir -p data wallets

PROXY_PORT="${PROXY_PORT:-7890}"
VM_PORT="${VM_PORT:-17890}"      # 虚拟机里 ssh -R 的监听端口（只绑 127.0.0.1）
OPEN_PORT="${OPEN_PORT:-17891}"  # 虚拟机里 socat 的监听端口（0.0.0.0，容器用这个）
NET="${WALLET_NET:-tmtn-wallets}"
NET_SUBNET="${WALLET_SUBNET:-172.31.0.0/24}"
NET_GW="${NET_SUBNET%.0/24}.1"
SSHCFG="$HOME/.colima/_lima/colima/ssh.config"

die() { echo "✗ $*" >&2; exit 1; }
ok()  { echo "✓ $*"; }

vm_ssh() { ssh -F "$SSHCFG" lima-colima "$@"; }

tunnel_up() {
  # 已经通了就跳过
  if vm_ssh -o ConnectTimeout=5 "ss -ltn | grep -q ' 127.0.0.1:$VM_PORT'" 2>/dev/null; then
    ok "ssh 反向隧道已在（虚拟机 127.0.0.1:${VM_PORT}）"
  else
    pkill -f "ssh -F $SSHCFG lima-colima -N.*$VM_PORT:127.0.0.1:$PROXY_PORT" 2>/dev/null
    ( ssh -F "$SSHCFG" lima-colima -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
        -R "127.0.0.1:$VM_PORT:127.0.0.1:$PROXY_PORT" > data/tunnel.log 2>&1 & )
    sleep 3
    vm_ssh "ss -ltn | grep -q ' 127.0.0.1:$VM_PORT'" 2>/dev/null && ok "ssh 反向隧道已建立（虚拟机 127.0.0.1:$VM_PORT → 本机 127.0.0.1:${PROXY_PORT}）" \
      || die "反向隧道没起来，看 data/tunnel.log；本机 $PROXY_PORT 端口有代理在跑吗？"
  fi
  if vm_ssh "ss -ltn | grep -q ' 0.0.0.0:$OPEN_PORT'" 2>/dev/null; then
    ok "虚拟机 socat 已在（0.0.0.0:${OPEN_PORT}）"
  else
    vm_ssh "pkill -f 'socat TCP-LISTEN:$OPEN_PORT' 2>/dev/null; nohup socat TCP-LISTEN:$OPEN_PORT,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:$VM_PORT >/tmp/wallet-net-socat.log 2>&1 & sleep 1; ss -ltn | grep ' 0.0.0.0:$OPEN_PORT'" >/dev/null 2>&1
    vm_ssh "ss -ltn | grep -q ' 0.0.0.0:$OPEN_PORT'" 2>/dev/null && ok "虚拟机 socat 已建立（0.0.0.0:$OPEN_PORT → 127.0.0.1:${VM_PORT}）" \
      || die "虚拟机里 socat 没起来"
  fi
}

net_up() {
  if docker network inspect "$NET" >/dev/null 2>&1; then
    ok "docker 网络 $NET 已在（网关 ${NET_GW}）"
  else
    docker network create --subnet "$NET_SUBNET" "$NET" >/dev/null && ok "docker 网络 $NET 已创建（网关 ${NET_GW}）"
  fi
}

cmd_up() {
  docker info >/dev/null 2>&1 || die "docker 没连上（colima start 了吗）"
  tunnel_up
  net_up
  # 已在运行的容器补连网络（新容器由 add-wallet.sh 自动加）
  for c in $(docker ps --format '{{.Names}}' | grep -E '^tmtn-wallet[0-9]+$'); do
    docker network connect "$NET" "$c" 2>/dev/null && echo "  + $c 已接入 $NET"
  done
  echo
  echo "容器里用：WALLET_PROXY=http://$NET_GW:$OPEN_PORT"
  echo "自检：docker exec tmtn-wallet2 node -e 'fetch(\"https://www.binance.com\").then(r=>console.log(r.status)).catch(e=>console.log(e.message))'"
}

cmd_status() {
  if vm_ssh "ss -ltn | grep -q ' 127.0.0.1:$VM_PORT'" 2>/dev/null; then ok "隧道 ok"; else echo "✗ 隧道 断"; fi
  if vm_ssh "ss -ltn | grep -q ' 0.0.0.0:$OPEN_PORT'" 2>/dev/null; then ok "socat ok"; else echo "✗ socat 断"; fi
  docker network inspect "$NET" >/dev/null 2>&1 && ok "网络 $NET ok" || echo "✗ 网络 $NET 没建"
  if docker ps --format '{{.Names}}' | grep -q '^tmtn-wallet2$'; then
    docker exec tmtn-wallet2 node -e 'fetch("https://www.binance.com",{method:"HEAD"}).then(r=>console.log("✓ 容器出网 ok",r.status)).catch(e=>console.log("✗ 容器出网失败",e.message))' 2>&1 | tail -1
  fi
}

cmd_down() {
  vm_ssh "pkill -f 'socat TCP-LISTEN:$OPEN_PORT'" 2>/dev/null && ok "socat 已关"
  pkill -f "ssh -F $SSHCFG lima-colima -N.*$VM_PORT:127.0.0.1:$PROXY_PORT" 2>/dev/null && ok "隧道已关"
}

case "${1:-up}" in
  up) cmd_up ;;
  status) cmd_status ;;
  down) cmd_down ;;
  env) echo "WALLET_PROXY=http://$NET_GW:$OPEN_PORT" ;;
  *) die "用法：scripts/wallet-net.sh up|status|down|env" ;;
esac
