// WatchTogether — background service worker (MV3) + routing hub.
// The persistent DATA connection lives in an offscreen document. The side panel
// and content scripts talk to it through here:
//   • content video events  → peer (and peer video → active tab)
//   • panel app data         → peer (and peer app data → panel)
//   • connection status      → panel
// The video sync keeps working even when the panel is closed (background routes
// it straight to the active tab); chat/reactions need the panel open.

// ---- Side panel open triggers ------------------------------------------
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.commands.onCommand.addListener((command) => {
  if (command !== "toggle-panel") return;
  chrome.windows.getCurrent().then((win) => {
    if (win && win.id != null) chrome.sidePanel.open({ windowId: win.id }).catch(() => {});
  });
});

// ---- Offscreen lifecycle ------------------------------------------------
let creating = null;
async function ensureOffscreen() {
  try {
    if (chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) return;
  } catch (_) {}
  if (creating) { await creating; return; }
  try {
    creating = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WEB_RTC"],
      justification: "Keep the watch-party P2P connection alive in the background.",
    });
    await creating;
  } catch (_) {
    /* already exists */
  } finally {
    creating = null;
  }
}
async function startIfPaired() {
  const { wt_settings } = await chrome.storage.local.get("wt_settings");
  if (wt_settings && wt_settings.pairCode) await ensureOffscreen(); // offscreen self-connects from storage
}
chrome.runtime.onStartup.addListener(startIfPaired);
chrome.runtime.onInstalled.addListener(startIfPaired);
startIfPaired();

// ---- Helpers ------------------------------------------------------------
function toOffscreen(data) { chrome.runtime.sendMessage({ wtoff_cmd: "send", data }).catch(() => {}); }
function toPanel(msg) { chrome.runtime.sendMessage({ ...msg }).catch(() => {}); } // panel listens for wtpipe:*
function activeTab(cb) {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    cb(tabs && tabs[0] && tabs[0].id != null ? tabs[0].id : null);
  });
}
function toActiveContent(msg) {
  activeTab((id) => { if (id != null) chrome.tabs.sendMessage(id, { __wt: true, ...msg }, () => void chrome.runtime.lastError); });
}

// ---- Routing ------------------------------------------------------------
const VIDEO_TYPES = { video: 1, "sync-state": 1, "sync-req": 1 };

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  // From offscreen: peer data / status.
  if (msg.wtoff === "recv") {
    const d = msg.data || {};
    if (VIDEO_TYPES[d.t]) {
      if (d.t === "video") toActiveContent({ kind: "apply-video", action: d.action, time: d.time, rate: d.rate, paused: d.paused, url: d.url, title: d.title, fromName: d.fromName });
      else if (d.t === "sync-state" && d.state) toActiveContent({ kind: "apply-video", action: d.state.paused ? "pause" : "play", time: d.state.time, rate: d.state.rate, paused: d.state.paused, url: d.state.url, title: d.state.title });
      else if (d.t === "sync-req") {
        // Answer with this side's current playback state.
        activeTab((id) => {
          if (id == null) return;
          chrome.tabs.sendMessage(id, { __wt: true, kind: "request-state" }, (state) => {
            void chrome.runtime.lastError;
            if (state) toOffscreen({ t: "sync-state", state });
          });
        });
      }
    } else {
      toPanel({ wtpipe: "recv", data: d }); // chat / reactions / fun → panel (if open)
    }
    return;
  }
  if (msg.wtoff === "status") {
    toPanel({ wtpipe: "status", connected: msg.connected, selfId: msg.selfId, peerId: msg.peerId });
    return;
  }

  // From the side panel: outgoing app data, or it just opened.
  if (msg.wtpipe === "send") { toOffscreen(msg.data); return; }
  if (msg.wtpipe === "hello-panel") {
    ensureOffscreen().then(() => chrome.runtime.sendMessage({ wtoff_cmd: "status" }).catch(() => {}));
    return;
  }

  // From a content script (video tab).
  if (msg.__wt === true) {
    if (msg.kind === "video-event") {
      toOffscreen({ t: "video", action: msg.action, time: msg.time, rate: msg.rate, paused: msg.paused, url: msg.url, title: msg.title });
    } else if (msg.kind === "invite-accepted") {
      toOffscreen({ t: "invite-ack" });
    }
    // "hello" and "video-found" are handled by the panel; nothing to do here.
    return;
  }
});
