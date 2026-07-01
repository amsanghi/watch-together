#!/bin/bash
# WatchTogether relay control — non-blocking up / down / status.
#
#   ./relay.command up       start the relay server + ngrok tunnel in the
#                            BACKGROUND and print the wss:// link, then return.
#                            Does NOT hang the terminal. Safe to run when already up.
#   ./relay.command down     stop the server + tunnel. Safe to run when already down.
#   ./relay.command status   show whether it's up, and the current link.
#   ./relay.command restart  down, then up.
#
# Env:  WT_NO_TUNNEL=1   skip ngrok (e.g. if you tunnel some other way).

set -u
cd "$(dirname "$0")" || exit 1

# --- config: durable HOME file + local .env (durable survives install.command) ---
DURABLE="$HOME/.watchtogether-relay.env"
[ -f "$DURABLE" ] && { set -a; . "$DURABLE"; set +a; }
[ -f .env ]       && { set -a; . ./.env;   set +a; }
PORT="${PORT:-8787}"

SRV_PID_FILE="$PWD/.server.pid"
NGK_PID_FILE="$PWD/.ngrok.pid"

server_up()   { curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; }
tunnel_pids() { pgrep -f "ngrok http $PORT" 2>/dev/null; }
tunnel_up()   { [ -n "$(tunnel_pids)" ]; }

tunnel_url() {  # current https public_url for OUR port, or empty
  curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null | PORT="$PORT" python3 -c '
import sys, json, os
p = os.environ.get("PORT", "8787")
try:
    d = json.load(sys.stdin); ts = d.get("tunnels", [])
    m = [x for x in ts if (":" + p) in (x.get("config", {}) or {}).get("addr", "")]
    h = [x for x in m if x.get("proto") == "https"] or m
    print(h[0]["public_url"] if h else "")
except Exception:
    print("")
' 2>/dev/null
}

link() {  # best-effort wss:// link (live tunnel URL, else the fixed domain)
  local u; u="$(tunnel_url)"
  [ -z "$u" ] && [ -n "${NGROK_DOMAIN:-}" ] && u="https://$NGROK_DOMAIN"
  [ -n "$u" ] && printf '%s\n' "$u" | sed -e 's#^https://#wss://#' -e 's#^http://#ws://#'
}

up() {
  command -v node >/dev/null 2>&1 || { echo "❌ Node.js not installed — https://nodejs.org"; exit 1; }
  echo "▶️   Bringing the relay up…"

  # --- relay server ---
  if server_up; then
    echo "  • server: already up on :$PORT"
  else
    [ -d node_modules ] || { echo "  • installing deps (first run)…"; npm install --no-audit --no-fund >/dev/null 2>&1; }
    PORT="$PORT" nohup node server.js >server.log 2>&1 &
    echo $! > "$SRV_PID_FILE"
    for _ in $(seq 1 20); do server_up && break; sleep 0.3; done
    if server_up; then echo "  • server: up on :$PORT (pid $(cat "$SRV_PID_FILE"))"
    else echo "  ! server failed to start — see server.log"; fi
  fi

  # --- ngrok tunnel ---
  if [ "${WT_NO_TUNNEL:-}" = "1" ]; then
    echo "  • tunnel: skipped (WT_NO_TUNNEL=1)"
  elif ! command -v ngrok >/dev/null 2>&1; then
    echo "  ! ngrok not installed (brew install ngrok) — tunnel not started"
  elif tunnel_up; then
    echo "  • tunnel: already up"
  else
    if pgrep -f "ngrok http" >/dev/null 2>&1; then
      echo "  ! another ngrok tunnel is running; free ngrok allows only one — stop it or this tunnel can't start"
    fi
    if [ -n "${NGROK_DOMAIN:-}" ]; then
      nohup ngrok http "$PORT" --url="https://$NGROK_DOMAIN" --log=stdout >ngrok.log 2>&1 &
    else
      nohup ngrok http "$PORT" --log=stdout >ngrok.log 2>&1 &
    fi
    echo $! > "$NGK_PID_FILE"
    for _ in $(seq 1 12); do [ -n "$(tunnel_url)" ] && break; sleep 1; done   # brief, non-blocking
    echo "  • tunnel: up (pid $(cat "$NGK_PID_FILE"))"
  fi

  echo ""
  if ! server_up; then
    echo "❌ Relay server did NOT start — see relay-server/server.log, fix it, then: ./relay.command up"
    return 1
  fi
  local l; l="$(link)"
  if [ "${WT_NO_TUNNEL:-}" = "1" ]; then
    echo "✅ Relay server is UP on :$PORT (no tunnel)."
  elif [ -n "$l" ]; then
    echo "✅ Relay is UP. Paste on BOTH computers:"
    echo "       $l"
  else
    echo "⚠️  Server is up, but no tunnel URL yet — check relay-server/ngrok.log (authtoken / one-session limit)."
  fi
  echo "   Running in the background — you can close this window. Stop with:  ./relay.command down"
}

down() {
  echo "🛑  Bringing the relay down…"
  local acted=0 pid
  for pid in $(tunnel_pids); do kill "$pid" 2>/dev/null && acted=1; done
  if [ -f "$NGK_PID_FILE" ]; then kill "$(cat "$NGK_PID_FILE")" 2>/dev/null && acted=1; rm -f "$NGK_PID_FILE"; fi
  if [ -f "$SRV_PID_FILE" ]; then kill "$(cat "$SRV_PID_FILE")" 2>/dev/null && acted=1; rm -f "$SRV_PID_FILE"; fi
  for pid in $(lsof -ti tcp:"$PORT" 2>/dev/null); do kill "$pid" 2>/dev/null && acted=1; done
  [ "$acted" = 1 ] && echo "  • stopped." || echo "  • already down."
}

status() {
  if server_up; then echo "server:  UP on :$PORT"; else echo "server:  down"; fi
  if [ "${WT_NO_TUNNEL:-}" = "1" ]; then
    echo "tunnel:  (disabled)"
  elif tunnel_up; then
    local l; l="$(link)"; echo "tunnel:  UP${l:+   $l}"
  else
    echo "tunnel:  down"
  fi
}

case "${1:-status}" in
  up)          up ;;
  down)        down ;;
  status|"")   status ;;
  restart)     down; sleep 1; up ;;
  *) echo "usage: ./relay.command up|down|status|restart"; exit 2 ;;
esac
