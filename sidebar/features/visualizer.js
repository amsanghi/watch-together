// WatchTogether — vibe visualizer. A canvas of drifting colored blobs that swell
// with your call audio (mic + partner), from getAudioLevel(). A living lava lamp of
// your night. Toggle in the Fun panel.
//
// Exports: toggleVibe.

import { $ } from "../core/dom.js";
import { getAudioLevel } from "../core/audioproc.js";

let on = false, raf = null, cctx = null, cnv = null, blobs = [];

function initBlobs() {
  blobs = [];
  for (let i = 0; i < 5; i++) blobs.push({ x: Math.random(), y: Math.random(), vx: (Math.random() - 0.5) * 0.003, vy: (Math.random() - 0.5) * 0.003, hue: Math.random() * 360 });
}
function loop() {
  if (!cnv || !cctx) return;
  const w = cnv.width = cnv.clientWidth || 260, h = cnv.height = cnv.clientHeight || 110;
  const lvl = getAudioLevel(), t = Date.now();
  cctx.clearRect(0, 0, w, h);
  cctx.globalCompositeOperation = "lighter";
  blobs.forEach((b) => {
    b.x += b.vx; b.y += b.vy;
    if (b.x < 0 || b.x > 1) b.vx *= -1;
    if (b.y < 0 || b.y > 1) b.vy *= -1;
    b.hue = (b.hue + 0.3) % 360;
    const rad = Math.max(4, (18 + lvl * 220) * (0.6 + 0.4 * Math.sin(t / 600 + b.hue)));
    const g = cctx.createRadialGradient(b.x * w, b.y * h, 0, b.x * w, b.y * h, rad);
    g.addColorStop(0, "hsla(" + Math.round(b.hue) + ",80%,62%,.5)");
    g.addColorStop(1, "hsla(0,0%,0%,0)");
    cctx.fillStyle = g;
    cctx.beginPath(); cctx.arc(b.x * w, b.y * h, rad, 0, 7); cctx.fill();
  });
  cctx.globalCompositeOperation = "source-over";
  raf = on ? requestAnimationFrame(loop) : null;
}
export function toggleVibe() {
  on = !on;
  const btn = $("btn-vibe"); if (btn) btn.classList.toggle("on", on);
  cnv = $("vibe-canvas"); if (!cnv) return;
  if (on) { cctx = cnv.getContext("2d"); cnv.classList.remove("hidden"); initBlobs(); if (!raf) raf = requestAnimationFrame(loop); }
  else { cnv.classList.add("hidden"); if (raf) cancelAnimationFrame(raf); raf = null; }
}
