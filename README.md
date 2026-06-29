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
- **Chat** — messages, a big emoji picker, and **GIF search** (Tenor).
- **Couple extras:**
  - 💗 **Floating hearts & kisses** drift up over the video on both screens.
  - **3·2·1 synced countdown** so you hit play at the exact same moment.
  - **Date-night streak & watch history** — counts your watch nights and keeps a streak.
  - **Typing indicator**, a **poke / "I miss you"** nudge (shakes their screen 💗), and an
    always-on **pulsing presence heart** showing your partner is connected.
- **Dark / cinematic** theme that disappears into a dim movie night.

---

## Install (load unpacked)

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this `watch-together` folder.
4. Pin the 💗 WatchTogether icon to your toolbar.

Do this on **both** computers.

## Use it

1. Open the same video page on both computers (e.g. the same YouTube/Netflix URL).
2. Click the 💗 toolbar icon to open the side panel.
3. **One** of you clicks **Create a room** and shares the 5-letter code.
   The other types it in and clicks **Join**. (Or use the **Manual** tab.)
4. Grant the camera/mic permission prompt (needed for the call — you can stay muted/cam-off).
5. Press play. Send hearts. Enjoy 🍿

> Tip: hit the **3·2·1 ▶** button to start the movie at the exact same second.

## GIFs (optional)

GIF search needs a free Tenor API key:

1. Get one from Google's [Tenor API quickstart](https://developers.google.com/tenor/guides/quickstart).
2. Open the extension → ⚙ **Settings** → paste it into **Tenor GIF API key** → **Save**.

The key is stored only in your browser's local storage. Emojis work without any key.

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
and **Tenor** (only if you add a key and search GIFs). Your watch history and settings never
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
