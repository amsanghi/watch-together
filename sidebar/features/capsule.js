// WatchTogether — time capsules. Pin a note to the movie you're watching; the next
// time either of you plays that same title, it resurfaces. Stored on both devices
// (wt_capsules) keyed by the video's title/URL, and deduped per session on surface.
//
// Exports: loadCapsules, leaveCapsule, receiveCapsule, checkCapsules.

import { S } from "../core/state.js";
import { netSend } from "../core/net.js";
import { addSys } from "./chat.js";
import { parentPost } from "../core/tab.js";
import { todayStr } from "./stats.js";

let capsules = [];
const surfaced = new Set();

export function loadCapsules() {
  chrome.storage.local.get(["wt_capsules"], (r) => { if (Array.isArray(r.wt_capsules)) capsules = r.wt_capsules; });
}
function keyOf(s) { return ((s && (s.title || s.url)) || "").toLowerCase().trim().slice(0, 100); }
function store() { capsules = capsules.slice(0, 200); chrome.storage.local.set({ wt_capsules: capsules }); }

export function leaveCapsule(state) {
  const k = keyOf(state);
  if (!k) { addSys("Play a video first, then leave a time capsule 💌"); return; }
  const text = (prompt("Leave a note pinned to this movie — they'll find it next time you watch it:") || "").trim();
  if (!text) return;
  const cap = { key: k, text, from: S.settings.me, date: todayStr() };
  capsules.unshift(cap); store();
  addSys("💌 Time capsule saved for this movie — you'll both find it on the next rewatch");
  netSend({ t: "capsule", cap });
}
export function receiveCapsule(cap) { if (cap && cap.key && cap.text) { capsules.unshift(cap); store(); } }

export function checkCapsules(state) {
  const k = keyOf(state); if (!k) return;
  capsules.filter((c) => c.key === k && !surfaced.has(c.date + "|" + c.text)).forEach((c) => {
    surfaced.add(c.date + "|" + c.text);
    addSys("💌 Time capsule from " + c.from + " (" + c.date + "): " + c.text);
    parentPost({ kind: "toast", text: "💌 " + c.text });
  });
}
