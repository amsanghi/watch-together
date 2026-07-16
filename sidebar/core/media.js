// WatchTogether — mic / camera / call media.
// Owns the local MediaStream, on-demand permission acquisition, the mic/cam
// toggles, partner-volume, and keeping the camera tiles (live view + the Fun
// panel mirror) in sync. Tracks are shared to peers by the transports, which
// call remoteStreamHandler() / reshareTo() here.
//
// Exports: hasKind, shareAll, reshareTo, ensureKind, saveMedia, toggleMic,
//   toggleCam, resumeMedia, updateMediaButtons, remoteStreamHandler,
//   applyRemoteVolume, setRemoteVolume, updateRemoteTile, syncFunCams.

import { $ } from "./dom.js";
import { S } from "./state.js";
import { netSend } from "./net.js";
import { addSys } from "../features/chat.js";
import { relayShareLocalTracks } from "../transports/relay.js";

// media-local: whether the last getUserMedia was blocked (drives the badge text).
let mediaDenied = false;

export function hasKind(kind) {
  if (!S.localStream) return false;
  return (kind === "video" ? S.localStream.getVideoTracks() : S.localStream.getAudioTracks()).length > 0;
}

// Push any local tracks we have to all currently-connected Trystero peers (used
// when we first enable mic/cam). Deduped so we don't double-add to the same peers.
export function shareAll() {
  if (!S.primary || !S.localStream) return;
  S.localStream.getTracks().forEach((t) => {
    if (S.sharedTracks.has(t)) return;
    try { S.primary.room.addTrack(t, S.localStream); S.sharedTracks.add(t); } catch (_) {}
  });
}

// (Re)send our tracks to ONE specific peer that just (re)joined — bypasses the
// dedup since a rejoined peer is a brand-new connection that has nothing yet.
export function reshareTo(room, pid) {
  if (!S.localStream) return;
  S.localStream.getTracks().forEach((t) => {
    try { room.addTrack(t, S.localStream, { target: pid }); } catch (_) {}
  });
}

