#!/usr/bin/env bash
# 装/卸「通道守护」LaunchAgent：VM 起来后自动跑 wallet-net.sh up
#
#   scripts/install-watch-agent.sh install    装（默认动作）
#   scripts/install-watch-agent.sh uninstall  卸
#   scripts/install-watch-agent.sh status     看状态
#
# 装完效果：macOS 登录后 launchd 每 30 秒调一次 scripts/walletnet-watch.sh，
# 发现虚拟机的 ssh 反向隧道 / socat / docker 网络缺了就自动补，不用手敲命令。
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="ai.tmtn.walletnet-watch"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_N="$(id -u)"
ACTION="${1:-install}"

case "$ACTION" in
  install)
    mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/data"
    cat >"$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string>
		<string>$ROOT/scripts/walletnet-watch.sh</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
		<key>HOME</key>
		<string>$HOME</string>
	</dict>
	<key>StartInterval</key>
	<integer>30</integer>
	<key>RunAtLoad</key>
	<true/>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>$ROOT/data/walletnet-watch.launchd.log</string>
	<key>StandardErrorPath</key>
	<string>$ROOT/data/walletnet-watch.launchd.log</string>
</dict>
</plist>
PLISTEOF
    plutil -lint "$PLIST" >/dev/null || { echo "✗ plist 格式不对"; exit 1; }
    launchctl bootout "gui/$UID_N/$LABEL" >/dev/null 2>&1
    launchctl bootstrap "gui/$UID_N" "$PLIST" && echo "✓ 已装载 $LABEL（每 30 秒巡检，登录后自动生效）"
    echo "  日志：$ROOT/data/walletnet-watch.log"
    echo "  自检：bash $ROOT/scripts/walletnet-watch.sh --status"
    ;;
  uninstall)
    launchctl bootout "gui/$UID_N/$LABEL" >/dev/null 2>&1 && echo "✓ 已停止 $LABEL"
    rm -f "$PLIST" && echo "✓ 已删除 $PLIST"
    ;;
  status)
    if launchctl print "gui/$UID_N/$LABEL" >/dev/null 2>&1; then
      echo "✓ $LABEL 在跑"
      launchctl print "gui/$UID_N/$LABEL" 2>/dev/null | grep -E "state = |runs = |last exit code" | head -3
    else
      echo "✗ $LABEL 没装"
    fi
    bash "$ROOT/scripts/walletnet-watch.sh" --status
    ;;
  *)
    echo "用法：$0 [install|uninstall|status]"; exit 1 ;;
esac
