// WatchTogether — content script.
// Responsibilities:
//   1. Inject the sidebar iframe (the whole app UI + WebRTC live inside it).
//   2. Detect and control the page's <video> element, sync play/pause/seek.
//   3. Render page-level effects: floating hearts, countdown, poke shake/toast.
//   4. Bridge messages between the page and the iframe.

(() => {
  if (window.__wtInjected) return;
  window.__wtInjected = true;

  const FRAME_URL = chrome.runtime.getURL("sidebar/sidebar.html");
  let wrap = null;
  let frame = null;
  let overlay = null;
  let dragging = false;

  // ---- UI injection -------------------------------------------------------
  function ensureUI() {
    if (wrap) return;
    wrap = document.createElement("div");
    wrap.id = "wt-root";
    wrap.className = "wt-dock wt-hidden";

    frame = document.createElement("iframe");
    frame.id = "wt-frame";
    frame.allow = "camera; microphone; autoplay; display-capture; clipboard-read; clipboard-write";
    frame.src = FRAME_URL;
    wrap.appendChild(frame);

    overlay = document.createElement("div");
    overlay.id = "wt-overlay";

    const root = document.documentElement;
    root.appendChild(wrap);
    root.appendChild(overlay);
  }

  const DOCK_W = 372; // keep in sync with #wt-root width in content.css

  // Shrink the page so the docked panel sits beside the video instead of over it.
  function setPageShift(on) {
    const el = document.documentElement;
    el.style.transition = "margin-right 0.25s ease";
    el.style.marginRight = on ? DOCK_W + "px" : "";
  }
  function syncPageShift() {
    if (!wrap) return setPageShift(false);
    const visible = !wrap.classList.contains("wt-hidden");
    const dock = !wrap.classList.contains("wt-float");
    setPageShift(visible && dock);
  }

  function togglePanel(forceShow) {
    ensureUI();
    const hidden = wrap.classList.contains("wt-hidden");
    const show = forceShow != null ? forceShow : hidden;
    wrap.classList.toggle("wt-hidden", !show);
    syncPageShift();
    if (show) frame.contentWindow?.postMessage({ __wt: true, kind: "panel-shown" }, "*");
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.wt === "toggle") togglePanel();
  });

  // ---- Video detection & control -----------------------------------------
  let video = null;
  let suppress = false; // guard against echoing remote-applied actions
  let suppressTimer = null;

  function area(el) {
    const r = el.getBoundingClientRect();
    return r.width * r.height;
  }

  function pickVideo() {
    const vids = Array.from(document.querySelectorAll("video"));
    if (!vids.length) return null;
    // Prefer a playing video, then the largest one with a real duration.
    const playing = vids.filter((v) => !v.paused && !v.ended && v.readyState > 2);
    const pool = playing.length ? playing : vids;
    pool.sort((a, b) => area(b) - area(a));
    return pool[0];
  }

  function send(action, extra) {
    frame?.contentWindow?.postMessage(
      { __wt: true, kind: "video-event", action, time: video ? video.currentTime : 0, rate: video ? video.playbackRate : 1, ...extra },
      "*"
    );
  }

  const onPlay = () => { if (!suppress) send("play"); };
  const onPause = () => { if (!suppress) send("pause"); };
  const onSeeked = () => { if (!suppress) send("seek"); };
  const onRate = () => { if (!suppress) send("rate"); };

  function attach(v) {
    if (v === video) return;
    detach();
    video = v;
    if (!video) return;
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("ratechange", onRate);
    frame?.contentWindow?.postMessage({ __wt: true, kind: "video-found", found: true }, "*");
  }

  function detach() {
    if (!video) return;
    video.removeEventListener("play", onPlay);
    video.removeEventListener("pause", onPause);
    video.removeEventListener("seeked", onSeeked);
    video.removeEventListener("ratechange", onRate);
    video = null;
  }

  function guard() {
    suppress = true;
    clearTimeout(suppressTimer);
    suppressTimer = setTimeout(() => { suppress = false; }, 500);
  }

  function applyVideo(d) {
    if (!video) attach(pickVideo());
    if (!video) return;
    guard();
    try {
      if (typeof d.rate === "number" && d.action !== "rate") video.playbackRate = d.rate;
      switch (d.action) {
        case "play":
          if (typeof d.time === "number" && Math.abs(video.currentTime - d.time) > 0.6) video.currentTime = d.time;
          video.play().catch(() => {});
          break;
        case "pause":
          video.pause();
          if (typeof d.time === "number") video.currentTime = d.time;
          break;
        case "seek":
          if (typeof d.time === "number") video.currentTime = d.time;
          break;
        case "rate":
          if (typeof d.rate === "number") video.playbackRate = d.rate;
          break;
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

  // Re-scan for the active video periodically (sites swap elements around).
  setInterval(() => {
    const v = pickVideo();
    if (v && v !== video) attach(v);
  }, 2500);

  // ---- Page effects -------------------------------------------------------
  const HEARTS = { heart: "❤️", kiss: "😘", fire: "🔥", laugh: "😂", wow: "😮", sad: "🥲" };

  function spawnHearts(kind, count = 14) {
    if (!overlay) return;
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
      overlay.appendChild(el);
      setTimeout(() => el.remove(), 4500);
    }
  }

  let countdownEl = null;
  function showCountdown(n) {
    if (!countdownEl) {
      countdownEl = document.createElement("div");
      countdownEl.id = "wt-countdown";
      document.documentElement.appendChild(countdownEl);
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
    document.documentElement.appendChild(t);
    setTimeout(() => t.remove(), 2700);
  }

  function shake() {
    const root = document.documentElement;
    root.classList.remove("wt-shake");
    void root.offsetWidth; // reflow to restart animation
    root.classList.add("wt-shake");
    setTimeout(() => root.classList.remove("wt-shake"), 600);
  }

  // ---- Message bridge (iframe -> content) ---------------------------------
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || d.__wt !== true) return;
    if (frame && e.source !== frame.contentWindow) return;

    switch (d.kind) {
      case "apply-video":
        applyVideo(d);
        break;
      case "request-state": {
        const s = currentState();
        frame?.contentWindow?.postMessage({ __wt: true, kind: "state-reply", state: s, reqId: d.reqId }, "*");
        break;
      }
      case "reaction":
        spawnHearts(d.reaction);
        break;
      case "countdown":
        showCountdown(d.n);
        break;
      case "poke":
        shake();
        toast(d.text || "💗 misses you!");
        break;
      case "toast":
        toast(d.text);
        break;
      case "set-layout":
        ensureUI();
        wrap.classList.toggle("wt-float", d.mode === "float");
        wrap.classList.toggle("wt-dock", d.mode !== "float");
        if (d.mode === "dock") { wrap.style.left = ""; wrap.style.top = ""; wrap.style.right = ""; wrap.style.bottom = ""; }
        syncPageShift();
        break;
      case "close-panel":
        togglePanel(false);
        break;
      case "drag-start":
        dragging = true;
        break;
      case "drag-move":
        if (dragging && wrap && wrap.classList.contains("wt-float")) {
          const rect = wrap.getBoundingClientRect();
          let nx = rect.left + d.dx;
          let ny = rect.top + d.dy;
          nx = Math.max(0, Math.min(window.innerWidth - rect.width, nx));
          ny = Math.max(0, Math.min(window.innerHeight - rect.height, ny));
          wrap.style.left = nx + "px";
          wrap.style.top = ny + "px";
          wrap.style.right = "auto";
          wrap.style.bottom = "auto";
        }
        break;
      case "drag-end":
        dragging = false;
        break;
    }
  });
})();
