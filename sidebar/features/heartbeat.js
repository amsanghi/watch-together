// WatchTogether — heartbeat sync (rPPG, best-effort). Samples the green channel of
// a center patch of your own webcam over time and estimates BPM by autocorrelation
// in the 40–180 bpm band, then trades BPMs with your partner and celebrates when
// they're close. This is APPROXIMATE and for fun — it needs decent lighting and a
// reasonably still face, and it is not a medical reading.
//
// Exports: toggleHeartbeat, receiveHr.

import { $ } from "../core/dom.js";
import { S } from "../core/state.js";
import { netSend } from "../core/net.js";
import { addSys } from "./chat.js";

let on = false, timer = null, canvas = null, cctx = null;
let samples = [], times = [], lastBpm = 0, partnerBpm = 0, lastSend = 0, lastSyncNote = 0;

export function toggleHeartbeat() {
  on = !on;
  const b = $("btn-hr"); if (b) b.classList.toggle("on", on);
  if (on) start(); else stop();
}
function start() {
  if (!canvas) { canvas = document.createElement("canvas"); canvas.width = 64; canvas.height = 48; cctx = canvas.getContext("2d", { willReadFrequently: true }); }
  samples = []; times = []; lastBpm = 0;
  setReadout();
  timer = setInterval(() => { sample(); compute(); }, 66); // ~15 fps
}
function stop() {
  if (timer) clearInterval(timer); timer = null;
  const r = $("hr-readout"); if (r) r.textContent = "";
}
function sample() {
  const v = $("local-video");
  if (!v || !v.videoWidth || !S.camOn) return;
  try {
    cctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    const d = cctx.getImageData(16, 12, 32, 24).data; // center patch
    let g = 0; for (let i = 1; i < d.length; i += 4) g += d[i];
    samples.push(g / (d.length / 4));
    times.push(Date.now());
    while (samples.length > 300) { samples.shift(); times.shift(); }
  } catch (_) {}
}
function compute() {
  const n = samples.length;
  if (n < 90) { setReadout(); return; }
  const mean = samples.reduce((a, b) => a + b, 0) / n;
  const s = samples.map((x) => x - mean);
  const fps = (n - 1) / ((times[n - 1] - times[0]) / 1000);
  if (!isFinite(fps) || fps < 4) { setReadout(); return; }
  const minLag = Math.floor((fps * 60) / 180), maxLag = Math.ceil((fps * 60) / 40);
  let best = -Infinity, bestLag = 0;
  for (let lag = minLag; lag <= maxLag && lag < n; lag++) {
    let sum = 0; for (let i = 0; i + lag < n; i++) sum += s[i] * s[i + lag];
    if (sum > best) { best = sum; bestLag = lag; }
  }
  if (bestLag > 0) {
    const bpm = Math.round((60 * fps) / bestLag);
    lastBpm = Math.round(lastBpm ? lastBpm * 0.7 + bpm * 0.3 : bpm); // smooth
  }
  setReadout();
  const now = Date.now();
  if (lastBpm && now - lastSend > 3000) { lastSend = now; netSend({ t: "hr", bpm: lastBpm }); }
  if (lastBpm && partnerBpm && Math.abs(lastBpm - partnerBpm) <= 4 && now - lastSyncNote > 15000) {
    lastSyncNote = now; addSys("💓 Your heartbeats are in sync!");
  }
}
function setReadout() {
  const r = $("hr-readout"); if (!r) return;
  r.textContent = (lastBpm ? "you ~" + lastBpm : "reading…") + (partnerBpm ? " · them ~" + partnerBpm : "") + " bpm (approx)";
}
export function receiveHr(bpm) { if (typeof bpm === "number") { partnerBpm = bpm; if (on) setReadout(); } }
