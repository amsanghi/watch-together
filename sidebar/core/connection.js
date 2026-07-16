// WatchTogether — connection lifecycle & pairing. Owns connect()/leaveRoom(),
// the connected/disconnected transitions, the app-level heartbeat that catches
// silent drops, the clean-reload reconnect (preserving chat via sessionStorage),
// and the pairing/unpair UI actions. It coordinates all three transports but
// doesn't implement them — it delegates to transports/*.
//
// Exports: roomId, connect, onConnected, onDisconnected, scheduleReconnect,
//   startHeartbeat, stopHeartbeat, repointSend, leaveRoom, saveChatState,
//   restoreChat, hardReconnect, recentlyReloaded, showPairStatus, startPairing,
//   forceReconnect, unpair.

import { $ } from "./dom.js";
import { S } from "./state.js";
import { setStatus, showError, showPanel } from "./ui.js";
import { netSend, flushOutbox } from "./net.js";
import { addSys } from "../features/chat.js";
import { recordSession } from "../features/stats.js";
import { connectTrystero } from "../transports/trystero.js";
import { connectRelay, teardownRelay } from "../transports/relay.js";
import { syncWeatherOnConnect } from "../features/weather.js";
import { syncWatchlistOnConnect } from "../features/couple.js";

// ---- Pairing identity (shared secret → room id) -------------------------
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
// Room seed: the shared secret if set, else the relay link (both sides share it) —
// so relay-only pairs still land in the same, and private, Trystero fallback room.
export function roomId() {
  const seed = (S.settings.pairCode || "").trim().toLowerCase() || (S.settings.relayUrl || "").trim().toLowerCase();
  return "wt" + hashStr(seed);
}

// ---- Connect (chooses the transport) ------------------------------------
export function connect() {
  if (!S.settings.pairCode && !S.settings.relayUrl) return;
  leaveRoom();
  S.connectedOnce = false;
  setStatus("connecting");
  // If a relay link is set, use it exclusively — unless we already gave up on it
  // this session and fell back to the serverless path.
  if (S.settings.relayUrl && !S.relayFellBack) { connectRelay(); return; }
  connectTrystero();
}

// Leave the room cleanly (panel close, re-pair, or transport switch).
export function leaveRoom() {
  stopHeartbeat();
  teardownRelay(true); // close the relay socket + call PC, clear the "stay open" intent
  S.entries.forEach((e) => { try { e.room.leave(); } catch (_) {} });
  S.entries = []; S.primary = null; S.sendData = null; S.sharedTracks.clear();
}

// Repoint netSend at whichever Trystero transport is currently connected.
export function repointSend() {
  const live = S.entries.find((e) => e.connected);
  S.primary = live || null;
  S.sendData = live ? (obj) => live.action.send(obj) : null;
}

// ---- Connected / disconnected transitions -------------------------------
export function onConnected() {
  clearTimeout(S.connectHint);
  clearTimeout(reconnectTimer);
  if (S.connectedOnce) return;
  S.connectedOnce = true;
  reconnectAttempts = 0;
  startHeartbeat();
  setStatus("on");
  showPanel("live");
  addSys(S.everConnected ? "Reconnected 💞" : `Connected 💞 Say hi to ${S.settings.partner}!`);
  S.everConnected = true;
  netSend({ t: "name", name: S.settings.me });
  netSend({ t: "media-state", mic: S.micOn, cam: S.camOn });
  netSend({ t: "profile", tz: -new Date().getTimezoneOffset() }); // minutes east of UTC
  if (S.settings.themeColor) netSend({ t: "theme", color: S.settings.themeColor });
  syncWeatherOnConnect();
  syncWatchlistOnConnect();
  if (S.amInitiator) netSend({ t: "sync-req" });
  // If WE just did a clean-reload reconnect, nudge the partner to do the same
  // (once the link is healthy) so their stale media tracks refresh too. The
  // recentlyReloaded guard on their side keeps this from ping-ponging.
  if (S.pendingPartnerReload) { S.pendingPartnerReload = false; setTimeout(() => netSend({ t: "please-reload" }), 1200); }
  flushOutbox(); // re-send any chat/photos queued while we were disconnected
  recordSession();
}
export function onDisconnected() {
  // Partner left (closed panel / browser). We stay in the room, so Trystero
  // reconnects automatically when they come back.
  S.connectedOnce = false;
  setStatus("connecting");
  if (S.relayMode) return; // relay handles its own reconnection (socket close / roster)
  scheduleReconnect();
}

