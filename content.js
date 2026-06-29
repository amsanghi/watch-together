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

  // Players like YouTube/Netflix size the video with JS off window dimensions
  // and only recompute on a resize event — so after shrinking the page we must
  // fire resize a few times (covering the CSS transition) to make them shrink.
  function fireResize() {
    [0, 120, 280, 500].forEach((t) =>
      setTimeout(() => {
        try { window.dispatchEvent(new Event("resize")); } catch (_) {}
      }, t)
    );
  }

  // Shrink the page so the docked panel sits beside the video instead of over it.
  // The actual margin/max-width live in content.css (html.wt-shifted) so a
  // single-page app can't strip them off the inline style. We only toggle the
  // class here, then fire resize so JS-sized players recompute.
  function setPageShift(on) {
    document.documentElement.classList.toggle("wt-shifted", on);
    fireResize();
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
    syncFullscreen();
    if (show) frame.contentWindow?.postMessage({ __wt: true, kind: "panel-shown" }, "*");
  }

  // Keep the panel + effects visible over native fullscreen video by promoting
  // them to the top layer (popover). This does NOT reparent the iframe, so the
  // WebRTC connection survives. The class/attribute toggles only when needed —
  // a [popover] element is display:none until shown, so we remove it otherwise.
  function topLayer(el, on) {
    if (!el) return;
    try {
      if (on) {
        if (!el.hasAttribute("popover")) el.setAttribute("popover", "manual");
        if (el.showPopover && !el.matches(":popover-open")) el.showPopover();
      } else {
        if (el.hidePopover && el.matches(":popover-open")) el.hidePopover();
        el.removeAttribute("popover");
      }
    } catch (_) {}
  }
  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }
  function syncFullscreen() {
    if (!wrap) return;
    const fs = isFullscreen();
    // Tuck the docked panel to the edge in fullscreen (reveals on hover).
    wrap.classList.toggle("wt-fs", fs && !wrap.classList.contains("wt-float"));
    topLayer(wrap, fs);
    topLayer(overlay, fs);
  }
  document.addEventListener("fullscreenchange", syncFullscreen, true);
  document.addEventListener("webkitfullscreenchange", syncFullscreen, true);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.wt === "toggle") togglePanel();
  });

  // ---- Video detection & control -----------------------------------------
  let video = null;
  let suppress = false; // guard against echoing remote-applied actions
  let suppressTimer = null;

  // Netflix needs its own player API (see netflix-inject.js). We send commands
  // to that main-world script via window.postMessage.
  const IS_NETFLIX = /(^|\.)netflix\.com$/.test(location.hostname);
  function nfx(cmd, time) {
    window.postMessage({ __wtNetflix: true, cmd, time }, "*");
  }

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

  // Every event carries the actual play/paused state so the partner always
  // reconciles to our real state — not just whichever discrete event fired.
  function send(action, extra) {
    frame?.contentWindow?.postMessage(
      {
        __wt: true,
        kind: "video-event",
        action,
        time: video ? video.currentTime : 0,
        rate: video ? video.playbackRate : 1,
        paused: video ? video.paused : true,
        ...extra,
      },
      "*"
    );
  }

  // Players (Prime Video, etc.) fire a transient pause while seeking and resume
  // afterward. Suppress that pause so we don't pause the partner; the seeked
  // event that follows carries the true paused state.
  let seeking = false;
  let seekingTimer = null;

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
    frame?.contentWindow?.postMessage({ __wt: true, kind: "video-found", found: true }, "*");
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
    // Longer on Netflix: API seek + buffering can fire echo events later.
    suppressTimer = setTimeout(() => { suppress = false; }, IS_NETFLIX ? 1500 : 500);
  }

  function applyVideo(d) {
    if (!video) attach(pickVideo());
    if (!video) return;
    guard();
    try {
      const drift = typeof d.time === "number" ? Math.abs(video.currentTime - d.time) : 0;

      // Netflix: never touch the raw element — drive its player API instead.
      if (IS_NETFLIX) {
        if (typeof d.time === "number" && drift > 0.5) nfx("seek", d.time);
        if (typeof d.paused === "boolean") nfx(d.paused ? "pause" : "play");
        else if (d.action === "play") nfx("play");
        else if (d.action === "pause") nfx("pause");
        return;
      }

      if (typeof d.rate === "number") video.playbackRate = d.rate;
      // Match the partner's playhead (skip tiny drift to avoid stutter).
      if (typeof d.time === "number" && drift > 0.4) {
        video.currentTime = d.time;
      }
      // Reconcile play/paused to the sender's actual state when known,
      // so a seek-while-playing keeps both sides playing.
      if (typeof d.paused === "boolean") {
        if (d.paused && !video.paused) video.pause();
        else if (!d.paused && video.paused) video.play().catch(() => {});
      } else if (d.action === "play") {
        video.play().catch(() => {});
      } else if (d.action === "pause") {
        video.pause();
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
      (overlay || document.documentElement).appendChild(countdownEl);
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
    (overlay || document.documentElement).appendChild(t);
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
        syncFullscreen();
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