// Acquire ONE kind (camera or mic) on demand. Asks only for what was clicked,
// is retryable if the prompt was dismissed, and survives one device missing.
export async function ensureKind(kind) {
  if (hasKind(kind)) return true;
  try {
    const s = await navigator.mediaDevices.getUserMedia(kind === "video"
      ? { video: { width: { ideal: 480 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 24 } } }
      : { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (!S.localStream) { S.localStream = new MediaStream(); $("local-video").srcObject = S.localStream; }
    s.getTracks().forEach((t) => { t.enabled = false; S.localStream.addTrack(t); });
    mediaDenied = false;
    shareAll();
    if (S.relayMode) relayShareLocalTracks(); // push new track into the relay call
    return true;
  } catch (e) {
    mediaDenied = true;
    updateMediaButtons();
    const dev = kind === "video" ? "camera" : "microphone";
    const name = (e && e.name) || "error";
    console.log("[WT] getUserMedia(" + kind + ") failed:", name, e && e.message);
    let why;
    if (name === "NotAllowedError" || name === "SecurityError")
      why = `access is blocked. Open chrome://settings/content/${kind === "video" ? "camera" : "microphone"}, remove/allow this extension, then reopen the panel`;
    else if (name === "NotReadableError" || name === "AbortError")
      why = `the ${dev} is in use by another app or tab — close it and tap again`;
    else if (name === "NotFoundError" || name === "OverconstrainedError")
      why = `no ${dev} was found on this computer`;
    else why = `couldn't access it (${name})`;
    addSys(`Couldn't turn on the ${dev} — ${why}.`);
    return false;
  }
}

export function saveMedia() { chrome.storage.local.set({ wt_media: { mic: S.micOn, cam: S.camOn } }); }

export async function toggleMic() {
  if (!S.micOn) { if (!(await ensureKind("audio"))) return; }
  S.micOn = !S.micOn;
  S.localStream.getAudioTracks().forEach((t) => (t.enabled = S.micOn));
  updateMediaButtons();
  saveMedia();
  netSend({ t: "media-state", mic: S.micOn, cam: S.camOn });
}

export async function toggleCam() {
  if (!S.camOn) { if (!(await ensureKind("video"))) return; }
  S.camOn = !S.camOn;
  S.localStream.getVideoTracks().forEach((t) => (t.enabled = S.camOn));
  $("local-video").parentElement.classList.toggle("live", S.camOn);
  updateMediaButtons();
  saveMedia();
  netSend({ t: "media-state", mic: S.micOn, cam: S.camOn });
}

// Auto-resume mic/cam to their last state — but only if the browser permission
// is already granted (so we never trigger a prompt without a click).
export async function resumeMedia() {
  const permGranted = async (name) => {
    try { return (await navigator.permissions.query({ name })).state === "granted"; }
    catch (_) { return false; }
  };
  if (S.wantCam && !S.camOn && (await permGranted("camera"))) {
    if (await ensureKind("video")) {
      S.camOn = true;
      S.localStream.getVideoTracks().forEach((t) => (t.enabled = true));
      $("local-video").parentElement.classList.add("live");
    }
  }
  if (S.wantMic && !S.micOn && (await permGranted("microphone"))) {
    if (await ensureKind("audio")) {
      S.micOn = true;
      S.localStream.getAudioTracks().forEach((t) => (t.enabled = true));
    }
  }
  updateMediaButtons();
  if (S.camOn || S.micOn) netSend({ t: "media-state", mic: S.micOn, cam: S.camOn });
}

export function updateMediaButtons() {
  $("btn-mic").className = "media-btn " + (S.micOn ? "on" : "off");
  $("btn-cam").className = "media-btn " + (S.camOn ? "on" : "off");
  $("local-off").textContent = mediaDenied ? "allow access" : "cam off";
  $("local-off").style.display = S.camOn ? "none" : "flex";
  syncFunCams();
}

export function remoteStreamHandler(stream) {
  const rv = $("remote-video");
  rv.srcObject = stream;
  applyRemoteVolume();
  updateRemoteTile();
}

// Volume of the partner's audio (only #remote-video carries it; the mirror
// tiles are muted). 0–100, persisted.
export function applyRemoteVolume() {
  const v = Math.max(0, Math.min(100, S.settings.volume == null ? 100 : S.settings.volume));
  const rv = $("remote-video");
  rv.muted = v === 0;
  rv.volume = v / 100;
  const icon = $("vol-icon");
  if (icon) icon.textContent = v === 0 ? "🔇" : v < 50 ? "🔈" : "🔊";
  if ($("vol-slider") && Number($("vol-slider").value) !== v) $("vol-slider").value = v;
}

export function setRemoteVolume(v) {
  S.settings.volume = Math.max(0, Math.min(100, Math.round(v)));
  chrome.storage.local.set({ wt_settings: S.settings });
  applyRemoteVolume();
}

export function updateRemoteTile() {
  const tile = $("remote-video").parentElement;
  const hasStream = !!$("remote-video").srcObject;
  tile.classList.toggle("live", hasStream && S.remoteState.cam);
  $("remote-off").textContent = !hasStream ? "waiting…" : S.remoteState.cam ? "" : "cam off";
  $("remote-off").style.display = hasStream && S.remoteState.cam ? "none" : "flex";
  syncFunCams();
}

// Mirror the live camera tiles into the Fun panel's strip so you can still
// see each other while playing games / reading letters. Multiple <video>
// elements can share the same MediaStream, so we just copy srcObject across.
export function syncFunCams() {
  const fl = $("fun-local-video"), fr = $("fun-remote-video");
  if (!fl || !fr) return;
  const lv = $("local-video"), rv = $("remote-video");
  if (fl.srcObject !== lv.srcObject) fl.srcObject = lv.srcObject;
  if (fr.srcObject !== rv.srcObject) fr.srcObject = rv.srcObject;
  $("fun-cam").classList.toggle("hidden", !S.connectedOnce);
  fl.parentElement.classList.toggle("live", S.camOn);
  $("fun-local-off").textContent = mediaDenied ? "allow access" : "cam off";
  $("fun-local-off").style.display = S.camOn ? "none" : "flex";
  const rHas = !!rv.srcObject;
  fr.parentElement.classList.toggle("live", rHas && S.remoteState.cam);
  $("fun-remote-off").textContent = !rHas ? "waiting…" : S.remoteState.cam ? "" : "cam off";
  $("fun-remote-off").style.display = rHas && S.remoteState.cam ? "none" : "flex";
  $("fun-local-label").textContent = S.settings.me;
  $("fun-remote-label").textContent = S.settings.partner;
}