// ---- Reconnect / heartbeat ----------------------------------------------
// If we don't actually connect within a while, rebuild the rooms and try
// again. Covers the "closed the panel and reopened" case where the first
// handshake can stall on a stale peer.
let reconnectTimer = null;
let reconnectAttempts = 0;
export function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  // Retry fast at first (3.5s), backing off to 8s only if it keeps failing.
  const delay = Math.min(8000, 3500 + reconnectAttempts * 1500);
  reconnectTimer = setTimeout(() => {
    if (!S.connectedOnce && (S.settings.pairCode || S.settings.relayUrl)) { reconnectAttempts++; connect(); }
  }, delay);
}

// App-level heartbeat: a steady ping both ways. If we stop hearing ANYTHING
// from the partner for a few seconds — a silent Wi-Fi drop that Trystero
// hasn't reported yet — we proactively rejoin. This is what keeps a movie
// night from quietly freezing.
let heartbeatTimer = null;
let lastBeatAt = 0;
export function startHeartbeat() {
  stopHeartbeat();
  S.lastRx = Date.now();
  lastBeatAt = Date.now();
  heartbeatTimer = setInterval(() => {
    const now = Date.now();
    // Far more than one interval elapsed → the device was asleep/frozen and every
    // socket is likely stale. Recover now instead of waiting out the silence window.
    if (now - lastBeatAt > 12000) { lastBeatAt = now; onNetworkWake(); return; }
    lastBeatAt = now;
    if (!S.connectedOnce) return;
    netSend({ t: "ping" });
    if (now - S.lastRx > 8000) {
      console.log("[WT] heartbeat: link went silent — clean reconnect");
      S.connectedOnce = false;
      setStatus("connecting");
      // Relay mode: a half-open socket is cheap to rebuild — no full page reload.
      if (S.relayMode) {
        if (!S.relayWs || S.relayWs.readyState !== WebSocket.OPEN) connectRelay();
        return;
      }
      hardReconnect();
    }
  }, 2500);
}

// Proactively re-check / rebuild the link after a wake, network change, or tab
// re-show — instead of waiting for the heartbeat's 8s silence window.
export function onNetworkWake() {
  if (S.settings.paired === false) return;
  if (!S.settings.pairCode && !S.settings.relayUrl) return;
  if (S.relayMode && !S.relayFellBack) {
    if (!S.relayWs || S.relayWs.readyState !== WebSocket.OPEN) connectRelay();
    else netSend({ t: "ping" });
  } else if (!S.connectedOnce) {
    connect();
  } else {
    netSend({ t: "ping" });
  }
}

// The relay is unreachable (host asleep / tunnel down) — switch to the serverless
// Trystero path so we still connect (P2P; reuses cached relay TURN creds if any).
export function fallbackToTrystero() {
  if (S.relayFellBack) return;
  if (!S.settings.pairCode && !S.settings.relayUrl) return;
  S.relayFellBack = true;
  addSys("Relay unreachable — connecting over public relays instead 🌐");
  teardownRelay(true);
  S.relayMode = false;
  connectTrystero();
  scheduleReconnect();
}
export function stopHeartbeat() { if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } }

