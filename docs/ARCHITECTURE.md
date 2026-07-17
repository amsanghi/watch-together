# WatchTogether — Architecture

This document explains how the pieces fit together: the process model, the three
transports, the connection/reconnection state machine, media/WebRTC, the panel↔page
contract, and the complete wire protocol. For a file-by-file map and coding conventions
see [../CLAUDE.md](../CLAUDE.md); for the user story see [../README.md](../README.md).

## Process model

WatchTogether is a Chrome MV3 extension made of three JavaScript contexts plus an
optional server:

```
  toolbar icon / Cmd+Shift+Y
        │
        ▼
  ┌─────────────────────────┐        chrome.runtime / chrome.tabs        ┌──────────────────┐
  │  Side Panel (extension   │  ◄──────────────────────────────────────► │  content.js       │
  │  page): sidebar/*.js      │        { __wt:true, kind, … } messages    │  (on the video    │
  │  · all UI + all P2P/relay │                                           │   tab)            │
  │  · one per browser window │                                           │  · owns <video>   │
  │  · persists across tabs   │                                           │  · page effects   │
  └───────────┬─────────────┘                                            └────────┬─────────┘
              │  Trystero / WebSocket relay / RTCDataChannel                        │ window.postMessage
              ▼                                                                     ▼
        the partner's                                                        netflix-inject.js
        side panel                                                           (MAIN world; Netflix API)
```

- **Side panel** (`sidebar/`) holds the UI *and* the connection. Being an extension page,
  `getUserMedia` works on any site, the browser reserves layout space (nothing overlaps
  the video), and the connection survives tab switches and navigation — **one connection
  per window**. `background.js` only opens the panel.
- **`content.js`** runs on the watched tab: it detects and drives the page `<video>`
  (play/pause/seek), renders page effects, and relays between the page and the panel. It
  never talks to the partner directly — everything goes through the panel.
- **`netflix-inject.js`** runs in the page's MAIN world because Netflix plays via MSE and
  must be driven through its own player API (setting `video.currentTime` breaks it).
- **`relay-server/`** is an optional blind WebSocket pipe you host yourself.

## The three transports

The panel abstracts "send to partner" behind `netSend(obj)` (`core/net.js`), which writes
to whichever transport is active. Exactly one is chosen in `connect()` (`core/connection.js`):

1. **Relay** (`transports/relay.js`) — chosen when `settings.relayUrl` is set. A single
   WebSocket to your server carries **all** app data *and* the voice/video call's WebRTC
   signaling (`__rtc` messages). The server groups sockets by `?room=` and blindly forwards;
   its `roster` control message tells each side the partner is present and who initiates.
   Most reliable; see [../relay-server/README.md](../relay-server/README.md).
2. **Trystero** (`transports/trystero.js`) — the default. Serverless rendezvous over public
   relays: both partners join the same room (hash of the shared secret) via two strategies
   (MQTT + BitTorrent) raced in parallel, and connect directly P2P. Data rides a Trystero
   "action"; media rides added tracks. Uses `window.Trystero` (the vendored lib).
3. **Manual** (`transports/manual.js`) — the Advanced escape hatch: base64 copy-paste of
   WebRTC offer/answer, no broker at all. Data rides a raw `RTCDataChannel` (`S.rawDC`).

`S.amInitiator` is derived deterministically (higher peer/roster id) so the two sides agree
on who is the "impolite" peer for WebRTC perfect negotiation and who makes the first move
in the turn-based games — all without a server arbitrating.

## Connection & reconnection state machine

Owned by `core/connection.js`. The hard part is surviving flaky public relays and silent
Wi-Fi drops.

- **Auto-connect on open:** if paired (`settings.paired !== false` and a `pairCode`/
  `relayUrl` exists), `loadSettings()` calls `connect()` immediately — no buttons.
- **`onConnected()`** (once per link): marks connected, starts the heartbeat, shows the
  live panel, then re-sends identity/state to the partner — name, media-state, timezone,
  theme, weather (`syncWeatherOnConnect`), watchlist (`syncWatchlistOnConnect`), and a
  `sync-req` if we're the initiator. Order is preserved from the original.
- **Heartbeat:** every 2.5s we `ping` and check `S.lastRx`. Any received traffic updates
  `lastRx`. If nothing arrives for 8s the link is considered silently dead.
- **Recovery depends on transport.** Relay: just rebuild the socket (cheap). Trystero:
  do a **clean reload** — `hardReconnect()` saves the chat to `sessionStorage`
  (`wt_chat`/`wt_partner`/`wt_reconnecting`), asks the partner to reload too
  (`please-reload`), and `location.reload()`s the panel. On reload, `loadSettings()` sees
  `wt_reconnecting`, restores the chat, and reconnects straight into the live view. A
  12s `wt_reload_at` rate-limit (`recentlyReloaded()`) prevents reload loops; if we
  reloaded too recently we rejoin in place instead.
