#!/usr/bin/env bash
# 整套本地多钱包服务的一键暂停 / 恢复
#
#   scripts/pause-all.sh stop     暂停全部（管理台、钱包1后端、6 个容器、Colima VM、通道守护）
#   scripts/pause-all.sh start    恢复全部（顺序：守护 → VM → 容器 → 钱包1后端 → 管理台）
#   scripts/pause-all.sh status   看现在哪些在跑
#
# 说明：
#   - stop 用 `docker stop`（不是 compose down），容器和登录态都留着，
#     start 时靠 restart: unless-stopped 自己回来，不需要重建
#   - 钱包 1 跑在宿主机（npm run live → node server.js），暂停就是 kill 掉
#   - 通道守护是 LaunchAgent ai.tmtn.walletnet-watch，暂停时一并卸掉，
#     恢复时重新装载；plist 文件保留在 ~/Library/LaunchAgents
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
UID_N="$(id -u)"
AGENT="ai.tmtn.walletnet-watch"
ACTION="${1:-status}"

ok()  { echo "✓ $*"; }
info(){ echo "· $*"; }

pids_of_backend() { pgrep -f "npm run live" 2>/dev/null; pgrep -f "node server.js" 2>/dev/null; }

do_stop() {
  info "1/5 停管理台"
  if [ -x wallet-manager/ctl.sh ]; then
    bash wallet-manager/ctl.sh stop >/dev/null 2>&1 && ok "管理台已停" || info "管理台本来没在跑"
  fi
  pkill -f "wallet-manager/server.mjs" 2>/dev/null && ok "残留管理台进程已清" || true

  info "2/5 停钱包 1 后端（宿主机 npm run live）"
  local P
  P="$(pids_of_backend)"
  if [ -n "$P" ]; then
    kill $P 2>/dev/null; sleep 2
    P="$(pids_of_backend)"
    [ -n "$P" ] && kill -9 $P 2>/dev/null
    ok "钱包 1 后端已停"
  else
    info "钱包 1 后端本来没在跑"
  fi

  info "3/5 停通道守护（LaunchAgent）"
  launchctl bootout "gui/$UID_N/$AGENT" >/dev/null 2>&1 && ok "通道守护已卸（plist 保留）" || info "通道守护本来没装载"

  info "4/5 停 6 个钱包容器（容器保留，登录态不动）"
  if docker info >/dev/null 2>&1; then
    local C
    C="$(docker ps -q --filter "name=tmtn-wallet" 2>/dev/null)"
    if [ -n "$C" ]; then
      docker stop $C >/dev/null 2>&1 && ok "容器已停"
    else
      info "容器本来没在跑"
    fi
  else
    info "VM 没起，跳过"
  fi

  info "5/5 关 Colima 虚拟机"
  if colima status >/dev/null 2>&1; then
    colima stop >/dev/null 2>&1 && ok "Colima 已关" || info "Colima 关闭失败，手动看 colima stop"
  else
    info "Colima 本来就没起"
  fi

  echo
  echo "全部暂停。恢复用：bash scripts/pause-all.sh start"
}

do_start() {
  info "1/5 装通道守护（VM 起来后自动补通道）"
  bash scripts/install-watch-agent.sh install >/dev/null 2>&1 && ok "通道守护已装载" || info "通道守护装载失败，稍后手动跑 install-watch-agent.sh"

  info "2/5 启动 Colima 虚拟机（5GiB）"
  if colima status >/dev/null 2>&1; then
    info "VM 已在运行"
  else
    colima start --cpu 6 --memory 5 --disk 60 --vm-type vz >/dev/null 2>&1 \
      && ok "Colima 已起（5GiB）" || { echo "✗ Colima 启动失败，看 colima start 的输出"; return 1; }
  fi

  info "3/5 等容器自动回来（restart: unless-stopped）"
  local i C
  for i in $(seq 1 20); do
    sleep 3
    C="$(docker ps -q --filter "name=tmtn-wallet" 2>/dev/null | wc -l | tr -d ' ')"
    [ "$C" = "6" ] && break
  done
  # 万一没自动起（比如之前是 docker stop 后被手动清过策略），兜底显式 start
  if [ "${C:-0}" != "6" ]; then
    local all
    all="$(docker ps -aq --filter "name=tmtn-wallet" 2>/dev/null)"
    [ -n "$all" ] && docker start $all >/dev/null 2>&1
    sleep 3
    C="$(docker ps -q --filter "name=tmtn-wallet" 2>/dev/null | wc -l | tr -d ' ')"
  fi
  ok "容器在跑：${C:-0}/6"

  info "4/5 补容器出网通道"
  bash scripts/walletnet-watch.sh >/dev/null 2>&1
  bash scripts/walletnet-watch.sh --status

  info "5/5 起钱包 1 后端 + 管理台"
  if pgrep -f "node server.js" >/dev/null 2>&1; then
    info "钱包 1 后端已在跑"
  else
    nohup npm run live >data/live.log 2>&1 &
    ok "钱包 1 后端已拉起（日志 data/live.log）"
  fi
  [ -x wallet-manager/ctl.sh ] && bash wallet-manager/ctl.sh start >/dev/null 2>&1 && ok "管理台已起（127.0.0.1:8899）"

  echo
  info "等 20 秒让各后端校验登录态…"
  sleep 20
  do_status
}

do_status() {
  echo "── 进程与服务 ──"
  if colima status >/dev/null 2>&1; then echo "Colima VM     : 运行中"; else echo "Colima VM     : 已停"; fi
  local C
  C="$(docker ps --filter "name=tmtn-wallet" --format '{{.Names}}' 2>/dev/null | sort | tr '\n' ' ')"
  echo "钱包容器      : ${C:-无}"
  if pgrep -f "node server.js" >/dev/null 2>&1; then echo "钱包1 后端    : 运行中（127.0.0.1:8787）"; else echo "钱包1 后端    : 已停"; fi
  if pgrep -f "wallet-manager/server.mjs" >/dev/null 2>&1; then echo "管理台        : 运行中（127.0.0.1:8899）"; else echo "管理台        : 已停"; fi
  if launchctl print "gui/$UID_N/$AGENT" >/dev/null 2>&1; then echo "通道守护      : 已装载"; else echo "通道守护      : 未装载"; fi

  echo
  echo "── 7 个钱包登录态 ──"
  local P J
  for P in 8787 8789 8790 8791 8792 8793 8794; do
    J="$(curl -s -m 6 "http://127.0.0.1:$P/api/wallet-info" 2>/dev/null)"
    if [ -n "$J" ]; then
      printf '%s\n' "$J" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(`  钱包${j.slot} ${String(j.label).padEnd(4)} ${j.auth==="ok"?"✅":"⚠"} ${j.auth} ${j.authMessage?String(j.authMessage).slice(0,40):""}`)}catch{console.log("  解析失败")}})'
    else
      echo "  端口 $P  : 未响应（服务已停或还在起）"
    fi
  done
}

case "$ACTION" in
  stop)   do_stop ;;
  start)  do_start ;;
  status) do_status ;;
  *) echo "用法：$0 [stop|start|status]"; exit 1 ;;
esac
