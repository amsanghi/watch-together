// WatchTogether — shared mutable state (the single source of truth).
//
// This module is an *import leaf*: it imports nothing, so it is fully
// initialized before any importer's body runs. Every value that is read or
// written across more than one module lives here as a property of `S`.
//
// Why one object instead of many `export let`s: an imported `let`/`var`
// binding is read-only in the importing module — only the *defining* module
// may reassign it. Object *properties*, on the other hand, can be reassigned
// from anywhere (`S.connectedOnce = true`), which is exactly what the
// transports, media and feature modules need to do. So all shared mutable
// state is `S.field`.
//
// Feature-local state (game boards, photobooth vars, per-module timers, …)
// deliberately does NOT live here — it stays a module-scoped `let` inside its
// owning module.

// Built-in Giphy key so GIFs work out of the box with no setup.
// (Public repo: this key is intentionally shipped. Regenerate at
// developers.giphy.com if it ever gets abused.)
export const DEFAULT_GIPHY_KEY = "4AV58X7gVu01rrXsHmbiuxsJ9kIBeZIw";

export const S = {
  // ---- Settings (persisted to chrome.storage.local as wt_settings) --------
  settings: {
    me: "You", partner: "Partner", partnerName: "", giphyKey: DEFAULT_GIPHY_KEY,
    autocam: true, named: false, anniversary: "", bdayMe: "", bdayPartner: "",
    petName: "", themeColor: "", volume: 100,
    micGate: true, autoDuck: true, autoLevel: true,
    micGateSens: 65, micGateHold: 700, remoteSens: 75, duckLevel: 25, duckHold: 700, levelStrength: 12,
    relayUrl: "", turnUrl: "", turnUser: "", turnPass: "",
  },
  partnerReal: "Partner",       // partner's actual name; settings.partner = petName || partnerReal

  // ---- Persisted couple counters / collections ----------------------------
  counts: { kiss: 0, hug: 0 },
  scrapbook: [],                // [{text|img, date}]
  scheduled: [],                // [{text, when}] surprise notes still pending
  handSeconds: 0,               // lifetime hand-holding seconds

  // ---- Connection / transport --------------------------------------------
  sendData: null,               // active transport's send(obj); null when offline
  rawDC: null,                  // RTCDataChannel (manual copy-paste mode)
  connectedOnce: false,         // true while a live link is up
  amInitiator: false,           // deterministic role (drives call politeness + game first-move)
  everConnected: false,         // have we connected at least once this session
  pendingPartnerReload: false,  // nudge partner to clean-reload once we relink
  lastRx: 0,                    // Date.now() of last received traffic (heartbeat liveness)

  // Trystero mesh transport (public relays)
  entries: [],                  // [{ name, room, action, connected }]
  primary: null,                // the entry we currently send on
  connectHint: null,            // "still connecting…" hint timer id

  // Relay transport (your own WebSocket server)
  relayMode: false,             // true while the relay transport is the active one
  relayWs: null,                // the WebSocket to your relay server
  relayIce: [],                 // TURN creds the relay minted (shared to both transports)
  relayFellBack: false,         // true after we gave up on the relay and switched to Trystero

  // ---- Media (mic / cam / call) ------------------------------------------
  localStream: null,
  micOn: false,
  camOn: false,
  wantMic: false,               // last-desired mic state (drives permission-safe auto-resume)
  wantCam: false,
  remoteState: { mic: false, cam: false },
  sharedTracks: new Set(),      // local tracks already added to Trystero peers (dedup)

  // ---- Misc cross-module --------------------------------------------------
  myWeather: null,              // {temp, code, isDay}; re-sent on connect
  partnerTz: null,              // partner's UTC offset in minutes
  pendingFollow: false,         // we accepted an invite; re-sync the tab once it loads
};
