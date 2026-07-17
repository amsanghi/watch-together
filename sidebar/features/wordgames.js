// WatchTogether — quick two-player guessing games:
//   Mind-meld  — you both type one word about the scene; match = celebration.
//   Call your shot — type a prediction; the partner sees it in chat.
//   Charades   — pause + a prompt to act out the scene on cam.
//
// Exports: sendMeld, receiveMeld, sendPrediction, receivePrediction,
//   sendCharades, receiveCharades.

import { S } from "../core/state.js";
import { netSend } from "../core/net.js";
import { addSys, addMsg } from "./chat.js";
import { parentPost } from "../core/tab.js";
import { burst } from "./reactions.js";

let myWord = "", theirWord = "", myAt = 0, theirAt = 0;
function checkMeld() {
  if (myWord && theirWord && Math.abs(myAt - theirAt) < 60000) {
    if (myWord === theirWord) { burst("wow"); addSys('🧠✨ MIND MELD! You both said "' + myWord + '"'); }
    else addSys("🧠 You: " + myWord + " · " + S.settings.partner + ": " + theirWord);
    myWord = theirWord = "";
  }
}
export function sendMeld() {
  const w = (prompt("Mind-meld — one word about this scene:") || "").trim().toLowerCase();
  if (!w) return;
  myWord = w; myAt = Date.now();
  netSend({ t: "meld", word: w }); addSys("🧠 You said: " + w); checkMeld();
}
export function receiveMeld(w) { theirWord = (w || "").toLowerCase(); theirAt = Date.now(); checkMeld(); }

export function sendPrediction() {
  const p = (prompt("Call your shot — what happens next?") || "").trim();
  if (!p) return;
  netSend({ t: "predict", text: p }); addMsg({ mine: true, who: S.settings.me, text: "🔮 I predict: " + p });
}
export function receivePrediction(text) { addMsg({ mine: false, who: S.settings.partner, text: "🔮 predicts: " + text }); }

function doCharades() {
  parentPost({ kind: "apply-video", action: "pause" });
  parentPost({ kind: "toast", text: "🎭 Charades! Act out this scene on cam" });
  addSys("🎭 Charades — act out this paused scene, the other guesses!");
}
export function sendCharades() { netSend({ t: "charades" }); doCharades(); }
export function receiveCharades() { doCharades(); }
