# WatchTogether 💞

A Chrome extension to watch **any** video on the web together, perfectly in sync —
with chat, emojis, GIFs, voice & video calling, and a handful of cute couple extras.

Built for two people. **No backend, no account, no server to run** — everything is
peer-to-peer over WebRTC.

---

## Features

- **Universal video sync** — works on any site with an HTML5 `<video>` (YouTube, Netflix,
  Disney+, plain `.mp4`, etc.). **Either** person can play / pause / seek and it stays in sync.
- **Two ways to connect, both serverless:**
  - **Quick (room code):** one of you creates a room and shares a 5-letter code. Uses
    PeerJS's free public signaling broker — you don't run or pay for anything.
  - **Manual (no broker):** truly zero third-party. Create an invite, paste it to your
    partner over text/Signal, paste their reply back. Uses Google's public STUN only.
- **Voice & video call** — webcam tiles docked in the sidebar, or pop out into a draggable
  floating bubble. Starts muted with camera off; toggle each on when you're ready.
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

Do this on **both** computers. Pick whichever is easier for you:

### Easiest — one-line installer (macOS)
Open **Terminal** and paste:
```bash
curl -fsSL https://raw.githubusercontent.com/amsanghi/watch-together/main/install.command | bash
```
It downloads the latest version, opens Chrome's extensions page and the folder for you,
then tells you the final 3 clicks. Re-run it any time to update.

### No Terminal — download & drop
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

## GIFs

GIF search works out of the box — a Giphy API key is built in, so there's nothing to set up.

Optionally, use your own key (for your own quota): sign up at
[developers.giphy.com](https://developers.giphy.com) → **Create an App** → choose **API** → copy
the key → extension → ⚙ **Settings** → **Giphy API key** → **Save**. It's stored only in your
browser's local storage and overrides the built-in key.

---

## How it works

```
toolbar click ─▶ background.js ─▶ content.js (injected on every page)
                                     │
        ┌────────────────────────────┼─────────────────────────────┐
        ▼                            ▼                              ▼
  controls the page <video>   floating-heart / countdown /    injects the sidebar
  (play/pause/seek sync)      poke overlays on the page        iframe (the app UI)
                                                                     │
                                              sidebar.js (PeerJS broker OR raw WebRTC)
                                              chat · GIFs · webcam · couple features
```

- The whole UI and all WebRTC live inside an **extension-origin iframe** so `getUserMedia`
  works regardless of the host site's permissions policy.
- The content script owns the page's `<video>` and forwards play/pause/seek events to the
  iframe, which relays them to the partner over the WebRTC data channel (and vice-versa).
  Remote-applied actions are echo-guarded so they don't loop.

## Limitations

- Both people need to open the **same** video URL — the extension syncs playback state, it
  does **not** stream the video itself (so it respects each service's DRM/login).
- Videos embedded in a **cross-origin iframe** on a page can't be controlled (browser
  security). Most sites — YouTube, Netflix, direct video files — keep the player in the main
  frame and work fine.
- The "Quick" room mode depends on PeerJS's free public broker being up. If it's ever down,
  use the **Manual** tab — it has no third-party dependency at all.

## Privacy

There is no backend. Chat, video and voice flow directly between the two browsers. The only
third parties are the **PeerJS broker** (used once to introduce the two browsers in Quick
mode; no media flows through it), **Google STUN** (helps the two browsers find each other),
and **Giphy** (only if you add a key and search GIFs). Your watch history and settings never
leave your own browser.

## Project layout

```
watch-together/
├── manifest.json        # MV3 manifest
├── background.js        # toolbar click → toggle panel
├── content.js           # video control + page effects + iframe bridge
├── content.css          # injected wrapper / overlay styles
├── sidebar/
│   ├── sidebar.html     # the app UI
│   ├── sidebar.css      # dark/cinematic theme
│   └── sidebar.js       # connection, chat, media, couple features
├── lib/peerjs.min.js    # vendored PeerJS (no remote code, MV3-safe)
└── icons/               # generated heart icons
```

Made with 💗
