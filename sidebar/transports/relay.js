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
import { roomId, onConnected, onDisconnected, fallbackToTrystero } from "../core/connection.js";

// relay-local state (only S.relayMode / S.relayWs leak out — the rest is private)
let relayWantOpen = false;      // we intend to stay connected (drives auto-reconnect)
let relayReconnectTimer = null;
let relaySelfId = null;         // our id in the room (assigned by the server)
let relayPeerId = null;         // the partner's id, if present
let relayPC = null;             // RTCPeerConnection carrying the voice/video call
let relayMakingOffer = false;   // perfect-negotiation guards
let relayIgnoreOffer = false;
const relayShared = new Set();  // local tracks already added to relayPC
let relayEverOpened = false;    // did the socket open this attempt (vs. never reached the relay)
let relayOpenFails = 0;         // consecutive attempts that never opened → relay is unreachable
let relayBackoff = 0;           // reconnect backoff step (reset on a successful open)

// Accept whatever the user pasted: wss://host, https://host, or a bare host.
function normalizeRelayUrl(raw) {
  let u = (raw || "").trim();
  if (!u) return "";
  u = u.replace(/^http:\/\//i, "ws://").replace(/^https:\/\//i, "wss://");
  if (!/^wss?:\/\//i.test(u)) u = "wss://" + u; // bare host → secure ws
  return u.replace(/\/+$/, "");
}

// ICE servers for the call: STUN, any manually-pasted TURN, and any TURN creds the
// relay server minted for us and handed over in its roster (see relay-server/). This
// lets the media relay through a server when a direct P2P path can't be found — with
// the TURN secret living only on the relay, never in this (public) extension.
function relayIceServers() {
  const list = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
  ];
  if (S.settings.turnUrl) {
    list.push({ urls: S.settings.turnUrl, username: S.settings.turnUser || "", credential: S.settings.turnPass || "" });
  }
  if (S.relayIce.length) list.push(...S.relayIce);
  return list;
}

export function connectRelay() {
  const base = normalizeRelayUrl(S.settings.relayUrl);
  if (!base) { showError("Enter a valid relay server link."); return; }
  S.relayMode = true;
  relayWantOpen = true;
  teardownRelay(false); // drop any previous socket/PC but keep the intent to be open
  relayEverOpened = false;
  setStatus("connecting");
  const rid = roomId();
  console.log("[WT] relay connecting", base, "room", rid);
  let ws;
  try { ws = new WebSocket(base + "/?room=" + encodeURIComponent(rid)); }
  catch (e) { showError("Couldn't open that relay link — check the address."); scheduleRelayReconnect(); return; }
  S.relayWs = ws;

  // Everything the app sends now goes over the relay.
  S.sendData = (obj) => { try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); } catch (_) {} };

  ws.onopen = () => { relayEverOpened = true; relayOpenFails = 0; relayBackoff = 0; console.log("[WT] relay socket open"); }; // wait for the roster before "connected"
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
    if (!(S.relayMode && relayWantOpen)) return;
    // Never opened this attempt → the relay/tunnel is unreachable. After a couple of
    // failed attempts, fall back to the serverless path so we still connect.
    if (!relayEverOpened && ++relayOpenFails >= (S.settings.relayFallbackTries || 2)) return fallbackToTrystero();
    onDisconnected();
    scheduleRelayReconnect();
  };
  ws.onerror = (e) => { console.log("[WT] relay socket error", e && e.message); };
}

