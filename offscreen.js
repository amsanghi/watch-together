// WatchTogether — offscreen document.
// Holds the persistent P2P DATA connection (chat, sync, reactions, etc.) over
// Trystero, so it stays alive even when the side panel is closed. It's a dumb
// pipe: relays peer data and status to the background, and sends what the
// background tells it. Media (webcam/voice) is NOT here — that lives in the
// side panel when it's open.

(() => {
  "use strict";
  let entries = [];   // [{ name, room, action, connected }]
  let primary = null;
  let curCode = null;

  function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }
  function roomId(code) { return "wtdata" + hashStr((code || "").trim().toLowerCase()); }

  function leave() {
    entries.forEach((e) => { try { e.room.leave(); } catch (_) {} });
    entries = []; primary = null;
  }
  function repoint() {
    const live = entries.find((e) => e.connected);
    primary = live || null;
  }
  function status() {
    const live = !!(primary && primary.connected);
    chrome.runtime.sendMessage({
      wtoff: "status",
      connected: live,
      selfId: (typeof Trystero !== "undefined" && Trystero.selfId) ? String(Trystero.selfId) : "",
      peerId: live && primary.peerId ? String(primary.peerId) : "",
    }).catch(() => {});
  }

  function connect(code) {
    if (!code) return;
    if (typeof Trystero === "undefined") return;
    leave();
    curCode = code;
    const rid = roomId(code);
    const cfg = { appId: "watchtogether-data", relayConfig: { redundancy: 6 } };
    const strategies = [
      { name: "mqtt", join: Trystero.mqtt && Trystero.mqtt.joinRoom },
      { name: "torrent", join: Trystero.torrent && Trystero.torrent.joinRoom },
    ];
    strategies.forEach((s) => {
      if (typeof s.join !== "function") return;
      let r;
      try { r = s.join(cfg, rid); } catch (_) { return; }
      const action = r.makeAction("m");
      const entry = { name: s.name, room: r, action, connected: false, peerId: null };
      action.onMessage = (data) => chrome.runtime.sendMessage({ wtoff: "recv", data }).catch(() => {});
      r.onPeerJoin = (pid) => { entry.connected = true; entry.peerId = pid; if (!primary) repoint(); status(); };
      r.onPeerLeave = () => {
        entry.connected = false;
        if (!entries.some((e) => e.connected)) { primary = null; status(); }
        else if (primary === entry) { repoint(); }
      };
      entries.push(entry);
    });
  }

  function send(data) { if (primary) { try { primary.action.send(data); } catch (_) {} } }

  // Commands from the background.
  chrome.runtime.onMessage.addListener((m) => {
    if (!m || !m.wtoff_cmd) return;
    if (m.wtoff_cmd === "connect") connect(m.pairCode);
    else if (m.wtoff_cmd === "disconnect") { leave(); curCode = null; status(); }
    else if (m.wtoff_cmd === "send") send(m.data);
    else if (m.wtoff_cmd === "status") status();
  });

  // Self-initialize from stored pairing, and react to pair/unpair changes.
  chrome.storage.local.get(["wt_settings"], (r) => {
    const code = r && r.wt_settings && r.wt_settings.pairCode;
    if (code) connect(code);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.wt_settings) return;
    const code = changes.wt_settings.newValue && changes.wt_settings.newValue.pairCode;
    if (code && code !== curCode) connect(code);
    else if (!code) { leave(); curCode = null; status(); }
  });
})();
