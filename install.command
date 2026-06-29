#!/bin/bash
# WatchTogether — one-click installer for macOS.
# Run it either way:
#   • Double-click this file in Finder, or
#   • Paste in Terminal:
#       curl -fsSL https://raw.githubusercontent.com/amsanghi/watch-together/main/install.command | bash
#
# It downloads the latest version from GitHub and opens everything so you can
# load it into Chrome. Re-run any time to update.

set -e

REPO="amsanghi/watch-together"
DEST="$HOME/WatchTogether"
URL="https://github.com/$REPO/archive/refs/heads/main.zip"
TMP="$(mktemp -d)"

echo ""
echo "💗  Installing WatchTogether…"
echo "    Downloading the latest version from GitHub…"
curl -fsSL "$URL" -o "$TMP/wt.zip"

echo "    Unpacking…"
unzip -q "$TMP/wt.zip" -d "$TMP"
mkdir -p "$DEST"

if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete "$TMP/watch-together-main/" "$DEST/"
else
  cp -R "$TMP/watch-together-main/." "$DEST/"
fi
rm -rf "$TMP"

echo "    Installed to: $DEST"

# Open Chrome on the extensions page (best effort).
osascript -e 'tell application "Google Chrome" to activate' \
          -e 'tell application "Google Chrome" to open location "chrome://extensions"' >/dev/null 2>&1 || true

# Reveal the folder in Finder so you can drag it in.
open "$DEST" >/dev/null 2>&1 || true

cat <<'EOF'

────────────────────────────────────────────────────────────
✅  Almost done — one-time setup in the Chrome tab that opened:

   1. Turn ON  "Developer mode"  (toggle, top-right).
   2. Click  "Load unpacked".
   3. Select the  WatchTogether  folder that just opened in Finder.
   4. Pin the 💗 icon to your toolbar.

   That's it — click the 💗 icon on any video page to start.

🔄  To UPDATE later: run this installer again, then click the
    ↻ reload icon on the WatchTogether card in chrome://extensions.
────────────────────────────────────────────────────────────
EOF
