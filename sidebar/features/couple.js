// WatchTogether — the couple grab-bag in the Fun panel: mood, secret star
// ratings, shared watchlist, hold-hands, kiss/hug counters, sealed love
// letters, scheduled surprise notes, cuddle/goodnight mode, and the memory
// scrapbook. Persisted collections that are also touched here live on `S`
// (counts, scrapbook, scheduled, handSeconds); the rest is feature-local.
//
// Exports: setMood, showPartnerMood, setMyRating, setPartnerRating,
//   renderWatchlist, addWatchItem, setWatchlist, syncWatchlistOnConnect,
//   loadWatchlist, renderHands, setLocalHold, setRemoteHold, renderCounts,
//   bumpCount, sendLetter, showLetter, openLetter, closeLetter,
//   renderScheduled, addScheduled, checkScheduled, setCuddle, setSleepTimer,
//   renderScrapbook, addMemory, receiveMemory.

import { $ } from "../core/dom.js";
import { S } from "../core/state.js";
import { netSend } from "../core/net.js";
import { parentPost } from "../core/tab.js";
import { spawnPanelHearts, burst } from "./reactions.js";
import { addSys } from "./chat.js";
import { toggleCam, toggleMic } from "../core/media.js";
import { todayStr } from "./stats.js";

// ---- Mood ---------------------------------------------------------------
export function setMood(mood) {
  document.querySelectorAll(".mood-opt").forEach((b) => b.classList.toggle("sel", b.dataset.mood === mood));
  netSend({ t: "mood", mood });
}
export function showPartnerMood(mood) {
  $("partner-mood").textContent = mood ? `${S.settings.partner}: ${mood}` : "";
}

// ---- Rate & reveal ------------------------------------------------------
let myRating = null, partnerRating = null;
export function setMyRating(v) {
  myRating = v;
  document.querySelectorAll("#rate-stars span").forEach((s) => s.classList.toggle("on", Number(s.dataset.v) <= v));
  netSend({ t: "rate", value: v });
  $("rate-status").textContent = partnerRating ? "" : "Sent! Waiting for " + S.settings.partner + "…";
  maybeRevealRatings();
}
export function setPartnerRating(value) { partnerRating = value; maybeRevealRatings(); }
function maybeRevealRatings() {
  if (myRating != null && partnerRating != null) {
    $("rate-status").textContent = `You: ${"★".repeat(myRating)} · ${S.settings.partner}: ${"★".repeat(partnerRating)}`;
  }
}

// ---- Watchlist ----------------------------------------------------------
let watchlist = [];         // [{text, done}]
export function renderWatchlist() {
  const list = $("wl-list");
  list.innerHTML = "";
  watchlist.forEach((it, i) => {
    const row = document.createElement("div");
    row.className = "wl-item" + (it.done ? " done" : "");
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !!it.done;
    cb.addEventListener("change", () => { it.done = cb.checked; saveWatchlist(); });
    const sp = document.createElement("span"); sp.textContent = it.text;
    const x = document.createElement("button"); x.className = "x"; x.textContent = "✕";
    x.addEventListener("click", () => { watchlist.splice(i, 1); saveWatchlist(); });
    row.append(cb, sp, x);
    list.appendChild(row);
  });
}
function saveWatchlist() {
  chrome.storage.local.set({ wt_watchlist: watchlist });
  renderWatchlist();
  netSend({ t: "watchlist", items: watchlist });
}
export function addWatchItem() {
  const t = $("wl-input").value.trim();
  if (!t) return;
  watchlist.push({ text: t, done: false });
  $("wl-input").value = "";
  saveWatchlist();
}
export function setWatchlist(items) { if (Array.isArray(items)) { watchlist = items; renderWatchlist(); } }
export function syncWatchlistOnConnect() { if (watchlist.length) netSend({ t: "watchlist", items: watchlist }); }
export function loadWatchlist(arr) { if (Array.isArray(arr)) { watchlist = arr; renderWatchlist(); } }

