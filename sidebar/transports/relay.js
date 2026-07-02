// WatchTogether — relay transport (your own server; see relay-server/).
// A single WebSocket carries EVERYTHING: all app data (sync, chat, reactions,
// presence…) and the voice/video call's WebRTC signaling. No public relays, no
// peer discovery — same relay link + same room = paired. The server's "roster"
// control message is our connected/disconnected signal and picks who initiates.
//
// Exports: connectRelay, teardownRelay, relayShareLocalTracks.

import { S } from "../core/state.js";
import { netSend, handleData } from "../core/net.js";
import { showError, setStatus } from "../core/ui.js";
import { remoteStreamHandler } from "../core/media.js";
import { roomId, onConnected, onDisconnected } from "../core/connection.js";

// relay-local state (only S.relayMode / S.relayWs leak out — the rest is private)
let relayWantOpen = false;      // we intend to stay connected (drives auto-reconnect)
let relayReconnectTimer = null;
let relaySelfId = null;         // our id in the room (assigned by the server)
let relayPeerId = null;         // the partner's id, if present
let relayPC = null;             // RTCPeerConnection carrying the voice/video call
let relayMakingOffer = false;   // perfect-negotiation guards
let relayIgnoreOffer = false;
const relayShared = new Set();  // local tracks already added to relayPC

// Accept whatever the user pasted: wss://host, https://host, or a bare host.
function normalizeRelayUrl(raw) {
  let u = (raw || "").trim();
  if (!u) return "";
  u = u.replace(/^http:\/\//i, "ws://").replace(/^https:\/\//i, "wss://");
  if (!/^wss?:\/\//i.test(u)) u = "wss://" + u; // bare host → secure ws
  return u.replace(/\/+$/, "");
}

function relayIceServers() {
  const list = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];
  // Optional TURN → forces the CALL's media through a server too (data always
  // goes over the relay regardless).
  if (S.settings.turnUrl) {
    list.push({ urls: S.settings.turnUrl, username: S.settings.turnUser || "", credential: S.settings.turnPass || "" });
  }
  return list;
}

export function connectRelay() {
  const base = normalizeRelayUrl(S.settings.relayUrl);
  if (!base) { showError("Enter a valid relay server link."); return; }
  S.relayMode = true;
  relayWantOpen = true;
  teardownRelay(false); // drop any previous socket/PC but keep the intent to be open
  setStatus("connecting");
  const rid = roomId();
  console.log("[WT] relay connecting", base, "room", rid);
  let ws;
  try { ws = new WebSocket(base + "/?room=" + encodeURIComponent(rid)); }
  catch (e) { showError("Couldn't open that relay link — check the address."); scheduleRelayReconnect(); return; }
  S.relayWs = ws;

  // Everything the app sends now goes over the relay.
  S.sendData = (obj) => { try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); } catch (_) {} };

  ws.onopen = () => { console.log("[WT] relay socket open"); }; // wait for the roster before we call ourselves "connected"
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    S.lastRx = Date.now();
    if (m && m.t === "__relay") return relayControl(m);
    if (m && m.t === "__rtc") return relayOnSignal(m);
    handleData(m);
  };
  ws.onclose = () => {
    if (ws !== S.relayWs) return; // stale socket we already replaced
    console.log("[WT] relay socket closed");
    if (S.sendData && S.relayWs === ws) S.sendData = null;
    relayPeerId = null;
    teardownRelayPC();
    if (S.relayMode && relayWantOpen) { onDisconnected(); scheduleRelayReconnect(); }
  };
  ws.onerror = (e) => { console.log("[WT] relay socket error", e && e.message); };
}

// Server roster: tells us our id, whether the partner is here, and who starts
// the call. This is our connected / disconnected signal in relay mode.
function relayControl(m) {
  if (m.event !== "roster") return;
  relaySelfId = m.self;
  const peers = m.peers || [];
  if (peers.length) {
    relayPeerId = peers[0];
    // Deterministic, symmetric: higher id initiates (and is "impolite").
    S.amInitiator = String(relaySelfId) > String(relayPeerId);
    onConnected();
    relayEnsurePC(); // (re)build the call and (re)share our mic/cam to the (re)joined peer
  } else {
    relayPeerId = null;
    teardownRelayPC();
    if (S.connectedOnce) onDisconnected(); // partner left; we stay, server tells us when they're back
    else setStatus("connecting");
  }
}

function scheduleRelayReconnect() {
  clearTimeout(relayReconnectTimer);
  relayReconnectTimer = setTimeout(() => {
    if (!S.relayMode || !relayWantOpen) return;
    const st = S.relayWs ? S.relayWs.readyState : WebSocket.CLOSED;
    if (st === WebSocket.CLOSED || st === WebSocket.CLOSING) connectRelay();
  }, 2500);
}

export function teardownRelay(clearIntent) {
  if (clearIntent) { relayWantOpen = false; S.relayMode = false; }
  clearTimeout(relayReconnectTimer);
  teardownRelayPC();
  if (S.relayWs) {
    try { S.relayWs.onopen = S.relayWs.onmessage = S.relayWs.onclose = S.relayWs.onerror = null; S.relayWs.close(); } catch (_) {}
    S.relayWs = null;
  }
  relaySelfId = null; relayPeerId = null;
}

// ---- The voice/video call over the relay (WebRTC, perfect negotiation) ---
function relayEnsurePC() {
  if (!relayPC) relayPC = relayNewPC();
  relayShareLocalTracks();
}
function relayNewPC() {
  const pc = new RTCPeerConnection({ iceServers: relayIceServers() });
  pc.onicecandidate = ({ candidate }) => { if (candidate) relaySignal({ kind: "ice", cand: candidate }); };
  pc.ontrack = (e) => remoteStreamHandler(e.streams[0]);
  pc.onnegotiationneeded = async () => {
    try {
      relayMakingOffer = true;
      await pc.setLocalDescription();
      relaySignal({ kind: "sdp", sdp: pc.localDescription });
    } catch (err) { console.log("[WT] relay negotiation error", err); }
    finally { relayMakingOffer = false; }
  };
  return pc;
}
export function relayShareLocalTracks() {
  if (!relayPC || !S.localStream) return;
  S.localStream.getTracks().forEach((t) => {
    if (relayShared.has(t)) return;
    try { relayPC.addTrack(t, S.localStream); relayShared.add(t); } catch (_) {}
  });
}
function relaySignal(payload) { netSend({ t: "__rtc", ...payload }); }
async function relayOnSignal(m) {
  if (!relayPC) relayPC = relayNewPC();
  const pc = relayPC;
  const polite = !S.amInitiator;
  try {
    if (m.kind === "sdp" && m.sdp) {
      const desc = m.sdp;
      const collision = desc.type === "offer" && (relayMakingOffer || pc.signalingState !== "stable");
      relayIgnoreOffer = !polite && collision;
      if (relayIgnoreOffer) return;
      await pc.setRemoteDescription(desc);
      if (desc.type === "offer") {
        await pc.setLocalDescription();
        relaySignal({ kind: "sdp", sdp: pc.localDescription });
      }
    } else if (m.kind === "ice" && m.cand) {
      try { await pc.addIceCandidate(m.cand); } catch (err) { if (!relayIgnoreOffer) console.log("[WT] relay ICE error", err); }
    }
  } catch (err) { console.log("[WT] relay signal error", err); }
}
function teardownRelayPC() {
  if (relayPC) { try { relayPC.close(); } catch (_) {} relayPC = null; }
  relayShared.clear();
  relayMakingOffer = false;
  relayIgnoreOffer = false;
}
