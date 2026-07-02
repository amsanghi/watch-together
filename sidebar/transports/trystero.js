// WatchTogether — Trystero transport (the default).
// Serverless rendezvous over public relays: both partners join the same room
// (derived from the shared secret) via two strategies (MQTT + BitTorrent) and
// connect directly P2P. We race both and send on whichever finds the peer
// first; Trystero reconnects on its own. Sets S.amInitiator from the peer ids.
//
// NOTE: `lib/trystero.js` is a *classic* script that sets the global
// `window.Trystero`. From this ES module the bare name `Trystero` would be
// undefined, so we always go through `window.Trystero`.
//
// Exports: connectTrystero.

import { S } from "../core/state.js";
import { showError } from "../core/ui.js";
import { handleData } from "../core/net.js";
import { addSys } from "../features/chat.js";
import { reshareTo, remoteStreamHandler } from "../core/media.js";
import { roomId, repointSend, onConnected, onDisconnected, scheduleReconnect } from "../core/connection.js";

// We race multiple transports (torrent + MQTT) so we connect via whichever
// network finds the peer first. Both partners join both rooms, so we can send
// on any transport we're connected on and the partner receives it once (no
// duplicates, since we send on a single transport at a time).
export function connectTrystero() {
  const T = window.Trystero;
  if (typeof T === "undefined") { showError("Networking failed to load — use Advanced (manual) below."); return; }
  const rid = roomId();
  const cfg = {
    appId: "watchtogether",
    relayConfig: { redundancy: 6 },
    // STUN helps ICE find the direct LAN/P2P path faster and more reliably.
    rtcConfig: {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun.cloudflare.com:3478" },
      ],
    },
  };
  const strategies = [
    { name: "mqtt", join: T.mqtt && T.mqtt.joinRoom },        // usually fastest
    { name: "torrent", join: T.torrent && T.torrent.joinRoom }, // reliable fallback
  ];
  console.log("[WT] joining room", rid, "selfId", T.selfId);

  strategies.forEach((s) => {
    if (typeof s.join !== "function") return;
    let r;
    try { r = s.join(cfg, rid); } catch (e) { console.log("[WT]", s.name, "join error", e); return; }
    const action = r.makeAction("m");
    const entry = { name: s.name, room: r, action, connected: false };
    action.onMessage = (data) => handleData(data);
    r.onPeerJoin = (pid) => {
      console.log("[WT] peer joined via", s.name, pid);
      entry.connected = true;
      S.amInitiator = String(T.selfId) > String(pid);
      if (!S.primary) repointSend();
      reshareTo(r, pid); // (re)send our mic/cam to this (possibly rejoined) peer
      onConnected();
    };
    r.onPeerLeave = (pid) => {
      console.log("[WT] peer left via", s.name, pid);
      entry.connected = false;
      if (S.entries.some((e) => e.connected)) {
        if (S.primary === entry) repointSend(); // failover to the other transport
      } else {
        S.primary = null; S.sendData = null;
        onDisconnected();
      }
    };
    r.onPeerStream = (stream) => remoteStreamHandler(stream);
    r.onPeerTrack = (track, stream) => remoteStreamHandler(stream); // addTrack fires this, not onPeerStream
    S.entries.push(entry);
  });

  if (!S.entries.length) { showError("Networking failed to start."); return; }

  clearTimeout(S.connectHint);
  S.connectHint = setTimeout(() => {
    if (!S.connectedOnce) addSys("Still connecting… make sure your partner has the panel open and typed the exact same secret word.");
  }, 15000);
  scheduleReconnect(); // retry the whole rendezvous if it stalls (e.g. after reopen)
}