// ---- Hold hands ---------------------------------------------------------
let localHold = false, remoteHold = false, holdTimer = null;
function fmtDur(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
}
export function renderHands() {
  $("hold-status").textContent = S.handSeconds ? `🤝 ${fmtDur(S.handSeconds)} held together` : "Hold together to feel each other 💞";
}
export function setLocalHold(on) {
  if (localHold === on) return;
  localHold = on;
  $("hold-btn").classList.toggle("holding", on);
  netSend({ t: "hand", on });
  checkBothHold();
}
export function setRemoteHold(on) { remoteHold = on; checkBothHold(); }
function checkBothHold() {
  const both = localHold && remoteHold;
  $("hold-btn").classList.toggle("both", both);
  if (both && !holdTimer) {
    try { navigator.vibrate && navigator.vibrate([40, 30, 40]); } catch (_) {}
    spawnPanelHearts("heart", 6);
    $("hold-status").textContent = "💞 holding hands…";
    holdTimer = setInterval(() => {
      S.handSeconds++;
      if (S.handSeconds % 4 === 0) spawnPanelHearts("heart", 3);
      $("hold-status").textContent = `💞 ${fmtDur(S.handSeconds)} holding hands…`;
      if (S.handSeconds % 5 === 0) chrome.storage.local.set({ wt_hands: S.handSeconds });
    }, 1000);
  } else if (!both && holdTimer) {
    clearInterval(holdTimer); holdTimer = null;
    chrome.storage.local.set({ wt_hands: S.handSeconds });
    renderHands();
  }
}

// ---- Kiss & hug counters ------------------------------------------------
export function renderCounts() {
  $("kiss-count").textContent = S.counts.kiss || 0;
  $("hug-count").textContent = S.counts.hug || 0;
}
export function bumpCount(kind, fromRemote) {
  if (kind !== "kiss" && kind !== "hug") return;
  S.counts[kind] = (S.counts[kind] || 0) + 1;
  chrome.storage.local.set({ wt_counts: S.counts });
  renderCounts();
  const btn = document.querySelector(`.count-btn[data-count="${kind}"]`);
  if (btn) { btn.classList.remove("pop"); void btn.offsetWidth; btn.classList.add("pop"); }
  burst(kind === "kiss" ? "kiss" : "heart");
  if (!fromRemote) netSend({ t: "count", kind });
  if (S.counts[kind] % 100 === 0) {
    spawnPanelHearts(kind === "kiss" ? "kiss" : "heart", 26);
    parentPost({ kind: "toast", text: `${kind === "kiss" ? "💋" : "🤗"} ${S.counts[kind]} ${kind === "kiss" ? "kisses" : "hugs"} together!` });
  }
}

// ---- Love letters -------------------------------------------------------
export function sendLetter() {
  const t = $("letter-input").value.trim();
  if (!t) { $("letter-input").focus(); return; }
  netSend({ t: "letter", text: t });
  $("letter-input").value = "";
  addSys("💌 Love letter sent");
}
export function showLetter(from, text) {
  if (!text) return;
  $("letter-from").textContent = (from || S.settings.partner) + " wrote:";
  $("letter-body").textContent = text;
  $("letter-paper").classList.add("hidden");
  $("letter-envelope").classList.remove("hidden");
  $("letter-hint").classList.remove("hidden");
  $("letter-overlay").classList.remove("hidden");
}
export function openLetter() {
  $("letter-paper").classList.remove("hidden");
  $("letter-envelope").classList.add("hidden");
  $("letter-hint").classList.add("hidden");
  spawnPanelHearts("heart", 22);
  try { navigator.vibrate && navigator.vibrate(60); } catch (_) {}
}
export function closeLetter() { $("letter-overlay").classList.add("hidden"); }

