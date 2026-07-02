// WatchTogether — reaction timeline: bookmark a moment in whatever you're
// watching (emoji + timestamp), then tap it to jump you both back there.
// Persisted as wt_timeline; the list itself is feature-local (loaded via
// loadTimeline from the init storage read).
//
// Exports: bookmarkMoment, addTimelineItem, renderTimeline, clearTimeline,
//   loadTimeline.

import { $ } from "../core/dom.js";
import { S } from "../core/state.js";
import { netSend } from "../core/net.js";
import { getPageState, parentPost } from "../core/tab.js";
import { burst } from "./reactions.js";
import { addSys } from "./chat.js";

let timeline = [];

function fmtClock(sec) {
  sec = Math.floor(sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ":" : "") + String(m).padStart(h ? 2 : 1, "0") + ":" + String(s).padStart(2, "0");
}
export async function bookmarkMoment(emoji) {
  const st = await getPageState();
  if (!st || st.time == null) { addSys("Play a video first to bookmark a moment 🎬"); return; }
  const item = { time: Math.floor(st.time), emoji, who: S.settings.me, title: st.title || "", url: st.url || "" };
  addTimelineItem(item);
  burst("heart");
  addSys(`🔖 Bookmarked ${emoji} at ${fmtClock(item.time)}`);
  netSend({ t: "mark", time: item.time, emoji, who: S.settings.me, title: item.title, url: item.url });
}
export function addTimelineItem(item) {
  timeline.push(item);
  timeline.sort((a, b) => a.time - b.time);
  timeline = timeline.slice(0, 200);
  chrome.storage.local.set({ wt_timeline: timeline });
  renderTimeline();
}
export function renderTimeline() {
  const list = $("timeline-list"); if (!list) return;
  list.innerHTML = "";
  if (!timeline.length) { list.innerHTML = '<div class="muted small">No moments yet — tap an emoji above while watching 💕</div>'; return; }
  timeline.forEach((m, i) => {
    const row = document.createElement("div"); row.className = "wl-item";
    const sp = document.createElement("span");
    sp.textContent = `${m.emoji} ${fmtClock(m.time)} · ${m.who}`;
    sp.title = "Jump here together"; sp.style.cursor = "pointer";
    sp.addEventListener("click", () => jumpToMoment(m));
    const x = document.createElement("button"); x.className = "x"; x.textContent = "✕";
    x.addEventListener("click", () => { timeline.splice(i, 1); chrome.storage.local.set({ wt_timeline: timeline }); renderTimeline(); });
    row.append(sp, x); list.appendChild(row);
  });
}
function jumpToMoment(m) {
  parentPost({ kind: "apply-video", action: "play", time: m.time, url: m.url, fromName: S.settings.me });
  netSend({ t: "video", action: "seek", time: m.time, url: m.url });
}
export function clearTimeline() { timeline = []; chrome.storage.local.set({ wt_timeline: timeline }); renderTimeline(); }

// Load persisted moments from the init storage read.
export function loadTimeline(arr) { timeline = Array.isArray(arr) ? arr : []; renderTimeline(); }
