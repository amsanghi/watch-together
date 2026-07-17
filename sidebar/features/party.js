// WatchTogether — movie-night party toys: a synced "break for both", rewind
// roulette (wired in main.js since it needs the page time), a fortune-cookie line,
// and an auto "house rule" for the movie. All mirror to both sides via `party`.
//
// Exports: sendFortune, sendGameRule, sendBreak, receiveParty.

import { S } from "../core/state.js";
import { netSend } from "../core/net.js";
import { addSys } from "./chat.js";
import { parentPost } from "../core/tab.js";
import { todayStr } from "./stats.js";
import { getMoodTally } from "./reactions.js";

// Mood diary — a running tally of the reactions flying this movie night.
export function renderMoodDiary() {
  const el = document.getElementById("mood-diary"); if (!el) return;
  const t = getMoodTally();
  const HE = { heart: "❤️", kiss: "😘", fire: "🔥", laugh: "😂", wow: "😮", sad: "🥲", popcorn: "🍿", confetti: "🎊", ghost: "👻" };
  const parts = Object.keys(t).filter((k) => t[k]).map((k) => (HE[k] || "✨") + "×" + t[k]);
  el.textContent = parts.length ? parts.join("   ") : "React during the movie to fill your diary 📔";
}

// Closeness meter — a level computed from the moments you've already racked up
// (kisses, hugs, hand-holding minutes). Pure display; refreshed when the Fun panel opens.
export function renderCloseness() {
  const bar = document.getElementById("closeness-bar"); if (!bar) return;
  const score = (S.counts.kiss || 0) + (S.counts.hug || 0) + Math.floor((S.handSeconds || 0) / 60);
  const level = Math.floor(Math.sqrt(score));
  const into = score - level * level, span = (level + 1) * (level + 1) - level * level;
  bar.style.width = Math.min(100, Math.round((into / span) * 100)) + "%";
  const lbl = document.getElementById("closeness-lbl");
  if (lbl) lbl.textContent = "Level " + level + " 💞 · " + score + " moments together";
}

const FORTUNES = [
  "You'll both cry at the ending (one of you first) 😢",
  "A midnight snack run is written in the stars 🍜",
  "The sequel will be worse — you'll watch it anyway",
  "Someone falls asleep in the last 20 minutes 😴",
  "This becomes 'our movie' 💞",
  "Plot twist: the popcorn runs out first",
  "You'll quote this at each other for weeks",
  "True love is agreeing on the volume 🔊",
];
const GAME_RULES = [
  "Every time someone says the title — blow a kiss 💋",
  "Every jump scare — grab each other 🫂",
  "Every plot twist — swap blankets 🔄",
  "Every on-screen kiss — send one 😘",
  "Every villain monologue — dramatic sip 🥤",
  "Every 'I love you' — say it back ❤️",
  "First to guess the ending wins a back rub 💆",
];

function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
function showFortune(t) { addSys("🥠 " + t); parentPost({ kind: "toast", text: "🥠 " + t }); }
function showRule(t) { addSys("🎲 House rule: " + t); parentPost({ kind: "toast", text: "🎲 " + t }); }
function doBreak() {
  parentPost({ kind: "apply-video", action: "pause" });
  parentPost({ kind: "toast", text: "🚽 Break time — back in a few!" });
  addSys("🚽 Break time — paused for both of you");
}

export function sendFortune() { const f = pick(FORTUNES); netSend({ t: "party", kind: "fortune", text: f }); showFortune(f); }
export function sendGameRule() { const g = pick(GAME_RULES); netSend({ t: "party", kind: "rule", text: g }); showRule(g); }
export function sendBreak() { netSend({ t: "party", kind: "break" }); doBreak(); }
function showFinale(text) {
  addSys(text); parentPost({ kind: "toast", text });
  S.scrapbook.unshift({ text, date: todayStr() }); S.scrapbook = S.scrapbook.slice(0, 100);
  chrome.storage.local.set({ wt_scrapbook: S.scrapbook });
}
export function sendFinale() {
  const score = 60 + Math.floor(Math.random() * 41);
  const verdict = score > 92 ? "soulmates 💞" : score > 78 ? "adorable 🥰" : score > 65 ? "cozy night 🍿" : "sweet 💛";
  const text = "🎬 Tonight's love-o-meter: " + score + "% — " + verdict;
  netSend({ t: "party", kind: "finale", text }); showFinale(text);
}
export function receiveParty(d) {
  if (d.kind === "fortune") showFortune(d.text);
  else if (d.kind === "rule") showRule(d.text);
  else if (d.kind === "break") doBreak();
  else if (d.kind === "finale") showFinale(d.text);
}
