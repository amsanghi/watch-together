// WatchTogether — shared soundboard. Tap a button and the sound plays on BOTH
// speakers (yours immediately, the partner's via a `sfx` wire message). Sounds are
// synthesized with Web Audio so there are no audio assets to bundle.
//
// Exports: playSfx, sendSfx.

import { netSend } from "../core/net.js";

let ctx = null;
function ac() {
  if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { ctx = null; } }
  if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

function tone(c, type, f0, f1, t0, dur, gain) {
  const o = c.createOscillator(), g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t0);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(c.destination);
  o.start(t0); o.stop(t0 + dur + 0.03);
}
function noise(c, t0, dur, gain, freq, q) {
  const n = c.createBufferSource();
  const buf = c.createBuffer(1, Math.max(1, Math.ceil(c.sampleRate * dur)), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  n.buffer = buf;
  const f = c.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = freq || 1000; f.Q.value = q || 1;
  const g = c.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  n.connect(f); f.connect(g); g.connect(c.destination);
  n.start(t0); n.stop(t0 + dur);
}

export function playSfx(name) {
  const c = ac(); if (!c) return;
  const t = c.currentTime;
  try {
    switch (name) {
      case "airhorn":
        tone(c, "sawtooth", 180, 180, t, 0.5, 0.22);
        tone(c, "sawtooth", 240, 240, t, 0.5, 0.14);
        break;
      case "clink":
        tone(c, "triangle", 1200, 1650, t, 0.12, 0.2);
        tone(c, "triangle", 1850, 2300, t + 0.06, 0.12, 0.14);
        break;
      case "drumroll":
        for (let i = 0; i < 18; i++) noise(c, t + i * 0.05, 0.05, 0.22, 1200, 1);
        noise(c, t + 0.95, 0.25, 0.4, 300, 0.7);
        break;
      case "applause":
        for (let i = 0; i < 40; i++) noise(c, t + Math.random() * 1.2, 0.05, 0.05 + Math.random() * 0.06, 2000 + Math.random() * 2500, 1.5);
        break;
      case "rimshot":
        noise(c, t, 0.06, 0.3, 400, 0.7);
        tone(c, "triangle", 380, 170, t + 0.07, 0.18, 0.24);
        break;
      case "sad": // "awww" — a gentle descending tone
        tone(c, "sine", 520, 300, t, 0.5, 0.2);
        break;
      default:
        tone(c, "sine", 660, 660, t, 0.15, 0.2);
    }
  } catch (_) {}
}

export function sendSfx(name) {
  playSfx(name);
  netSend({ t: "sfx", name });
}
