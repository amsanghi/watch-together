#!/bin/bash
# WatchTogether relay — one click.
# Starts your private relay server and opens an ngrok tunnel to it, then prints
# the wss:// link to paste into the extension's "Relay server" box on BOTH
# computers. Keep this window open while you watch. Double-click to run on macOS.

set -e
cd "$(dirname "$0")"

echo "💞  WatchTogether relay"
echo "----------------------------------------------------------------------"

# 1. Node.js -----------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "❌  Node.js isn't installed."
  echo "    Install the LTS build from https://nodejs.org , then run this again."
  read -r -p "Press Return to close. " _ ; exit 1
fi

# 2. Dependencies (first run only) -------------------------------------------
if [ ! -d node_modules ]; then
  echo "📦  Installing dependencies (first run only)…"
  npm install --no-audit --no-fund
fi

# 3. ngrok -------------------------------------------------------------------
if ! command -v ngrok >/dev/null 2>&1; then
  echo "❌  ngrok isn't installed. Set it up once:"
  echo "      1) brew install ngrok        (or download: https://ngrok.com/download)"
  echo "      2) make a free account, then:"
  echo "         ngrok config add-authtoken <YOUR_TOKEN>"
  echo "    Then run this again."
  read -r -p "Press Return to close. " _ ; exit 1
fi

# 4. Config — kept durable so an installer update can't wipe it --------------
# install.command overwrites this folder with `rsync --delete`, which deletes a
# local .env (it's gitignored). So we ALSO remember settings in a HOME-dir file
# that survives updates, and self-heal a missing .env from it.
DURABLE="$HOME/.watchtogether-relay.env"
[ -f "$DURABLE" ] && { set -a; . "$DURABLE"; set +a; }   # remembered settings
[ -f .env ]       && { set -a; . ./.env;   set +a; }     # local .env overrides
PORT="${PORT:-8787}"
export PORT
# Remember the domain durably, and recreate .env if an update wiped it.
if [ -n "$NGROK_DOMAIN" ]; then
  printf 'PORT=%s\nNGROK_DOMAIN=%s\n' "$PORT" "$NGROK_DOMAIN" > "$DURABLE"
  if [ ! -f .env ]; then
    printf 'PORT=%s\nNGROK_DOMAIN=%s\n' "$PORT" "$NGROK_DOMAIN" > .env
    echo "♻️   Restored relay-server/.env from $DURABLE (NGROK_DOMAIN=$NGROK_DOMAIN)"
  fi
fi

SERVER_PID=""
NGROK_PID=""
cleanup() {
  [ -n "$NGROK_PID" ] && kill "$NGROK_PID" 2>/dev/null || true
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
}
trap 'echo; echo "🛑  Stopping relay…"; cleanup; exit 0' INT TERM

# 5. If our own relay is already on this port (a previous run), restart it. ---
if lsof -ti tcp:"$PORT" >/dev/null 2>&1; then
  if curl -fsS "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"ok"'; then
    echo "⚠️   A relay is already running on port $PORT — restarting it cleanly."
    lsof -ti tcp:"$PORT" 2>/dev/null | xargs kill 2>/dev/null || true
    sleep 1
  else
    echo "❌  Port $PORT is used by another program. Put a line  PORT=8788  in .env"
    echo "    (or free the port) and run again."
    read -r -p "Press Return to close. " _ ; exit 1
  fi
fi

# 6. Start the relay ---------------------------------------------------------
echo "▶️   Starting relay on port $PORT…"
node server.js &
SERVER_PID=$!

# 7. Wait until it's actually listening (fail loudly otherwise) --------------
UP=""
for _ in $(seq 1 20); do
  curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && { UP=1; break; }
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 0.3
done
if [ -z "$UP" ]; then
  echo "❌  The relay didn't come up on port $PORT (see the error above)."
  cleanup; read -r -p "Press Return to close. " _ ; exit 1
fi

# 8. ngrok free = ONE tunnel at a time. Warn if another is already running. --
if curl -s http://127.0.0.1:4040/api/tunnels >/dev/null 2>&1; then
  if ! curl -s http://127.0.0.1:4040/api/tunnels | grep -q ":$PORT\""; then
    echo "⚠️   Another ngrok tunnel is already running (not the relay)."
    echo "     Free ngrok allows only ONE at a time — stop the other one first,"
    echo "     or this relay can't get a public link."
  fi
fi

# 9. Open the tunnel ---------------------------------------------------------
if [ -n "$NGROK_DOMAIN" ]; then
  echo "🌐  Opening tunnel on your fixed domain: $NGROK_DOMAIN"
  ngrok http "$PORT" --url="https://$NGROK_DOMAIN" --log=stdout >ngrok.log 2>&1 &
else
  echo "🌐  Opening tunnel (random URL — set NGROK_DOMAIN in .env for a link that never changes)…"
  ngrok http "$PORT" --log=stdout >ngrok.log 2>&1 &
fi
NGROK_PID=$!

# 10. Read the public URL for OUR port from ngrok's local API ----------------
echo "⏳  Waiting for the tunnel to come up…"
URL=""
for _ in $(seq 1 30); do
  URL=$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null | PORT="$PORT" python3 -c '
import sys, json, os
port = os.environ.get("PORT", "8787")
try:
    data = json.load(sys.stdin); tunnels = data.get("tunnels", [])
    mine = [t for t in tunnels if (":" + port) in (t.get("config", {}) or {}).get("addr", "")]
    cand = mine or tunnels
    https = [t for t in cand if t.get("proto") == "https"] or cand
    print(https[0]["public_url"] if https else "")
except Exception:
    print("")
' 2>/dev/null)
  [ -n "$URL" ] && break
  sleep 1
done

if [ -z "$URL" ]; then
  echo "❌  Couldn't get a tunnel URL. Usual causes: no authtoken, or another"
  echo "    ngrok session is already running (free ngrok = one at a time)."
  echo "    Fix:  ngrok config add-authtoken <TOKEN>  and stop other ngroks. (see ngrok.log)"
  cleanup; read -r -p "Press Return to close. " _ ; exit 1
fi

# https:// -> wss://  (http:// -> ws://).  Done with sed so the link is clean.
WSS=$(printf '%s' "$URL" | sed -e 's#^https://#wss://#' -e 's#^http://#ws://#')

echo ""
echo "======================================================================"
echo "✅  Relay is LIVE."
echo ""
echo "    Paste this EXACT link into the extension's  \"Relay server\"  box"
echo "    on BOTH computers:"
echo ""
echo "        $WSS"
echo ""
echo "    Keep this window open while you watch. Press Ctrl+C to stop."
echo "======================================================================"
echo ""

wait "$SERVER_PID"
