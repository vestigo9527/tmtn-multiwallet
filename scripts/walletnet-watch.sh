#!/usr/bin/env bash
# 容器出网通道守护进程（配合 LaunchAgent ai.tmtn.walletnet-watch，每 30 秒跑一次）
#
# 解决的问题：colima 虚拟机关机/重启后，ssh 反向隧道（VM 127.0.0.1:17890）和
# socat（VM 0.0.0.0:17891）都会消失，6 个容器立刻无法连接币安，钱包显示
# NETWORK_ERROR。以前每次 `colima start` 之后都要手动敲一次
# `bash scripts/wallet-net.sh up`，忘了就是一片红。
#
# 逻辑：VM（docker）可用时，检查三件事，任一缺失就补一次 `wallet-net.sh up`
#   1. VM 内 127.0.0.1:17890 有监听（ssh -R 反向隧道）
#   2. VM 内 0.0.0.0:17891 有监听（socat 转发）
#   3. 6 个钱包容器都接在 tmtn-wallets 网络上
#
#   scripts/walletnet-watch.sh          单次检查（LaunchAgent 调用这个）
#   scripts/walletnet-watch.sh --status 只报告，不修
#
# 日志：data/walletnet-watch.log（只在状态变化时写字，不会每 30 秒刷屏）
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
LOG="$ROOT/data/walletnet-watch.log"
STATE="$ROOT/data/.walletnet-watch.state"
LOCK="$ROOT/data/.walletnet-watch.lock"
NET="${WALLET_NET:-tmtn-wallets}"
VM_PORT="${VM_PORT:-17890}"      # vm 里 ssh -R 的监听端口
OPEN_PORT="${OPEN_PORT:-17891}"  # vm 里 socat 的监听端口
MODE="${1:-}"

mkdir -p data
log() {
  printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG"
  # 超过 512KB 就砍掉前 80%
  if [ -f "$LOG" ] && [ "$(wc -c <"$LOG" 2>/dev/null || echo 0)" -gt 524288 ]; then
    tail -c 100000 "$LOG" >"$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
  fi
}

# 同一定时器不重叠执行（launchd 可能在慢速自检时叠加触发）
if ! mkdir "$LOCK" 2>/dev/null; then
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

# VM 没起来就什么都不做（等下一次检查）
if ! docker info >/dev/null 2>&1; then
  if [ "$(cat "$STATE" 2>/dev/null)" != "vm-down" ]; then
    log "docker 不可用（colima VM 未运行），等待 VM 启动"
    echo "vm-down" >"$STATE"
  fi
  [ "$MODE" = "--status" ] && echo "VM 未运行"
  exit 0
fi

# VM 内某端口有没有监听
vm_listen() {
  colima ssh -- sh -c "ss -ltn 2>/dev/null | grep -c ':$1 '" 2>/dev/null | tr -d '\r'
}
TUN="$(vm_listen "$VM_PORT")"; TUN="${TUN:-0}"
SOC="$(vm_listen "$OPEN_PORT")"; SOC="${SOC:-0}"

# 容器是否都接在共享网络上
NETCOUNT=0
if docker network inspect "$NET" >/dev/null 2>&1; then
  for c in $(docker ps --filter "name=tmtn-wallet" --format '{{.Names}}' 2>/dev/null); do
    if docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$c" 2>/dev/null | grep -q "$NET"; then
      NETCOUNT=$((NETCOUNT + 1))
    fi
  done
fi
NETOK=1
[ "$NETCOUNT" -ge 2 ] || NETOK=0   # 至少 2 个容器在网里才算正常（单容器时不算坏）

missing=""
[ "$TUN" = "0" ] && missing="${missing}、隧道"
[ "$SOC" = "0" ] && missing="${missing}、socat"
[ "$NETOK" = "0" ] && missing="${missing}、容器网络"
missing="${missing#、}"

if [ -z "$missing" ]; then
  if [ "$(cat "$STATE" 2>/dev/null)" != "ok" ]; then
    log "通道正常（$VM_PORT ✓ $OPEN_PORT ✓ 网络 ✓ $NETCOUNT 个容器）"
    echo "ok" >"$STATE"
  fi
  [ "$MODE" = "--status" ] && echo "通道正常：隧道 ✓ socat ✓ 网络 ✓（$NETCOUNT 个容器）"
  exit 0
fi

if [ "$MODE" = "--status" ]; then
  echo "通道缺失：$missing"
  exit 1
fi

echo "repairing" >"$STATE"
log "检测到「${missing}」缺失，自动执行 wallet-net.sh up"
if bash "$ROOT/scripts/wallet-net.sh" up >>"$LOG" 2>&1; then
  # up 之后再验一次，别只看脚本退出码
  sleep 2
  TUN2="$(vm_listen "$VM_PORT")"; SOC2="$(vm_listen "$OPEN_PORT")"
  if [ "${TUN2:-0}" != "0" ] && [ "${SOC2:-0}" != "0" ]; then
    log "自动修复成功（隧道 $VM_PORT ✓ socat $OPEN_PORT ✓）"
    echo "ok" >"$STATE"
  else
    log "自动修复后仍不完整（隧道=${TUN2:-0} socat=${SOC2:-0}），下次再试"
    echo "repair-incomplete" >"$STATE"
  fi
else
  log "wallet-net.sh up 执行失败，下次再试（详见上面的输出）"
  echo "repair-failed" >"$STATE"
fi
