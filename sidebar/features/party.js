// WatchTogether — movie-night party toys: a synced "break for both", rewind
// roulette (wired in main.js since it needs the page time), a fortune-cookie line,
// and an auto "house rule" for the movie. All mirror to both sides via `party`.
//
// Exports: sendFortune, sendGameRule, sendBreak, receiveParty.

import { netSend } from "../core/net.js";
import { addSys } from "./chat.js";
import { parentPost } from "../core/tab.js";

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
export function receiveParty(d) {
  if (d.kind === "fortune") showFortune(d.text);
  else if (d.kind === "rule") showRule(d.text);
  else if (d.kind === "break") doBreak();
}
