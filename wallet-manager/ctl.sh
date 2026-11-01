#!/usr/bin/env bash
# 钱包备注管理台：启动 / 停止 / 查看
#   scripts 里的逻辑不做改动，这个页面只是给它们套了个 UI
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

PORT="${PM_PORT:-8899}"
LOG="data-pm.log"
PIDFILE=".pm.pid"

running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

case "${1:-start}" in
  start)
    if running; then echo "✓ 已在运行：http://127.0.0.1:${PORT}（pid $(cat "$PIDFILE")）"; exit 0; fi
    nohup node wallet-manager/server.mjs > "$LOG" 2>&1 &
    echo $! > "$PIDFILE"
    for _ in $(seq 1 20); do
      sleep 0.4
      if curl -sf -m 1 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
        echo "✓ 已启动：http://127.0.0.1:${PORT}（pid $(cat "$PIDFILE")）"
        exit 0
      fi
    done
    echo "✗ 启动失败，看 $LOG"; tail -20 "$LOG"; exit 1
    ;;
  stop)
    if running; then kill "$(cat "$PIDFILE")" && echo "✓ 已停止"; rm -f "$PIDFILE"; else echo "没在运行"; fi
    ;;
  status)
    if running; then echo "✓ 运行中：http://127.0.0.1:${PORT}（pid $(cat "$PIDFILE")）"; else echo "未运行"; fi
    curl -s -m 2 "http://127.0.0.1:${PORT}/api/state" 2>/dev/null \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log("钱包 "+j.wallets.length+" 个："+j.wallets.map(w=>w.slot+" "+w.label+(w.auth==="ok"?" ✓":" ✗")).join(" / "))}catch{console.log("接口没响应")}})'
    ;;
  open)
    "$0" start >/dev/null && open "http://127.0.0.1:${PORT}"
    ;;
  *) echo "用法：$0 [start|stop|status|open]"; exit 1 ;;
esac
