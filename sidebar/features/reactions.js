// WatchTogether — reactions & quick gestures: floating emoji bursts (on the
// page over the video AND inside the panel), the presence-heart pulse, the
// 3·2·1 synced countdown, good-morning/night greetings, the heartbeat buzz,
// the kiss-pause, and the webcam selfie snap.
//
// Exports: burst, spawnPanelHearts, sendReaction, beatFast, runCountdown,
//   sendGreet, sendHeartbeat, sendKissPause, sendSnap.

import { $ } from "../core/dom.js";
import { S } from "../core/state.js";
import { netSend } from "../core/net.js";
import { parentPost } from "../core/tab.js";
import { addMsg, addSys } from "./chat.js";

const FX_EMOJI = { heart: "❤️", kiss: "😘", fire: "🔥", laugh: "😂", wow: "😮", sad: "🥲" };

// Burst emojis BOTH on the page (over the video) and inside the panel, so it's
// always visible even on pages where content scripts can't run (new-tab etc.).
export function burst(kind) {
  parentPost({ kind: "reaction", reaction: kind });
  spawnPanelHearts(kind);
}
export function spawnPanelHearts(kind, count = 12) {
  const cont = $("fx-overlay");
  if (!cont) return;
  const emoji = FX_EMOJI[kind] || "❤️";
  for (let i = 0; i < count; i++) {
    const el = document.createElement("div");
    el.className = "fx-heart";
    el.textContent = emoji;
    el.style.left = 6 + Math.random() * 84 + "%";
    el.style.fontSize = 20 + Math.random() * 22 + "px";
    el.style.setProperty("--dx", (Math.random() * 80 - 40) + "px");
    el.style.setProperty("--r", (Math.random() * 50 - 25) + "deg");
    el.style.setProperty("--d", 2.2 + Math.random() * 1.5 + "s");
    el.style.animationDelay = Math.random() * 0.4 + "s";
    cont.appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }
}
export function sendReaction(kind) {
  netSend({ t: "reaction", reaction: kind });
  burst(kind);
}
export function beatFast() {
  const h = $("presence-heart");
  h.style.animationDuration = "0.5s";
  setTimeout(() => (h.style.animationDuration = ""), 2500);
}
export function runCountdown(initiator) {
  if (initiator) netSend({ t: "countdown" });
  parentPost({ kind: "apply-video", action: "pause" });
  let n = 3;
  parentPost({ kind: "countdown", n });
  const iv = setInterval(() => {
    n -= 1;
    parentPost({ kind: "countdown", n });
    if (n <= 0) {
      clearInterval(iv);
      parentPost({ kind: "apply-video", action: "play" });
    }
  }, 1000);
}

// ---- Greetings / heartbeat / kiss / snap --------------------------------
export function sendGreet(kind) { netSend({ t: "greet", kind }); addSys(kind === "gm" ? "Good morning, sent." : "Good night, sent."); }
export function sendHeartbeat() { netSend({ t: "heartbeat" }); beatFast(); }
export function sendKissPause() {
  netSend({ t: "kiss-pause" });
  parentPost({ kind: "apply-video", action: "pause" });
  burst("kiss");
}
export function sendSnap() {
  const v = $("local-video");
  if (!v || !v.srcObject) { addSys("Turn your camera on first."); return; }
  try {
    const c = document.createElement("canvas");
    c.width = 320; c.height = Math.round(320 * (v.videoHeight || 240) / (v.videoWidth || 320));
    const ctx = c.getContext("2d");
    ctx.translate(c.width, 0); ctx.scale(-1, 1); // un-mirror
    ctx.drawImage(v, 0, 0, c.width, c.height);
    const img = c.toDataURL("image/jpeg", 0.6);
    addMsg({ mine: true, gif: img });
    netSend({ t: "snap", img });
  } catch (_) { addSys("That snap didn't take. Try again."); }
}
