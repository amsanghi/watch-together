// WatchTogether — manual (copy-paste) transport: the Advanced escape hatch with
// no broker at all. One partner hosts (creates an invite blob), the other pastes
// it and returns a reply blob; both are base64-encoded SDP. Uses Google STUN
// only. This is the fallback when even the Trystero rendezvous is unreachable.
//
// Exports: manualHost, manualHostFinish, manualGuestGen.

import { $ } from "../core/dom.js";
import { S } from "../core/state.js";
import { showError, setStatus } from "../core/ui.js";
import { ensureKind, remoteStreamHandler } from "../core/media.js";
import { handleData } from "../core/net.js";
import { onConnected, onDisconnected } from "../core/connection.js";

function newPC() {
  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ],
  });
  pc.ontrack = (e) => remoteStreamHandler(e.streams[0]);
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") onConnected();
    if (["failed", "disconnected", "closed"].includes(pc.connectionState)) onDisconnected();
  };
  return pc;
}
function iceComplete(pc) {
  return new Promise((res) => {
    if (pc.iceGatheringState === "complete") return res();
    const f = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", f);
        res();
      }
    };
    pc.addEventListener("icegatheringstatechange", f);
    setTimeout(res, 4000); // proceed even if a relay candidate lingers
  });
}
const enc = (o) => btoa(JSON.stringify(o));
const dec = (s) => JSON.parse(atob(s.trim()));

// Raw RTCDataChannel wiring (manual copy-paste mode — no broker at all).
function wireDC(dc) {
  S.rawDC = dc;
  dc.onopen = onConnected;
  dc.onmessage = (e) => { try { handleData(JSON.parse(e.data)); } catch (_) {} };
  dc.onclose = onDisconnected;
}

let rawPC = null; // RTCPeerConnection (manual copy-paste mode)

export async function manualHost() {
  showError("");
  setStatus("connecting");
  rawPC = newPC();
  wireDC(rawPC.createDataChannel("wt"));
  await ensureKind("audio"); await ensureKind("video");
  if (S.localStream) S.localStream.getTracks().forEach((t) => rawPC.addTrack(t, S.localStream));
  const offer = await rawPC.createOffer();
  await rawPC.setLocalDescription(offer);
  await iceComplete(rawPC);
  $("host-offer").value = enc(rawPC.localDescription);
}
export async function manualHostFinish() {
  try {
    await rawPC.setRemoteDescription(dec($("host-answer").value));
  } catch (e) {
    showError("Couldn't read that reply code. Make sure you pasted all of it.");
  }
}
export async function manualGuestGen() {
  showError("");
  setStatus("connecting");
  S.amInitiator = true;
  rawPC = newPC();
  rawPC.ondatachannel = (e) => wireDC(e.channel);
  try {
    await rawPC.setRemoteDescription(dec($("guest-offer").value));
  } catch (e) {
    return showError("Couldn't read that invite code. Make sure you pasted all of it.");
  }
  await ensureKind("audio"); await ensureKind("video");
  if (S.localStream) S.localStream.getTracks().forEach((t) => rawPC.addTrack(t, S.localStream));
  const ans = await rawPC.createAnswer();
  await rawPC.setLocalDescription(ans);
  await iceComplete(rawPC);
  $("guest-answer").value = enc(rawPC.localDescription);
}
