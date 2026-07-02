# WatchTogether 💞

A Chrome extension to watch **any** video on the web together, perfectly in sync —
with chat, emojis, GIFs, voice & video calling, and a handful of cute couple extras.

Built for two people. **No backend, no account, no server to run** — everything is
peer-to-peer over WebRTC.

---

## Features

- **Universal video sync** — works on any site with an HTML5 `<video>` (YouTube, Netflix,
  Disney+, plain `.mp4`, etc.). **Either** person can play / pause / seek and it stays in sync.
- **Pair once, then auto-connect — no server, no broker to run:**
  - **Pairing:** you both type the same secret word once. You then join the same room over
    **Trystero** (serverless rendezvous over public relays) and connect directly P2P. No
    server to host, no account, no room codes after pairing.
  - **Manual (Advanced):** truly zero third-party — create an invite, paste it to your
    partner over text/Signal, paste their reply back. Uses Google's public STUN only.
- **Voice & video call** — webcam tiles in the side panel. Starts muted with camera off;
  toggle each on when you're ready.
- **Chat** — messages, a big emoji picker, and **GIF search** (Giphy).
- **Couple extras:**
  - 💗 **Floating hearts & kisses** drift up over the video on both screens.
  - **3·2·1 synced countdown** so you hit play at the exact same moment.
  - **Date-night streak & watch history** — counts your watch nights and keeps a streak.
  - **Typing indicator**, a **poke / "I miss you"** nudge (shakes their screen 💗), and an
    always-on **pulsing presence heart** showing your partner is connected.
- **Dark / cinematic** theme that disappears into a dim movie night.

---

## Install

Works on **Chrome 114+ (Windows, macOS, Linux)** — it uses Chrome's Side Panel. The
one-line installer below is macOS-only; on **Windows**, use the "download & drop" method.

Do this on **both** computers. Pick whichever is easier for you:

### Easiest — one-line installer (macOS)
Open **Terminal** and paste:
```bash
curl -fsSL "https://raw.githubusercontent.com/amsanghi/watch-together/main/install.command?$(date +%s)" | bash
```
It downloads the latest version, opens Chrome's extensions page and the folder for you,
then tells you the final 3 clicks. Re-run it any time to update.

### No Terminal — download & drop (works on Windows too)
1. Download the latest **[`watch-together.zip`](https://github.com/amsanghi/watch-together/releases/latest)** from the Releases page and unzip it.
2. Open `chrome://extensions`, turn on **Developer mode** (top-right).
3. Click **Load unpacked** and choose the unzipped `watch-together` folder
   (or just **drag the folder onto the page**).
4. Pin the 💗 WatchTogether icon to your toolbar.

### For developers — clone & pull
```bash
git clone https://github.com/amsanghi/watch-together.git
```
Load unpacked from the folder; `git pull` + ↻ reload to update.

## Use it

**Pair once (first time only):** open the 💗 panel on both computers and type the
**same secret word** into the pairing box (e.g. `usforever`). That's it — from then on
you auto-connect every time, with no codes and no rejoining, even after refreshing or
switching pages.

**Then just watch:**
1. Open a video on your side and press play.
2. Your partner gets a **"💗 … is watching … — Join ▶"** banner; one click takes them to
   the same video at your exact timestamp. (They don't even need to be on the page first —
   just have the panel open.)
3. Either of you can play / pause / seek; it stays in sync. Send chat, hearts, GIFs.

> Tips: grant the camera/mic prompt once for voice/video (you can stay muted/cam-off). Hit
> **3·2·1 ▶** to start together on the same second. Minimize the panel with **–** and bring
> it back with the toolbar icon or **Cmd/Ctrl+Shift+Y**.

There's also an **Advanced** option under the pairing box for a fully broker-free,
copy-paste connection if you ever want it.

## Rock-solid mode: your own relay (recommended if it keeps dropping)

The default pairing finds your partner over **public** relays, which can be flaky —
that's usually what's behind a connection that drops or won't reconnect. You can
instead run **your own tiny relay** on one computer and point both extensions at it.
Then **everything** — play/pause/seek sync, chat, reactions, and the voice/video
call setup — goes through that one link. No public relays, no "find each other".

1. On one computer, start the relay and tunnel it with a fixed link:
   ```bash
   cd relay-server
   ./start.command
   ```
   (First-time setup — Node + a free ngrok account — is in **[`relay-server/README.md`](relay-server/README.md)**.)
   It prints a `wss://…` link.
2. In the extension on **both** computers, paste that `wss://…` link into the new
   **Relay server** box, type the same secret word (or leave it blank), and
   **Pair & connect**.

To switch back to the public relays, clear the Relay server box and unpair.

> The call's audio/video flows peer-to-peer by default (only its *setup* uses the
> relay — which is what fixes the drops). To route the call's media through a
> server too, run a TURN server and fill in the optional TURN fields; details in
> [`relay-server/README.md`](relay-server/README.md).

