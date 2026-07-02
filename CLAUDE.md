# CLAUDE.md — working in the WatchTogether repo

WatchTogether is a **Chrome MV3 extension** that lets two people watch any web video
in sync, with chat, voice/video, and a pile of "couple" extras — peer-to-peer, no
account, no backend. There's also an optional self-hosted WebSocket relay for a more
reliable connection. For the user-facing story (install, features, pairing), see
[README.md](README.md). This file is the map for **changing the code**.

## How it runs (read this first)

- **No build step. No bundler. No `npm install` to run the extension.** It is loaded
  *unpacked* directly from source (the installer just downloads the repo zip). Whatever
  you write must run natively in the browser.
- The side-panel app is therefore plain **native ES modules** (`<script type="module">`).
  Split files freely with `import`/`export`; do **not** introduce a build tool.
- **Content scripts can't be ES modules** in MV3. `content.js` and `netflix-inject.js`
  are declared in the manifest and stay classic `<script>`s (no `import`). `background.js`
  (the service worker) is also plain.
- `lib/trystero.js` is a **14k-line vendored/generated** file. **Never edit it.** It's a
  classic script that sets the global `window.Trystero`.

## Where things live

```
manifest.json          MV3 manifest (side_panel + content scripts). Usually no change needed.
background.js          Service worker: opens the side panel on icon click / shortcut. Tiny.
content.js             Content script: controls the page <video> + page effects; talks to
                       the panel over chrome messaging. Classic script (not a module).
netflix-inject.js      MAIN-world content script: drives Netflix's player API. Classic.
content.css            Styles for the page effects (hearts, countdown, toast, shake).
lib/trystero.js        Vendored Trystero (serverless P2P). DO NOT EDIT.
icons/                 Heart icons.
relay-server/          Optional self-hosted WebSocket relay (Node). Its own README.
sidebar/               THE SIDE-PANEL APP (all the interesting logic) — see below.
docs/ARCHITECTURE.md   Transports, reconnection, media, and the full wire-protocol table.
```

### The side-panel app (`sidebar/`)

`sidebar/sidebar.html` loads `../lib/trystero.js` (classic) then `main.js` (module). The
JS is split into small modules by responsibility. **To find the code for X, start here:**

| Module | Owns |
|---|---|
| `main.js` | Entry point. Imports everything; `init()` wires all DOM listeners + starts timers + loads storage. No logic. |
| `core/dom.js` | `$(id)` = `getElementById`. |
| `core/state.js` | The shared mutable state object **`S`** + `DEFAULT_GIPHY_KEY`. Import leaf. |
| `core/ui.js` | `showPanel`, `setStatus`, `showError`. |
| `core/settings.js` | Load/save `wt_settings`, first-run name gate, theme (`applyTheme`/`shade`), applying the partner's name/theme. |
| `core/net.js` | `netSend(obj)` + the central **`handleData(d)` switch** — the one place the wire protocol is decoded. |
| `core/connection.js` | `connect`/`leaveRoom`, connected/disconnected, heartbeat, reconnect, clean-reload, pairing/unpair. |
| `core/tab.js` | `parentPost`, `getPageState`, and the content-script message listener (panel ↔ page). |
| `core/media.js` | Mic/cam, `getUserMedia`, volume, the camera tiles, `remoteStreamHandler`. |
| `transports/trystero.js` | Default transport: serverless P2P over public relays (`window.Trystero`). Sets `S.amInitiator`. |
| `transports/relay.js` | Your-own-server transport: one WebSocket for data **and** the call's WebRTC (perfect negotiation). |
| `transports/manual.js` | Copy-paste WebRTC fallback (no broker). |
| `features/chat.js` | Messages, typing indicator, emoji picker, Giphy search. `addSys()`/`addMsg()` live here. |
| `features/reactions.js` | Floating hearts, 3·2·1 countdown, poke, kiss-pause, heartbeat buzz, greetings, webcam snap. |
| `features/invite.js` | "Watch this together" invite banner + accept flow. |
| `features/stats.js` | Watch count/streak/history, days-together, partner clock. Exports `todayStr`. |
| `features/weather.js` | "Same sky" weather (Open-Meteo). |
| `features/timeline.js` | Bookmarked movie moments (jump back together). |
| `features/couple.js` | Mood, star ratings, watchlist, hold-hands, kiss/hug counters, love letters, scheduled notes, cuddle mode, scrapbook. |
| `features/prompts.js` | Question of the day, quiz, love jar, the spicy card decks (data-heavy). |
| `features/games.js` | Tic-tac-toe, Connect 4, rock-paper-scissors, shared doodle, guess-the-emoji. |
| `features/photobooth.js` | Photobooth capture/stitch/clip + the shared gallery. |

