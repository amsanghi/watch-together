// WatchTogether — offscreen document.
// Holds the persistent P2P DATA connection (chat, sync, reactions, etc.) over
// Trystero, so it stays alive even when the side panel is closed. It's a dumb
// pipe driven entirely by the background (offscreen docs don't get chrome.storage
// or most APIs — only chrome.runtime messaging). Media lives in the side panel.

(() => {
  "use strict";
  let entries = [];   // [{ name, room, action, connected, peerId }]
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
  function repoint() { primary = entries.find((e) => e.connected) || null; }
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
    if (!code || typeof Trystero === "undefined") return;
    if (code === curCode && entries.length) { status(); return; } // already on this code
    leave();
    curCode = code;
    const rid = roomId(code);
    const cfg = { appId: "watchtogether-data", relayConfig: { redundancy: 6 } };
    [["mqtt", Trystero.mqtt], ["torrent", Trystero.torrent]].forEach(([name, strat]) => {
      if (!strat || !strat.joinRoom) return;
      let r;
      try { r = strat.joinRoom(cfg, rid); } catch (_) { return; }
      const action = r.makeAction("m");
      const entry = { name, room: r, action, connected: false, peerId: null };
      action.onMessage = (data) => chrome.runtime.sendMessage({ wtoff: "recv", data }).catch(() => {});
      r.onPeerJoin = (pid) => { entry.connected = true; entry.peerId = pid; if (!primary) repoint(); status(); };
      r.onPeerLeave = () => {
        entry.connected = false;
        if (!entries.some((e) => e.connected)) { primary = null; status(); }
        else if (primary === entry) repoint();
      };
      entries.push(entry);
    });
  }
  function send(data) { if (primary) { try { primary.action.send(data); } catch (_) {} } }

  chrome.runtime.onMessage.addListener((m) => {
    if (!m || !m.wtoff_cmd) return;
    if (m.wtoff_cmd === "connect") connect(m.pairCode);
    else if (m.wtoff_cmd === "disconnect") { leave(); curCode = null; status(); }
    else if (m.wtoff_cmd === "send") send(m.data);
    else if (m.wtoff_cmd === "status") status();
  });

  // Tell the background we're loaded so it sends us the pair code to connect.
  chrome.runtime.sendMessage({ wtoff: "ready" }).catch(() => {});
})();