// A clean reconnect = a fresh panel (exactly like the manual Leave+rejoin that
// works reliably). Re-joining in place reuses stale WebRTC/relay state and
// comes back erratic, so for a real mid-session drop we reload the panel —
// preserving the chat and auto-reconnecting on load. Rate-limited so it can
// never loop; if we just reloaded, fall back to an in-place rejoin instead.
export function saveChatState() {
  try {
    sessionStorage.setItem("wt_reconnecting", "1");
    sessionStorage.setItem("wt_chat", $("chat").innerHTML);
    sessionStorage.setItem("wt_partner", S.settings.partner || "");
  } catch (_) {}
}
export function restoreChat() {
  try {
    const html = sessionStorage.getItem("wt_chat");
    if (html != null) $("chat").innerHTML = html;
    sessionStorage.removeItem("wt_chat");
    const p = sessionStorage.getItem("wt_partner");
    if (p && p !== "Partner") { S.partnerReal = p; S.settings.partner = p; $("remote-label").textContent = p; }
  } catch (_) {}
}
export function hardReconnect() {
  let last = 0;
  try { last = Number(sessionStorage.getItem("wt_reload_at")) || 0; } catch (_) {}
  if (Date.now() - last < 12000) { connect(); return; } // reloaded too recently → in-place, avoid a loop
  try { sessionStorage.setItem("wt_reload_at", String(Date.now())); } catch (_) {}
  saveChatState();
  // Ask the partner to do the same clean reload, so BOTH sides come back with
  // fresh peer connections and re-add their media — otherwise the side that
  // didn't reload keeps stale track state and the streams never re-negotiate.
  try { netSend({ t: "please-reload" }); } catch (_) {}
  setTimeout(() => location.reload(), 300); // let that message flush first
}
export function recentlyReloaded() {
  try { return Date.now() - (Number(sessionStorage.getItem("wt_reload_at")) || 0) < 12000; } catch (_) { return false; }
}

// ---- Pairing UI actions -------------------------------------------------
export function showPairStatus() {
  $("pair-setup").classList.add("hidden");
  $("pair-status").classList.remove("hidden");
  $("partner-name2").textContent = S.settings.partner && S.settings.partner !== "Partner" ? S.settings.partner : "your partner";
}
export function startPairing() {
  const code = $("pair-code").value.trim();
  const relay = $("relay-url") ? $("relay-url").value.trim() : "";
  // Need at least a secret word (Trystero room) OR a relay link to connect.
  if (!code && !relay) { $("pair-code").focus(); return; }
  showError("");
  S.relayFellBack = false; // a fresh pair should try the relay again before falling back
  S.settings.pairCode = code;
  S.settings.relayUrl = relay;
  S.settings.paired = true;
  if ($("turn-url")) {
    S.settings.turnUrl = $("turn-url").value.trim();
    S.settings.turnUser = $("turn-user").value.trim();
    S.settings.turnPass = $("turn-pass").value.trim();
  }
  chrome.storage.local.set({ wt_settings: S.settings });
  showPairStatus();
  connect();
}
// Manual escape hatch: rejoin the room now.
export function forceReconnect() {
  if (!S.settings.pairCode && !S.settings.relayUrl) { addSys("Not paired yet."); return; }
  if (S.relayMode) { connectRelay(); return; } // relay: just re-open the socket
  hardReconnect();
}
export function unpair() {
  // Stop connecting but REMEMBER the room + relay (and TURN) so re-pairing is one
  // click and nothing has to be re-typed. Only the "paired" flag is cleared — that's
  // what suppresses auto-connect on next open; the values stay persisted + prefilled.
  S.settings.paired = false;
  chrome.storage.local.set({ wt_settings: S.settings });
  leaveRoom();
  S.connectedOnce = false;
  S.everConnected = false;
  S.relayFellBack = false;
  setStatus("off");
  if ($("pair-code")) $("pair-code").value = S.settings.pairCode || "";
  if ($("relay-url")) $("relay-url").value = S.settings.relayUrl || "";
  $("pair-status").classList.add("hidden");
  $("pair-setup").classList.remove("hidden");
  showPanel("connect");
}