// Server roster: tells us our id, whether the partner is here, and who starts
// the call. This is our connected / disconnected signal in relay mode.
function relayControl(m) {
  if (m.event !== "roster") return;
  relaySelfId = m.self;
  if (Array.isArray(m.iceServers)) S.relayIce = m.iceServers; // TURN creds minted by the relay
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
  const delay = Math.min(15000, 1500 * Math.pow(1.6, relayBackoff)) + Math.random() * 500; // exponential backoff + jitter
  relayBackoff++;
  relayReconnectTimer = setTimeout(() => {
    if (!S.relayMode || !relayWantOpen) return;
    const st = S.relayWs ? S.relayWs.readyState : WebSocket.CLOSED;
    if (st === WebSocket.CLOSED || st === WebSocket.CLOSING) connectRelay();
  }, delay);
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
  if (!relayPC) { relayPC = relayNewPC(); startStatsMonitor(); }
  relayShareLocalTracks();
}
function relayNewPC() {
  // Force ALL call media through TURN (never a direct P2P path) whenever we actually
  // have TURN — trades a little latency for a connection that doesn't depend on NAT
  // hole-punching. Only when TURN exists, or 'relay' would leave zero candidates.
  const hasTurn = S.relayIce.length > 0 || !!S.settings.turnUrl;
  const pc = new RTCPeerConnection({
    iceServers: relayIceServers(),
    iceTransportPolicy: hasTurn ? "relay" : "all",
  });
  pc.onicecandidate = ({ candidate }) => { if (candidate) relaySignal({ kind: "ice", cand: candidate }); };
  pc.ontrack = (e) => remoteStreamHandler(e.streams[0]);
  pc.onnegotiationneeded = async () => {
    try {
      relayMakingOffer = true;
      const offer = await pc.createOffer();
      offer.sdp = tuneSdp(offer.sdp);
      await pc.setLocalDescription(offer);
      relaySignal({ kind: "sdp", sdp: pc.localDescription });
    } catch (err) { console.log("[WT] relay negotiation error", err); }
    finally { relayMakingOffer = false; }
  };
  // The data socket staying up masks a dead media path, so the app heartbeat won't
  // catch it — recover the call in place with an ICE restart. Perfect negotiation
  // sorts out the re-offer if both sides restart at once.
  let iceGrace = null;
  pc.oniceconnectionstatechange = () => {
    const st = pc.iceConnectionState;
    if (st === "failed") { clearTimeout(iceGrace); iceGrace = null; try { pc.restartIce(); } catch (_) {} }
    else if (st === "disconnected") {
      // 'failed' can take 15–30s; recover a transient blip after a short grace instead.
      clearTimeout(iceGrace);
      iceGrace = setTimeout(() => { if (relayPC === pc && (pc.iceConnectionState === "disconnected" || pc.iceConnectionState === "failed")) { try { pc.restartIce(); } catch (_) {} } }, 3000);
    } else if (st === "connected" || st === "completed") { clearTimeout(iceGrace); iceGrace = null; }
  };
  return pc;
}
// Kick an ICE restart on the call PC (used on wake / network change to heal a stale
// media path even when the data socket looks fine).
export function relayRestartIce() { if (relayPC) { try { relayPC.restartIce(); } catch (_) {} } }
export function relayShareLocalTracks() {
  if (!relayPC || !S.localStream) return;
  S.localStream.getTracks().forEach((t) => {
    if (relayShared.has(t)) return;
    try {
      const sender = relayPC.addTrack(t, S.localStream);
      relayShared.add(t);
      if (t.kind === "video") capVideoBitrate(sender); else capAudio(sender);
    } catch (_) {}
  });
}
// Cap outbound video: the call tile is tiny, so a low ceiling keeps it smooth on
// weak uplinks and well inside a free TURN quota. Best-effort (params vary by UA).
async function capVideoBitrate(sender) {
  try {
    const p = sender.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = (S.settings.videoMaxKbps || 400) * 1000; // ceiling; the adaptive loop lowers it
    p.encodings[0].maxFramerate = 24;
    p.degradationPreference = "maintain-framerate";
    await sender.setParameters(p);
  } catch (_) {}
}
// Protect the voice: mark audio high-priority so it survives congestion (video drops first).
function capAudio(sender) {
  try {
    const p = sender.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    p.encodings[0].networkPriority = "high";
    p.encodings[0].priority = "high";
    sender.setParameters(p);
  } catch (_) {}
}
// Tune Opus in our SDP for resilience + efficiency: in-band FEC (repairs lost audio
// without a retransmit) and DTX (stop sending packets during silence).
function tuneSdp(sdp) {
  if (!sdp) return sdp;
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000/i);
  if (!m) return sdp;
  const pt = m[1];
  const fmtpRe = new RegExp("a=fmtp:" + pt + " ([^\\r\\n]*)");
  if (fmtpRe.test(sdp)) {
    return sdp.replace(fmtpRe, (_l, params) => {
      let p = params;
      if (!/usedtx=/.test(p)) p += ";usedtx=1";
      if (!/useinbandfec=/.test(p)) p += ";useinbandfec=1";
      return "a=fmtp:" + pt + " " + p;
    });
  }
  return sdp.replace(new RegExp("(a=rtpmap:" + pt + " opus/48000/2)"), "$1\r\na=fmtp:" + pt + " usedtx=1;useinbandfec=1");
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
        const answer = await pc.createAnswer();
        answer.sdp = tuneSdp(answer.sdp);
        await pc.setLocalDescription(answer);
        relaySignal({ kind: "sdp", sdp: pc.localDescription });
      }
    } else if (m.kind === "ice" && m.cand) {
      try { await pc.addIceCandidate(m.cand); } catch (err) { if (!relayIgnoreOffer) console.log("[WT] relay ICE error", err); }
    }
  } catch (err) { console.log("[WT] relay signal error", err); }
}
// Adaptive degradation: if the partner is losing a lot of our video packets, stop
// sending video (keep audio) until the link recovers. Reads the RTCP remote-inbound
// report; conservative (needs sustained loss) and reversible.
let statsTimer = null, videoDegraded = false, lossStreak = 0;
function startStatsMonitor() {
  clearInterval(statsTimer);
  statsTimer = setInterval(async () => {
    if (!relayPC) return;
    let frac = 0, avail = 0;
    try {
      const stats = await relayPC.getStats();
      stats.forEach((r) => {
        if (r.type === "remote-inbound-rtp" && r.kind === "video" && typeof r.fractionLost === "number") frac = Math.max(frac, r.fractionLost);
        if (r.type === "candidate-pair" && r.nominated && typeof r.availableOutgoingBitrate === "number") avail = r.availableOutgoingBitrate;
      });
    } catch (_) { return; }
    if (frac > (S.settings.videoLossDrop || 10) / 100) lossStreak++; else lossStreak = 0;
    if (lossStreak >= 3 && !videoDegraded) setVideoActive(false);
    else if (lossStreak === 0 && videoDegraded) setVideoActive(true);
    if (!videoDegraded && avail > 0) setVideoBitrate(avail); // adaptive: follow the browser's bandwidth estimate
  }, 2000);
}
function setVideoActive(active) {
  videoDegraded = !active;
  const sender = relayPC && relayPC.getSenders().find((s) => s.track && s.track.kind === "video");
  if (!sender) return;
  try {
    const p = sender.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    p.encodings[0].active = active;
    sender.setParameters(p);
  } catch (_) {}
}
// Follow the browser's outgoing-bandwidth estimate: target ~85% of it, clamped, so
// video rides up and down with the link instead of sitting at a fixed cap.
function setVideoBitrate(avail) {
  const ceil = (S.settings.videoMaxKbps || 400) * 1000, floor = 90000;
  const target = Math.max(floor, Math.min(ceil, Math.round(avail * 0.85)));
  const sender = relayPC && relayPC.getSenders().find((s) => s.track && s.track.kind === "video");
  if (!sender) return;
  try {
    const p = sender.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    if (Math.abs((p.encodings[0].maxBitrate || 0) - target) > 20000) { p.encodings[0].maxBitrate = target; sender.setParameters(p); }
  } catch (_) {}
}
function teardownRelayPC() {
  if (relayPC) { try { relayPC.close(); } catch (_) {} relayPC = null; }
  clearInterval(statsTimer); statsTimer = null; videoDegraded = false; lossStreak = 0;
  relayShared.clear();
  relayMakingOffer = false;
  relayIgnoreOffer = false;
}
