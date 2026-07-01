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

# 4. Optional config from .env -----------------------------------------------
if [ -f .env ]; then set -a; . ./.env; set +a; fi
PORT="${PORT:-8787}"

# 5. Start the relay server --------------------------------------------------
echo "▶️   Starting relay on port $PORT…"
PORT="$PORT" node server.js &
SERVER_PID=$!

NGROK_PID=""
cleanup() {
  echo ""
  echo "🛑  Stopping relay…"
  [ -n "$NGROK_PID" ] && kill "$NGROK_PID" 2>/dev/null || true
  kill "$SERVER_PID" 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

sleep 1

# 6. Open the tunnel ---------------------------------------------------------
if [ -n "$NGROK_DOMAIN" ]; then
  echo "🌐  Opening tunnel on your fixed domain: $NGROK_DOMAIN"
  ngrok http "$PORT" --domain="$NGROK_DOMAIN" --log=stdout >ngrok.log 2>&1 &
else
  echo "🌐  Opening tunnel (random URL — set NGROK_DOMAIN in .env for a link that never changes)…"
  ngrok http "$PORT" --log=stdout >ngrok.log 2>&1 &
fi
NGROK_PID=$!

# 7. Fetch the public URL from ngrok's local API -----------------------------
echo "⏳  Waiting for the tunnel to come up…"
URL=""
for _ in $(seq 1 30); do
  URL=$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null | python3 -c '
import sys, json
try:
    data = json.load(sys.stdin)
    tunnels = data.get("tunnels", [])
    https = [t for t in tunnels if t.get("proto") == "https"] or tunnels
    print(https[0]["public_url"] if https else "")
except Exception:
    print("")
' 2>/dev/null)
  [ -n "$URL" ] && break
  sleep 1
done

if [ -z "$URL" ]; then
  echo "❌  Couldn't read the tunnel URL. Common cause: no ngrok authtoken."
  echo "    Run:  ngrok config add-authtoken <YOUR_TOKEN>   then try again."
  echo "    (Details in ngrok.log)"
  cleanup
fi

# https:// -> wss://   (http:// -> ws://)
WSS="${URL/https:\/\//wss:\/\/}"
WSS="${WSS/http:\/\//ws:\/\/}"

echo ""
echo "======================================================================"
echo "✅  Relay is LIVE."
echo ""
echo "    Paste this into the extension's  \"Relay server\"  box"
echo "    on BOTH computers:"
echo ""
echo "        $WSS"
echo ""
echo "    Keep this window open while you watch. Press Ctrl+C to stop."
echo "======================================================================"
echo ""

# Keep running until the server exits or the user hits Ctrl+C.
wait "$SERVER_PID"
