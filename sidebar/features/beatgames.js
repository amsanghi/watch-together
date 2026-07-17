// WatchTogether — two quick performance games that trade scores:
//   Rhythm tap  — a metronome plays 8 beats; tap along; scored on accuracy.
//   Drama karaoke — ham up a line for 5s; scored on your mic's peak + dynamics.
//
// Exports: rhythmClick, startKaraoke, receiveScore.

import { S } from "../core/state.js";
import { netSend } from "../core/net.js";
import { addSys } from "./chat.js";
import { playSfx } from "./soundboard.js";
import { getAudioLevel } from "../core/audioproc.js";

// ---- Rhythm tap ----
let beatTimes = [], taps = [], rhythmActive = false, beatIv = 600;
function startRhythm() {
  rhythmActive = true; beatTimes = []; taps = [];
  const bpm = 100; beatIv = 60000 / bpm; const n = 8;
  addSys("🥁 Rhythm! Tap the button on each beat…");
  for (let i = 0; i < n; i++) setTimeout(() => { playSfx("clink"); beatTimes.push(Date.now()); }, i * beatIv);
  setTimeout(finishRhythm, n * beatIv + 500);
}
function finishRhythm() {
  rhythmActive = false;
  if (!taps.length || !beatTimes.length) { addSys("🥁 No taps — try again!"); return; }
  let err = 0;
  taps.forEach((t) => { let best = Infinity; beatTimes.forEach((b) => (best = Math.min(best, Math.abs(t - b)))); err += Math.min(best, beatIv / 2); });
  const avg = err / taps.length;
  const score = Math.max(0, Math.round(100 * (1 - avg / (beatIv / 2))));
  addSys("🥁 Your rhythm: " + score + "%");
  netSend({ t: "score", game: "rhythm", value: score });
}
export function rhythmClick() { if (rhythmActive) taps.push(Date.now()); else startRhythm(); }

// ---- Drama karaoke ----
let karaokeActive = false, karTimer = null, karPeak = 0, karSum = 0, karN = 0;
export function startKaraoke() {
  if (karaokeActive) return;
  karaokeActive = true; karPeak = 0; karSum = 0; karN = 0;
  addSys("🎤 Perform the line — give it everything! (5s)");
  karTimer = setInterval(() => { const l = getAudioLevel(); karPeak = Math.max(karPeak, l); karSum += l; karN++; }, 80);
  setTimeout(() => {
    clearInterval(karTimer); karaokeActive = false;
    const dyn = karPeak - karSum / Math.max(1, karN);
    const score = Math.max(0, Math.min(100, Math.round(karPeak * 140 + dyn * 120)));
    addSys("🎤 Drama score: " + score + (score > 80 ? " — Oscar-worthy 🏆" : score > 50 ? " — dramatic! 🎭" : " — warm up a bit 😄"));
    netSend({ t: "score", game: "karaoke", value: score });
  }, 5000);
}

export function receiveScore(d) {
  addSys((d.game === "rhythm" ? "🥁" : "🎤") + " " + S.settings.partner + " scored " + d.value + (d.game === "rhythm" ? "%" : ""));
}