// ---- Surprise scheduled notes -------------------------------------------
export function renderScheduled() {
  const el = $("sched-list");
  el.innerHTML = "";
  S.scheduled.slice().sort((a, b) => a.when - b.when).forEach((s) => {
    const row = document.createElement("div");
    const when = new Date(s.when);
    const snip = s.text.length > 24 ? s.text.slice(0, 24) + "…" : s.text;
    row.textContent = `⏰ "${snip}" — ${when.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
    el.appendChild(row);
  });
}
export function addScheduled() {
  const text = $("sched-text").value.trim();
  const whenStr = $("sched-when").value;
  if (!text) { $("sched-text").focus(); return; }
  if (!whenStr) { $("sched-when").focus(); return; }
  const when = new Date(whenStr).getTime();
  if (!when || when <= Date.now()) { addSys("Pick a time in the future ⏰"); return; }
  S.scheduled.push({ text, when });
  chrome.storage.local.set({ wt_scheduled: S.scheduled });
  $("sched-text").value = ""; $("sched-when").value = "";
  renderScheduled();
  addSys(`⏰ Surprise note set for ${new Date(when).toLocaleString()} — delivered when you're both online`);
}
export function checkScheduled() {
  if (!S.scheduled.length) return;
  const now = Date.now();
  const due = S.scheduled.filter((s) => s.when <= now);
  if (!due.length) return;
  if (!(S.sendData || (S.rawDC && S.rawDC.readyState === "open"))) return; // keep queued until connected
  due.forEach((s) => netSend({ t: "letter", text: s.text }));
  S.scheduled = S.scheduled.filter((s) => s.when > now);
  chrome.storage.local.set({ wt_scheduled: S.scheduled });
  renderScheduled();
  addSys(`💌 Delivered ${due.length} surprise note${due.length > 1 ? "s" : ""}`);
}

// ---- Cuddle / goodnight mode --------------------------------------------
let cuddleEnd = 0, cuddleTick = null;
export function setCuddle(on, broadcast) {
  $("cuddle-overlay").classList.toggle("hidden", !on);
  $("cuddle-sub").textContent = on ? `Goodnight, ${S.settings.partner} 🌙` : "";
  if (broadcast) netSend({ t: "cuddle", on });
  if (!on) clearCuddleTimer();
  else { try { navigator.vibrate && navigator.vibrate(50); } catch (_) {} }
}
function clearCuddleTimer() {
  if (cuddleTick) { clearInterval(cuddleTick); cuddleTick = null; }
  cuddleEnd = 0;
  $("cuddle-countdown").textContent = "";
  document.querySelectorAll(".cuddle-tmr").forEach((b) => b.classList.remove("on"));
}
export function setSleepTimer(min) {
  clearCuddleTimer();
  const btn = document.querySelector(`.cuddle-tmr[data-min="${min}"]`);
  if (btn) btn.classList.add("on");
  cuddleEnd = Date.now() + min * 60000;
  cuddleTick = setInterval(() => {
    const left = Math.max(0, cuddleEnd - Date.now());
    const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
    $("cuddle-countdown").textContent = `Sleep timer: ${m}:${String(s).padStart(2, "0")}`;
    if (left <= 0) { clearCuddleTimer(); fadeToSleep(); }
  }, 1000);
}
function fadeToSleep() {
  if (S.camOn) toggleCam();
  if (S.micOn) toggleMic();
  parentPost({ kind: "apply-video", action: "pause" });
  $("cuddle-countdown").textContent = "Sweet dreams 💤";
}

// ---- Memory scrapbook ---------------------------------------------------
export function renderScrapbook() {
  const list = $("mem-list");
  list.innerHTML = "";
  if (!S.scrapbook.length) { list.innerHTML = '<div class="muted small">No memories yet — add your first 💕</div>'; return; }
  S.scrapbook.forEach((m) => {
    const row = document.createElement("div");
    row.className = "wl-item";
    row.style.flexWrap = "wrap";
    const sp = document.createElement("span"); sp.textContent = m.img ? "📸 Photobooth" : m.text;
    const d = document.createElement("small"); d.className = "muted"; d.style.marginLeft = "auto"; d.textContent = m.date || "";
    row.append(sp, d);
    if (m.img) {
      const img = document.createElement("img");
      img.className = "mem-thumb"; img.src = m.img; img.alt = "memory";
      row.appendChild(img);
    }
    list.appendChild(row);
  });
}
export function addMemory() {
  const t = $("mem-input").value.trim();
  if (!t) return;
  const item = { text: t, date: todayStr() };
  S.scrapbook.unshift(item); S.scrapbook = S.scrapbook.slice(0, 100);
  chrome.storage.local.set({ wt_scrapbook: S.scrapbook });
  $("mem-input").value = "";
  renderScrapbook();
  netSend({ t: "memory", item });
}
export function receiveMemory(item) {
  if (item) { S.scrapbook.unshift(item); S.scrapbook = S.scrapbook.slice(0, 100); chrome.storage.local.set({ wt_scrapbook: S.scrapbook }); renderScrapbook(); }
}
