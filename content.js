// WatchTogether — content script.
// The UI + P2P connection now live in the Side Panel. This script just:
//   1. detects and controls the page's <video> (play/pause/seek sync),
//   2. renders page effects (floating hearts, countdown, poke, "Join" banner),
//   3. relays between the page and the side panel over chrome.runtime messaging.
// No injected panel, no page-shift — the browser reserves space for the side
// panel, so nothing overlaps the video on any site.

(() => {
  if (window.__wtInjected) return;
  window.__wtInjected = true;

  // ---- Messaging to the side panel ---------------------------------------
  function toPanel(msg) {
    try {
      chrome.runtime.sendMessage({ __wt: true, ...msg }, () => void chrome.runtime.lastError);
    } catch (_) {}
  }

  // Netflix needs its own player API (netflix-inject.js, main world).
  const IS_NETFLIX = /(^|\.)netflix\.com$/.test(location.hostname);
  function nfx(cmd, time) { window.postMessage({ __wtNetflix: true, cmd, time }, "*"); }

  // ---- Effects overlay (lazily created) ----------------------------------
  let overlay = null;
  function ensureOverlay() {
    if (overlay && overlay.isConnected) return overlay;
    overlay = document.createElement("div");
    overlay.id = "wt-overlay";
    document.documentElement.appendChild(overlay);
    return overlay;
  }

  // ---- Video detection & control -----------------------------------------
  let video = null;
  let duckBase = null; // page-video volume saved while auto-duck lowers it
  let suppress = false;
  let suppressTimer = null;
  let seeking = false;
  let seekingTimer = null;

  function area(el) { const r = el.getBoundingClientRect(); return r.width * r.height; }
  function pickVideo() {
    const vids = Array.from(document.querySelectorAll("video"));
    if (!vids.length) return null;
    const playing = vids.filter((v) => !v.paused && !v.ended && v.readyState > 2);
    const pool = playing.length ? playing : vids;
    pool.sort((a, b) => area(b) - area(a));
    return pool[0];
  }

  function send(action, extra) {
    toPanel({
      kind: "video-event",
      action,
      time: video ? video.currentTime : 0,
      rate: video ? video.playbackRate : 1,
      paused: video ? video.paused : true,
      url: location.href,
      title: document.title,
      ...extra,
    });
  }

  const onPlay = () => { if (!suppress) send("play"); };
  const onPause = () => { if (!suppress && !seeking) send("pause"); };
  const onSeeking = () => { seeking = true; clearTimeout(seekingTimer); seekingTimer = setTimeout(() => { seeking = false; }, 2000); };
  const onSeeked = () => { clearTimeout(seekingTimer); seeking = false; if (!suppress) send("seek"); };
  const onRate = () => { if (!suppress) send("rate"); };

  function attach(v) {
    if (v === video) return;
    detach();
    video = v;
    if (!video) return;
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("ratechange", onRate);
    toPanel({ kind: "video-found" });
  }
  function detach() {
    if (!video) return;
    video.removeEventListener("play", onPlay);
    video.removeEventListener("pause", onPause);
    video.removeEventListener("seeking", onSeeking);
    video.removeEventListener("seeked", onSeeked);
    video.removeEventListener("ratechange", onRate);
    video = null;
  }
  function guard() {
    suppress = true;
    clearTimeout(suppressTimer);
    suppressTimer = setTimeout(() => { suppress = false; }, IS_NETFLIX ? 1500 : 500);
  }

  function videoKey(u) {
    try {
      const x = new URL(u, location.href);
      const v = x.searchParams.get("v");
      if (v) return x.host + "|v=" + v;
      return x.host + x.pathname.replace(/\/+$/, "");
    } catch (_) { return u; }
  }
  function sameVideo(a, b) { return videoKey(a) === videoKey(b); }

  function applyVideo(d) {
    // Different video → do nothing automatically. Following only happens via an
    // explicit invite (the "invite" message → Join banner).
    if (d.url && !sameVideo(d.url, location.href)) return;
    if (!video) attach(pickVideo());
    if (!video) return;
    guard();
    try {
      const drift = typeof d.time === "number" ? Math.abs(video.currentTime - d.time) : 0;
      if (IS_NETFLIX) {
        if (typeof d.time === "number" && drift > 0.5) nfx("seek", d.time);
        if (typeof d.paused === "boolean") nfx(d.paused ? "pause" : "play");
        else if (d.action === "play") nfx("play");
        else if (d.action === "pause") nfx("pause");
        return;
      }
      if (typeof d.rate === "number") video.playbackRate = d.rate;
      if (typeof d.time === "number" && drift > 0.4) video.currentTime = d.time;
      if (typeof d.paused === "boolean") {
        if (d.paused && !video.paused) video.pause();
        else if (!d.paused && video.paused) video.play().catch(() => {});
      } else if (d.action === "play") video.play().catch(() => {});
      else if (d.action === "pause") video.pause();
    } catch (_) {}
  }

  // Auto-duck: quiet the page video while someone is talking, restore afterward.
  function setDuck(on, level) {
    if (!video) attach(pickVideo());
    if (!video) return;
    try {
      if (on) {
        if (duckBase == null) duckBase = video.volume;
        const f = typeof level === "number" ? Math.max(0, Math.min(1, level)) : 0.25;
        video.volume = Math.max(0, duckBase * f);
      } else if (duckBase != null) {
        video.volume = duckBase;
        duckBase = null;
      }
    } catch (_) {}
  }

  function currentState() {
    if (!video) attach(pickVideo());
    const meta = { title: document.title, url: location.href };
    return video
      ? { time: video.currentTime, paused: video.paused, rate: video.playbackRate, duration: video.duration, ...meta }
      : { time: 0, paused: true, rate: 1, duration: 0, ...meta };
  }

  setInterval(() => {
    const v = pickVideo();
    if (v && v !== video) attach(v);
  }, 2500);

  // ---- Page effects -------------------------------------------------------
  const HEARTS = { heart: "❤️", kiss: "😘", fire: "🔥", laugh: "😂", wow: "😮", sad: "🥲" };
  function spawnHearts(kind, count = 14) {
    const cont = ensureOverlay();
    const emoji = HEARTS[kind] || "❤️";
    for (let i = 0; i < count; i++) {
      const el = document.createElement("div");
      el.className = "wt-heart";
      el.textContent = emoji;
      el.style.left = 6 + Math.random() * 88 + "%";
      el.style.setProperty("--wt-drift", (Math.random() * 120 - 60) + "px");
      el.style.setProperty("--wt-rot", (Math.random() * 60 - 30) + "deg");
      el.style.setProperty("--wt-dur", 2.4 + Math.random() * 1.6 + "s");
      el.style.fontSize = 22 + Math.random() * 26 + "px";
      el.style.animationDelay = Math.random() * 0.5 + "s";
      cont.appendChild(el);
      setTimeout(() => el.remove(), 4500);
    }
  }

  let countdownEl = null;
  function showCountdown(n) {
    if (!countdownEl) {
      countdownEl = document.createElement("div");
      countdownEl.id = "wt-countdown";
      ensureOverlay().appendChild(countdownEl);
    }
    countdownEl.innerHTML = "";
    const span = document.createElement("div");
    span.className = "wt-num";
    span.textContent = n > 0 ? String(n) : "▶";
    countdownEl.appendChild(span);
    if (n <= 0) setTimeout(() => { countdownEl?.remove(); countdownEl = null; }, 900);
  }

  function toast(text) {
    const t = document.createElement("div");
    t.id = "wt-toast";
    t.textContent = text;
    ensureOverlay().appendChild(t);
    setTimeout(() => t.remove(), 2700);
  }

  function shake() {
    const root = document.documentElement;
    root.classList.remove("wt-shake");
    void root.offsetWidth;
    root.classList.add("wt-shake");
    setTimeout(() => root.classList.remove("wt-shake"), 600);
  }

  // ---- Follow: "Join what my partner is watching" banner ------------------
  // ---- Messages from the side panel --------------------------------------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.__wt !== true) return;
    switch (msg.kind) {
      case "apply-video": applyVideo(msg); break;
      case "reaction": spawnHearts(msg.reaction); break;
      case "countdown": showCountdown(msg.n); break;
      case "poke": shake(); toast(msg.text || "💗 misses you!"); break;
      case "toast": toast(msg.text); break;
      case "duck": setDuck(msg.on, msg.level); break;
      case "request-state": sendResponse(currentState()); break;
    }
    // No async sendResponse used, so no need to return true.
  });

  // Let the panel know this tab is here, so it can re-sync after a Join redirect.
  toPanel({ kind: "hello", url: location.href, title: document.title });
})();
