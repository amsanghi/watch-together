// WatchTogether — call audio processing. Three best-effort helpers, each
// toggleable in Settings and each degrading to plain audio on any failure:
//   1. Mic noise-gate  — only transmit the mic while you're actually talking,
//      so the movie playing on your speakers doesn't constantly bleed to your
//      partner. Analysed via a CLONE of the mic track, so gating the sent track
//      (enabled=false) never blinds the detector.
//   2. Auto-duck       — when either of you is talking, tell the page to quiet
//      the movie (panel→page "duck" message), then restore it.
//   3. Auto-level      — run the partner's incoming audio through a Web Audio
//      compressor so quiet speech is boosted and loud is tamed. The <video>
//      element stays the fallback player whenever the AudioContext isn't
//      running, so a blocked/suspended context can never leave you silent.
//
// Exports: startAudioLoop, resumeAudioCtx, attachLocalAudio, attachRemoteAudio,
//   applyMicEnabled, applyRemoteOutput, refreshAudioSettings.

import { $ } from "./dom.js";
import { S } from "./state.js";
import { parentPost } from "./tab.js";

// Everything the user can tune lives in Settings (S.settings.*), read live via
// num()/sensToThresh() below. Only the loop cadence stays a constant here.
const LOOP_MS = 90;

function num(key, def) { const v = S.settings[key]; return typeof v === "number" ? v : def; }
function clampN(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
// A 0–100 "sensitivity" slider → an RMS threshold (higher slider = opens to quieter sound).
function sensToThresh(sens) { return 0.15 * (1 - clampN(sens, 0, 100) / 100); }

let audioCtx = null;
// local mic (analysed via a clone; the clone stays enabled so gating the real
// outgoing track doesn't stop us from noticing when speech resumes)
let micClone = null, micSource = null, micAnalyser = null, micBuf = null;
let gateOpen = false, micSpeechUntil = 0;
let micEventCb = null, prevMicLvl = 0, micEvtCooldown = 0;
// remote (partner): compressor chain + a level analyser for the duck
let remoteStream = null;
let remoteSource = null, remoteComp = null, remoteGain = null, remoteAnalyser = null, remoteBuf = null;
let remoteSpeechUntil = 0;
let duckOn = false;
let loopTimer = null;

function ctx() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (_) { audioCtx = null; }
  }
  return audioCtx;
}
// AudioContexts start suspended until a user gesture — resume from click handlers.
export function resumeAudioCtx() {
  const c = ctx();
  if (c && c.state === "suspended") c.resume().catch(() => {});
}
// Register a handler for mic "events" (currently a clap / loud transient).
export function onMicEvent(cb) { micEventCb = cb; }

function rms(analyser, buf) {
  if (!analyser || !buf) return 0;
  analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) { const d = (buf[i] - 128) / 128; sum += d * d; }
  return Math.sqrt(sum / buf.length);
}

export function attachLocalAudio(stream) {
  const c = ctx();
  detachLocalAudio();
  const track = stream && stream.getAudioTracks()[0];
  if (!c || !track) return;
  try {
    micClone = track.clone();          // independent .enabled from the transmitted track
    micClone.enabled = true;
    micSource = c.createMediaStreamSource(new MediaStream([micClone]));
    micAnalyser = c.createAnalyser(); micAnalyser.fftSize = 512;
    micBuf = new Uint8Array(micAnalyser.fftSize);
    micSource.connect(micAnalyser);    // analysis only — never connected to destination (no self-hear)
  } catch (_) { detachLocalAudio(); }
}
function detachLocalAudio() {
  try { micSource && micSource.disconnect(); } catch (_) {}
  try { micClone && micClone.stop(); } catch (_) {}
  micClone = micSource = micAnalyser = micBuf = null;
  gateOpen = false;
}

// Effective mic transmission: on only when mic is on AND (gate disabled, gate open,
// or no analyser available). The no-analyser clause fails open so a Web Audio
// failure can never mute you.
export function applyMicEnabled() {
  if (!S.localStream) return;
  const on = S.micOn && (!S.settings.micGate || gateOpen || !micAnalyser);
  S.localStream.getAudioTracks().forEach((t) => { t.enabled = on; });
}