## GIFs

GIF search works out of the box — a Giphy API key is built in, so there's nothing to set up.

Optionally, use your own key (for your own quota): sign up at
[developers.giphy.com](https://developers.giphy.com) → **Create an App** → choose **API** → copy
the key → extension → ⚙ **Settings** → **Giphy API key** → **Save**. It's stored only in your
browser's local storage and overrides the built-in key.

---

## How it works

```
toolbar icon / Cmd+Shift+Y ─▶ Chrome Side Panel (sidebar.html + main.js modules)
                              · one per window, persists across tabs/navigation
                              · holds the Trystero connection (auto-pairing) + UI
                                     │  chrome messaging
                                     ▼
                              content.js (on the video tab)
                              · controls the page <video> (play/pause/seek sync)
                              · floating hearts / countdown / poke / "Join" banner
```

- The UI + all WebRTC live in Chrome's **side panel** (an extension page), so `getUserMedia`
  works on any site, the browser **reserves space** for it (no overlap on any site), and the
  connection **persists across tab switches and navigation** — one connection per window.
- The content script owns the page's `<video>` and relays play/pause/seek to the side panel
  over `chrome` messaging; the panel relays to the partner over the WebRTC data channel (and
  vice-versa). Remote-applied actions are echo-guarded so they don't loop.

## Limitations

- Both people need to open the **same** video URL — the extension syncs playback state, it
  does **not** stream the video itself (so it respects each service's DRM/login).
- Videos embedded in a **cross-origin iframe** on a page can't be controlled (browser
  security). Most sites — YouTube, Netflix, direct video files — keep the player in the main
  frame and work fine.
- Pairing uses public **Trystero** relays for the initial handshake. If they're ever
  unreachable, hit **🔄 Reconnect**, or use the **Advanced** (manual copy-paste) option,
  which has no third-party dependency at all.

## Privacy

There is no backend. Chat, video and voice flow directly between the two browsers. The only
third parties are the **public relays Trystero uses** (only to introduce the two browsers;
no media or messages flow through them — those go peer-to-peer), **Google STUN** (helps the
two browsers find each other), and **Giphy** (only if you add a key and search GIFs). Your
watch history and settings never leave your own browser.

## Project layout

```
watch-together/
├── manifest.json        # MV3 manifest (side panel + content scripts)
├── background.js        # opens the side panel on icon click / shortcut
├── content.js           # controls the page <video> + page effects (talks to the panel)
├── netflix-inject.js    # MAIN-world bridge to Netflix's player API
├── content.css          # page-effect styles
├── sidebar/             # the side-panel app — native ES modules, no build step
│   ├── sidebar.html     #   markup; loads main.js as a module
│   ├── sidebar.css      #   dark/cinematic theme
│   ├── main.js          #   entry point: wires the UI to the modules
│   ├── core/            #   state, networking, connection, media, settings, panels
│   ├── transports/      #   trystero (P2P) · relay (your server) · manual (copy-paste)
│   └── features/        #   chat, reactions, games, photobooth & the couple extras
├── lib/trystero.js      # vendored Trystero (serverless P2P, MV3-safe) — do not edit
├── relay-server/        # optional: your own WebSocket relay + one-click ngrok launcher
└── icons/               # generated heart icons
```

**Contributing?** See **[CLAUDE.md](CLAUDE.md)** for the module map and coding conventions,
and **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the transports, the
connection/reconnection logic, and the full wire protocol.

Made with 💗