## Conventions (follow these — they're what keeps the split working)

1. **Shared state is `S.field`, on `core/state.js`.** Anything read/written by more than
   one module is a property of the exported `S` object. Read and write it directly
   (`S.connectedOnce = true`). Do **not** `export let` mutable state — an imported `let`
   is read-only in the importer; only object *properties* can be reassigned across
   modules. Feature-local state (game boards, photobooth vars, per-module timers) stays a
   plain module-scoped `let` inside its own file.
2. **Keep `function` declarations** (not `const foo = () =>`). They hoist, which the
   call-before-define style relies on. `export function`, `export const` for data.
3. **`window.Trystero`, never bare `Trystero`.** In a module the bare name is undefined.
4. **`init()` in `main.js` owns all side effects** — every `addEventListener`, the
   `setInterval`s, the `pagehide`/`beforeunload` handlers, the content-script listener.
   No module runs cross-module code at import time (that's what keeps import cycles safe).
5. **All partner traffic goes through `handleData` in `core/net.js`.** It stamps
   `S.lastRx` first, handles `ping`/`pong`/`please-reload`, then a `switch (d.t)` that
   calls into the owning feature module.

### Adding a new wire message (`d.t` type)
1. Send it from the feature: `netSend({ t: "myThing", ... })`.
2. Add a `case "myThing":` in `core/net.js` that calls an exported handler in the owning
   feature module (import it at the top of `net.js`).
3. If it's state the partner should get on (re)connect, add a `syncXOnConnect()` export
   and call it from `onConnected()` in `core/connection.js`.
4. Document it in the protocol table in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Adding a new Fun-panel feature
1. Add the markup to `sidebar/sidebar.html` and styles to `sidebar/sidebar.css`.
2. Create/extend a module in `sidebar/features/`; export its render + action functions.
3. Wire its buttons in `main.js` `init()`; refresh it in `openFun()` if it shows state.
4. Keep its state module-local unless the partner or another module needs it.

## Verifying a change

There are no automated tests. To sanity-check a refactor without a browser:
- **Syntax:** `node --check --input-type=module < sidebar/core/net.js` (per file).
- **Load smoke test:** the module graph should import and `init()` should run with stubbed
  browser globals — a good catch-all for bad imports / undefined calls.

To actually see it work you must **load it in Chrome**: `chrome://extensions` →
Developer mode → **Load unpacked** → this folder (or reload the card if already loaded) →
open the side panel. Watch the panel's console for errors. The full two-browser flow
(pairing, sync, calls) needs a second browser/partner and can't be exercised solo.

## Extension ↔ page contract (quick reference)

The panel and the page's `content.js` speak `chrome.runtime`/`chrome.tabs` messages tagged
`{ __wt: true, kind, ... }`:
- **page → panel:** `video-event`, `video-found`, `hello`, `invite-accepted`.
- **panel → page:** `apply-video`, `reaction`, `countdown`, `poke`, `toast`, `request-state`.

`chrome.storage.local` keys: `wt_settings`, `wt_media`, `wt_stats`, `wt_watchlist`,
`wt_counts`, `wt_scrapbook`, `wt_scheduled`, `wt_hands`, `wt_weather`, `wt_timeline`,
`wt_gallery`. `sessionStorage` (clean-reload reconnect): `wt_reconnecting`, `wt_chat`,
`wt_partner`, `wt_reload_at`.

## Releasing

Push to `main` is blocked — branch, open a PR, and `gh pr merge`. Ship a build with
`gh release create` attaching `watch-together-X.Y.Z.zip` (bump `version` in
`manifest.json`). The one-line installer pulls the latest `main` zipball.
