// WatchTogether — the "us at a glance" data: watch-night count + streak +
// history, days-together, upcoming anniversary/birthday, and the partner's
// clock (from their shared timezone). `todayStr()` is the shared date-key
// helper used by the scrapbook/gallery too.
//
// Exports: todayStr, recordSession, refreshStats, renderHistory, refreshDates.

import { $ } from "../core/dom.js";
import { S } from "../core/state.js";
import { getPageState, parentPost } from "../core/tab.js";
import { burst } from "./reactions.js";
import { addSys } from "./chat.js";

// ---- Date helpers -------------------------------------------------------
export function todayStr() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function dayDiff(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

// ---- Watch stats / streak / history -------------------------------------
let sessionRecorded = false;
export async function recordSession() {
  if (sessionRecorded) return;
  sessionRecorded = true;
  const s = await getPageState();
  chrome.storage.local.get(["wt_stats"], (r) => {
    const st = r.wt_stats || { count: 0, streak: 0, lastDate: null, history: [] };
    const today = todayStr();
    if (st.lastDate !== today) {
      st.streak = st.lastDate && dayDiff(st.lastDate, today) === 1 ? st.streak + 1 : 1;
      st.lastDate = today;
    }
    st.count += 1;
    st.history.unshift({ title: s?.title || "A video", url: s?.url || "", date: today });
    st.history = st.history.slice(0, 50);
    chrome.storage.local.set({ wt_stats: st }, refreshStats);
  });
}
export function refreshStats() {
  chrome.storage.local.get(["wt_stats"], (r) => {
    const st = r.wt_stats || { count: 0, streak: 0, history: [] };
    $("streak").textContent = `🔥 ${st.streak || 0} day streak`;
    $("watch-count").textContent = `🎬 ${st.count || 0} together`;
  });
}
export function renderHistory() {
  chrome.storage.local.get(["wt_stats"], (r) => {
    const st = r.wt_stats || { history: [] };
    const list = $("history-list");
    list.innerHTML = "";
    if (!st.history.length) { list.innerHTML = '<div class="muted small">No watch nights yet — your first one is waiting 💕</div>'; return; }
    st.history.forEach((h) => {
      const el = document.createElement("div");
      el.className = "hist-item";
      const t = document.createElement("div"); t.className = "t"; t.textContent = h.title;
      const d = document.createElement("div"); d.className = "d"; d.textContent = h.date + (h.url ? " · " + new URL(h.url).hostname : "");
      el.appendChild(t); el.appendChild(d);
      list.appendChild(el);
    });
  });
}

// ---- Poster shelf: the movies you've watched, as colored spines ----------
function hashHue(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 360; }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
export function renderShelf() {
  const shelf = $("shelf"); if (!shelf) return;
  chrome.storage.local.get(["wt_stats"], (r) => {
    const st = r.wt_stats || { history: [] };
    shelf.innerHTML = "";
    if (!st.history.length) { shelf.innerHTML = '<div class="muted small">Your shelf fills up as you watch 🎬</div>'; return; }
    st.history.forEach((h) => {
      const hue = hashHue(h.title || "");
      const el = document.createElement("div"); el.className = "poster";
      el.style.background = "linear-gradient(160deg, hsl(" + hue + ",55%,44%), hsl(" + ((hue + 40) % 360) + ",55%,26%))";
      el.innerHTML = '<div class="poster-t">' + esc(h.title || "A video") + '</div><div class="poster-d">' + esc(h.date || "") + "</div>";
      shelf.appendChild(el);
    });
  });
}

// ---- "One year ago" — resurface a watch from this date in a past year -----
const annShown = new Set();
export function checkAnniversaryWatch() {
  chrome.storage.local.get(["wt_stats"], (r) => {
    const st = r.wt_stats || { history: [] };
    const now = new Date();
    st.history.forEach((h) => {
      if (!h.date) return;
      const d = new Date(h.date + "T00:00:00");
      const years = now.getFullYear() - d.getFullYear();
      const same = d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
      if (years >= 1 && same && !annShown.has(h.date + h.title)) {
        annShown.add(h.date + h.title);
        addSys("💞 " + years + " year" + (years > 1 ? "s" : "") + " ago today you watched: " + h.title);
      }
    });
  });
}

// ---- Dates: days together, next event, partner's clock ------------------
function daysBetween(dateStr, ref) {
  return Math.floor((ref - new Date(dateStr + "T00:00:00")) / 86400000);
}
function nextOccurrence(mmdd) {
  const now = new Date();
  let y = now.getFullYear();
  const d = new Date(mmdd); // a date input value YYYY-MM-DD
  const cand = new Date(y, d.getMonth(), d.getDate());
  if (cand < new Date(now.getFullYear(), now.getMonth(), now.getDate())) cand.setFullYear(y + 1);
  return cand;
}
export function refreshDates() {
  const now = new Date();
  if (S.settings.anniversary) {
    const n = daysBetween(S.settings.anniversary, now);
    $("days-together").textContent = n >= 0 ? `💕 ${n.toLocaleString()} days together` : "💕 counting down…";
  } else {
    $("days-together").textContent = "💕 set your dates in ⚙ settings";
  }
  // next event among anniversary + birthdays
  const events = [];
  if (S.settings.anniversary) events.push(["💞 Anniversary", nextOccurrence(S.settings.anniversary)]);
  if (S.settings.bdayMe) events.push(["🎂 Your birthday", nextOccurrence(S.settings.bdayMe)]);
  if (S.settings.bdayPartner) events.push([`🎂 ${S.settings.partner}'s birthday`, nextOccurrence(S.settings.bdayPartner)]);
  events.sort((a, b) => a[1] - b[1]);
  if (events.length) {
    const [label, when] = events[0];
    const days = Math.round((when - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
    $("next-event").textContent = days === 0 ? `${label} is TODAY! 🎉` : `${label} in ${days} day${days === 1 ? "" : "s"}`;
    if (days === 0) celebrate();
  } else { $("next-event").textContent = ""; }
  // partner clock
  if (S.partnerTz != null) {
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const theirs = new Date(utc + S.partnerTz * 60000);
    const hh = String(theirs.getHours()).padStart(2, "0"), mm = String(theirs.getMinutes()).padStart(2, "0");
    const sky = theirs.getHours() >= 6 && theirs.getHours() < 19 ? "☀️" : "🌙";
    $("partner-clock").textContent = `${sky} ${S.settings.partner}'s time: ${hh}:${mm}`;
  } else { $("partner-clock").textContent = ""; }
}
let celebratedToday = false;
function celebrate() {
  if (celebratedToday) return;
  celebratedToday = true;
  burst("heart");
  parentPost({ kind: "toast", text: "🎉 Happy day, lovebirds! 💕" });
}