- **`onDisconnected()`:** partner left — we stay in the room. Relay mode lets the server
  tell us when they're back; Trystero schedules a `connect()` retry with light backoff.
- **Relay fallback & wake recovery:** if the relay socket never opens after a couple of
  tries (host asleep / tunnel down) we switch to the serverless Trystero path
  (`fallbackToTrystero`), reusing any TURN creds the relay already minted (`S.relayIce`) —
  the room seed falls back to the relay URL so relay-only pairs still land together
  privately. And on a network return, tab re-show, or wake-from-sleep (a >12s gap between
  heartbeats) we reconnect immediately (`onNetworkWake`) instead of waiting out the silence.
- **`leaveRoom()`** (on `pagehide`/`beforeunload`, re-pair, or transport switch) tears down
  the relay socket+PC, leaves all Trystero rooms, and clears the send pointer.

## Media / WebRTC

`core/media.js` owns one local `MediaStream`. Mic and cam are acquired **on demand and
independently** (`ensureKind`), start disabled, and are toggled per-track. Tracks are
shared to peers by the transports (`shareAll`/`reshareTo` for Trystero, `addTrack` for
manual, `relayShareLocalTracks` for the relay call). All three transports funnel the
partner's stream into `remoteStreamHandler`. Partner volume lives on `#remote-video`
(the Fun-panel tiles are muted mirrors). The relay call uses **perfect negotiation**
(`relayMakingOffer`/`relayIgnoreOffer`, politeness from `!S.amInitiator`).

The call sends **low-res video** (480×360 @ 24 fps, ~300 kbps sender cap — the tile is
small) which also keeps a free TURN quota comfortable. By default the audio/video flows
**P2P** and only its *signaling* rides the relay, so a restrictive NAT (symmetric/CGNAT)
can break the call while data over the WebSocket stays fine — the usual cause of a
"chat works but the call is flaky" report. TURN fixes it: either paste TURN creds into the
Advanced fields, or — on the self-hosted relay — set `CF_TURN_KEY_ID`/`CF_TURN_API_TOKEN`
in the relay server's env (`~/.watchtogether-relay.env`). The **relay** then mints
short-lived Cloudflare TURN creds (free 1000 GB/mo) and ships them to both clients in its
`roster`; `relayIceServers` (`transports/relay.js`) just reads them off the roster. So the
TURN secret lives only on the relay — never in this public extension — and nothing is
entered per call. When TURN is present the call is **forced through it**
(`iceTransportPolicy: "relay"` in `relayNewPC`), not tried as a direct P2P path first —
trading a little latency for a connection that doesn't hinge on NAT traversal. If the
media path dies mid-call, the app heartbeat can't tell (it only watches
the *data* socket, which stays up), so the relay PC recovers in place via an **ICE restart**
on `iceConnectionState === "failed"`.

