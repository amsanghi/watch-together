#!/bin/bash
# Install (or remove) a launchd agent that keeps the relay running: it starts on
# login and restarts if it (or the machine) goes down. Double-click to install, or:
#   ./install-service.command            install
#   ./install-service.command uninstall  remove
set -u
cd "$(dirname "$0")" || exit 1
DIR="$PWD"
LABEL="com.watchtogether.relay"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SUP="$DIR/relay-supervisor.command"

uninstall() {
  launchctl unload "$PLIST" 2>/dev/null
  rm -f "$PLIST"
  echo "🛑 Relay auto-start removed. (The relay itself keeps running until: ./relay.command down)"
}

install() {
  chmod +x "$SUP" "$DIR/relay.command" 2>/dev/null
  mkdir -p "$HOME/Library/LaunchAgents"
  # PATH must include Homebrew (node/ngrok) — launchd's default PATH doesn't.
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$SUP</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>StandardOutPath</key><string>$DIR/service.log</string>
  <key>StandardErrorPath</key><string>$DIR/service.log</string>
</dict>
</plist>
EOF
  launchctl unload "$PLIST" 2>/dev/null
  launchctl load "$PLIST" 2>/dev/null
  echo "✅ Relay auto-start installed — it launches on login and restarts if it dies."
  echo "   Plist: $PLIST"
  echo "   Log:   $DIR/service.log"
  echo "   Remove with:  ./install-service.command uninstall"
}

case "${1:-install}" in
  install)   install ;;
  uninstall) uninstall ;;
  *) echo "usage: ./install-service.command [install|uninstall]"; exit 2 ;;
esac