export function attachRemoteAudio(stream) {
  remoteStream = stream;
  const c = ctx();
  teardownRemoteGraph();
  if (!c || !S.settings.autoLevel || !stream || !stream.getAudioTracks().length) return;
  try {
    remoteSource = c.createMediaStreamSource(stream);
    remoteComp = c.createDynamicsCompressor();
    remoteComp.threshold.value = -50; remoteComp.knee.value = 40;
    remoteComp.ratio.value = clampN(num("levelStrength", 12), 1, 20);
    remoteComp.attack.value = 0.003; remoteComp.release.value = 0.25;
    remoteGain = c.createGain();
    remoteAnalyser = c.createAnalyser(); remoteAnalyser.fftSize = 512;
    remoteBuf = new Uint8Array(remoteAnalyser.fftSize);
    remoteSource.connect(remoteComp); remoteComp.connect(remoteGain); remoteGain.connect(c.destination);
    remoteSource.connect(remoteAnalyser);
  } catch (_) { teardownRemoteGraph(); }
}
function teardownRemoteGraph() {
  [remoteSource, remoteComp, remoteGain, remoteAnalyser].forEach((n) => { try { n && n.disconnect(); } catch (_) {} });
  remoteSource = remoteComp = remoteGain = remoteAnalyser = remoteBuf = null;
}

// Route the partner's audio: through the compressor when the graph is live and the
// context is actually running, else through the plain <video> element. Recomputed
// every tick, so a context that suspends/resumes can never strand us in silence.
export function applyRemoteOutput(v01) {
  const rv = $("remote-video"); if (!rv) return;
  const viaGraph = !!remoteGain && !!audioCtx && audioCtx.state === "running";
  if (viaGraph) {
    remoteGain.gain.value = v01;
    rv.muted = true;                 // Web Audio owns playback; mute the element to avoid double audio
  } else {
    rv.muted = v01 === 0;
    rv.volume = v01;
  }
}

function remoteVol() {
  const v = S.settings.volume == null ? 100 : S.settings.volume;
  return Math.max(0, Math.min(100, v)) / 100;
}

// Re-apply everything when the Settings toggles change at runtime.
export function refreshAudioSettings() {
  attachRemoteAudio(remoteStream);   // rebuild / drop the compressor for autoLevel on/off
  applyMicEnabled();                 // honor micGate on/off immediately
  if (!S.settings.autoDuck && duckOn) { duckOn = false; parentPost({ kind: "duck", on: false }); }
  applyRemoteOutput(remoteVol());
}

// The single audio loop (started from init): VAD → mic gate + movie duck, and it
// keeps the remote output correctly routed as the context suspends/resumes.
export function startAudioLoop() {
  if (loopTimer) return;
  loopTimer = setInterval(tick, LOOP_MS);
}
function tick() {
  const now = Date.now();
  if (micAnalyser) {
    const lvl = rms(micAnalyser, micBuf);
    if (lvl > sensToThresh(num("micGateSens", 65))) micSpeechUntil = now + num("micGateHold", 700);
    const open = now < micSpeechUntil;
    if (open !== gateOpen) { gateOpen = open; applyMicEnabled(); }
    // Clap / loud transient (a sharp jump in level) → a fun reaction. Rate-limited.
    if (micEventCb && S.settings.clapReact !== false && S.micOn && lvl > 0.22 && lvl - prevMicLvl > 0.13 && now > micEvtCooldown) {
      micEvtCooldown = now + 900; micEventCb("clap", lvl);
    }
    prevMicLvl = lvl;
  } else prevMicLvl = 0;
  let remoteSpeaking = false;
  if (remoteAnalyser) {
    if (rms(remoteAnalyser, remoteBuf) > sensToThresh(num("remoteSens", 75))) remoteSpeechUntil = now + num("duckHold", 700);
    remoteSpeaking = now < remoteSpeechUntil;
  }
  if (remoteComp) remoteComp.ratio.value = clampN(num("levelStrength", 12), 1, 20); // live auto-level strength
  if (S.settings.autoDuck) {
    const localSpeaking = S.micOn && now < micSpeechUntil;   // my speech only counts while my mic is on
    const shouldDuck = localSpeaking || remoteSpeaking;
    if (shouldDuck !== duckOn) {
      duckOn = shouldDuck;
      parentPost({ kind: "duck", on: shouldDuck, level: clampN(num("duckLevel", 25), 0, 100) / 100 });
    }
  }
  applyRemoteOutput(remoteVol());
}
