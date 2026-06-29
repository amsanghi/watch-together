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
FIRST_INSTALL=0
[ -d "$DEST" ] || FIRST_INSTALL=1

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

# Always open Chrome's extensions page so the next step is one click away.
osascript -e 'tell application "Google Chrome" to activate' \
          -e 'tell application "Google Chrome" to open location "chrome://extensions"' >/dev/null 2>&1 || true

if [ "$FIRST_INSTALL" = "1" ]; then
  cat <<EOF

────────────────────────────────────────────────────────────
✅  First-time setup (in the Chrome tab that just opened):

   1. Turn ON  "Developer mode"  (toggle, top-right).
   2. Click  "Load unpacked".
   3. Choose this folder:  $DEST
   4. Pin the 💗 icon to your toolbar.

   Then click the 💗 icon on any video page to start.
────────────────────────────────────────────────────────────
EOF
else
  cat <<EOF

────────────────────────────────────────────────────────────
✅  Updated.  In the chrome://extensions tab that just opened,
    click the ↻ reload icon on the WatchTogether card
    (no need to Load unpacked again).
────────────────────────────────────────────────────────────
EOF
fi