Call audio has three optional processors in `core/audioproc.js` (toggled in Settings,
default on, all fail-safe to plain audio): a **mic noise-gate** (VAD on a clone of the mic
track, so the movie on your speakers doesn't constantly bleed to the partner), **auto-duck**
(a panel→page `duck` message quiets the page `<video>` while either side talks), and a
receiver-side **auto-level** compressor (Web Audio `DynamicsCompressorNode`; the `<video>`
element stays the fallback player whenever the `AudioContext` isn't running, so it can't go
silent). One `setInterval` loop (`startAudioLoop`, from `init()`) drives the VAD + routing.

## Shared state

`core/state.js` exports one object **`S`**. It's an import leaf (imports nothing), so it's
fully initialized before any other module's body runs, and it's the single home for every
value shared across modules — connection flags (`connectedOnce`, `amInitiator`, `sendData`,
`rawDC`, `relayMode`, `relayWs`, `entries`, `primary`, `lastRx`, …), media (`localStream`,
`micOn`, `camOn`, `remoteState`, …), and persisted collections that more than one module
touches (`settings`, `counts`, `scrapbook`, `scheduled`, `handSeconds`, `myWeather`, …).
See CLAUDE.md for *why* it's an object and not `export let`s.

## Panel ↔ page contract

Messages are `{ __wt: true, kind, … }` over `chrome.runtime`/`chrome.tabs`.

| Direction | `kind` | Meaning |
|---|---|---|
| page → panel | `video-event` | The page `<video>` fired play/pause/seek/rate; carries `{action,time,rate,paused,url,title}`. |
| page → panel | `video-found` | A controllable `<video>` was found on the tab. |
| page → panel | `video-stall` | The page `<video>` started/stopped buffering → ask the partner to wait. |
| page → panel | `annot` | The user pinged/drew on the video → forward to the partner. |
| page → panel | `hello` | The tab (re)loaded; if it followed a Join, the panel re-syncs it. |
| page → panel | `invite-accepted` | (legacy) partner accepted a page-banner invite. |
| panel → page | `apply-video` | Apply remote play/pause/seek/rate to the page `<video>`. |
| panel → page | `reaction` | Spawn floating hearts over the video. |
| panel → page | `countdown` | Show the 3·2·1 number `n`. |
| panel → page | `poke` | Shake the page + toast. |
| panel → page | `toast` | Show a transient toast. |
| panel → page | `duck` | Lower (to 25%) or restore the page `<video>` volume while someone's talking (auto-duck). |
| panel → page | `drift` | Nudge the follower's `<video>` time toward the initiator's (drift correction). |
| panel → page | `stall` | Pause/resume the page `<video>` while the partner is buffering. |
| panel → page | `annotate` | Enter/exit draw-on-video mode (`on`, `color`). |
| panel → page | `annot-show` | Render a partner's ping/stroke on our overlay. |
| panel → page | `request-state` | Reply with the current `<video>` state (used by `getPageState`). |

## Wire protocol (partner ↔ partner)

Every message is `{ t: <type>, … }` sent via `netSend` and decoded by the single
`handleData` switch in `core/net.js`. Payload fields beyond `t` are shown; the module is
where the handler lives.

| `t` | Payload | Module |
|---|---|---|
| `ping` / `pong` | — | connection (heartbeat liveness) |
| `please-reload` | — | connection (ask partner to clean-reload) |
| `name` | `name` | settings |
| `chat` | `text` | chat |
| `gif` | `url` | chat |
| `typing` | `on` | chat |
| `reaction` | `reaction` | reactions |
| `sfx` | `name` | soundboard (synth sound played on both speakers) |
| `cinema` | `on` | tab (dim everything but the video on both sides) |
| `countdown` | — | reactions |
| `poke` | — | reactions |
| `heartbeat` | — | reactions |
| `greet` | `kind` (`gm`/`gn`) | reactions |
| `kiss-pause` | — | reactions |
| `video` | `action,time,rate,paused,url,title` | tab (apply to page) |
| `pos` | `time,paused` | tab (drift correction — initiator → follower) |
| `stall` | `on` | tab (pause-on-buffer) |
| `annot` | `akind`(`ping`/`draw`),`x`,`y`,`x2`,`y2`,`color` | tab (point & annotate overlay) |
| `sync-req` | — | tab (request page state) |
| `sync-state` | `state` | tab (apply page state) |
| `media-state` | `mic,cam` | media |
| `invite` | `url,title` | invite |
| `invite-ack` | — | invite |
| `profile` | `tz` | stats |
| `mark` | `time,emoji,who,title,url` | timeline |
| `weather` | `temp,code,isDay` | weather |
| `mood` | `mood` | couple |
| `rate` | `value` | couple |
| `watchlist` | `items` | couple |
| `hand` | `on` | couple |
| `letter` | `text` | couple |
| `count` | `kind` (`kiss`/`hug`) | couple |
| `cuddle` | `on` | couple |
| `memory` | `item` | couple |
| `qotd` | `text` | prompts |
| `quiz-q` / `quiz-a` | `q` / `text` | prompts |
| `card` | `kind,text` | prompts |
| `ttt` | `reset` \| `cell,mark` | games |
| `bingo` | `reset`(card) \| `cell` | bingo (shared movie-bingo card) |
| `c4` | `reset` \| `col,color` | games |
| `rps` | `reset` \| `pick` | games |
| `doodle` | `clear` \| `x0,y0,x1,y1,color` | games |
| `emoji-q` / `emoji-a` / `emoji-r` | `deck,i` / `text` / — | games |
| `snap` | `img` | photobooth + chat |
| `clip` | `clip` | photobooth + chat |
| `pb-open` | — | photobooth |
| `pb-set` | `filter,mode,layout,sticker,timer` | photobooth |
| `pb-photo` | `shots,total,sticker,caption` | photobooth |
| `pb-go` | `mode,layout,filter,sticker,timer` | photobooth |
| `__rtc` | `kind` (`sdp`/`ice`), `sdp`/`cand` | relay call signaling |
| `__relay` | `event:"roster",self,peers,count,iceServers?` | **server → client only** (relay-server; `iceServers` = relay-minted TURN) |

Because the relay forwards everything verbatim and never inspects payloads (except its own
`__relay` roster), new message types work with **no server change** — just add a `case` to
`handleData` and a sender in the owning module.
