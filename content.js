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
  let stalling = false;      // we're buffering and have asked the partner to wait
  let stalledByPeer = false; // we paused because the partner is buffering
  let stallTimer = null;
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
  const onWaiting = () => { if (!stalling && !suppress) { stalling = true; toPanel({ kind: "video-stall", on: true }); } };
  const onPlaying = () => { if (stalling) { stalling = false; toPanel({ kind: "video-stall", on: false }); } };

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
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("playing", onPlaying);
    toPanel({ kind: "video-found" });
  }
  function detach() {
    if (!video) return;
    video.removeEventListener("play", onPlay);
    video.removeEventListener("pause", onPause);
    video.removeEventListener("seeking", onSeeking);
    video.removeEventListener("seeked", onSeeked);
    video.removeEventListener("ratechange", onRate);
    video.removeEventListener("waiting", onWaiting);
    video.removeEventListener("playing", onPlaying);
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

  // Drift correction: the follower nudges its time toward the initiator's when they
  // slip out of sync (small gaps only — a big gap is a real seek, already synced).
  function applyDrift(d) {
    if (!video) attach(pickVideo());
    if (!video || video.paused || seeking || typeof d.time !== "number") return;
    const drift = Math.abs(video.currentTime - d.time);
    const thresh = typeof d.thresh === "number" ? d.thresh : 1.2;
    if (drift > thresh && drift < 60) {
      guard();
      try { if (IS_NETFLIX) nfx("seek", d.time); else video.currentTime = d.time; } catch (_) {}
    }
  }

  // Pause-on-buffer: pause while the partner is buffering, resume when they recover.
  // guard() stops it echoing back as a sync event; a 15s failsafe avoids a deadlock
  // if both sides buffer at once.
  function setStall(on, maxWait) {
    if (!video) attach(pickVideo());
    if (!video) return;
    clearTimeout(stallTimer);
    try {
      if (on && !video.paused) {
        stalledByPeer = true;
        guard();
        video.pause();
        const ms = (typeof maxWait === "number" ? maxWait : 15) * 1000;
        stallTimer = setTimeout(() => { if (stalledByPeer) { stalledByPeer = false; guard(); video.play().catch(() => {}); } }, ms);
      } else if (!on && stalledByPeer) {
        stalledByPeer = false;
        guard();
        video.play().catch(() => {});
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
  const HEARTS = { heart: "❤️", kiss: "😘", fire: "🔥", laugh: "😂", wow: "😮", sad: "🥲", popcorn: "🍿", confetti: "🎊" };
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

  // ---- Point & annotate: laser pings (tap) + fading telestrator ink (drag) ----
  // A fixed overlay tracked to the video's rect. Coords are normalized (0–1) to that
  // rect so a point maps to the same scene spot in the partner's differently-sized
  // window. (Like the other page effects, this is a windowed-video overlay.)
  let annotOn = false, annotColor = "#ff7ec0";
  let annotWrap = null, annotCanvas = null, annotCtx = null;
  let annotRaf = null, annotActiveUntil = 0;
  let annotDrawing = false, annotMoved = false, annotLast = null;

  function annotEnsure() {
    if (annotWrap && annotWrap.isConnected) return;
    annotWrap = document.createElement("div");
    annotWrap.id = "wt-annot";
    annotCanvas = document.createElement("canvas");
    annotWrap.appendChild(annotCanvas);
    document.documentElement.appendChild(annotWrap);
    annotCtx = annotCanvas.getContext("2d");
    annotWrap.addEventListener("pointerdown", annotDown);
    annotWrap.addEventListener("pointermove", annotMoveEv);
    window.addEventListener("pointerup", annotUp);
  }
  function annotPlace() {
    const v = video || pickVideo();
    if (!v || !annotWrap) return null;
    const r = v.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    annotWrap.style.left = r.left + "px"; annotWrap.style.top = r.top + "px";
    annotWrap.style.width = r.width + "px"; annotWrap.style.height = r.height + "px";
    const w = Math.round(r.width), h = Math.round(r.height);
    if (annotCanvas.width !== w || annotCanvas.height !== h) { annotCanvas.width = w; annotCanvas.height = h; }
    return r;
  }
  function annotLoop() {
    annotPlace();
    if (annotCtx && annotCanvas.width) { // slowly erase old ink (telestrator fade)
      annotCtx.globalCompositeOperation = "destination-out";
      annotCtx.fillStyle = "rgba(0,0,0,0.05)";
      annotCtx.fillRect(0, 0, annotCanvas.width, annotCanvas.height);
      annotCtx.globalCompositeOperation = "source-over";
    }
    if (annotOn || Date.now() < annotActiveUntil) annotRaf = requestAnimationFrame(annotLoop);
    else annotRaf = null;
  }
  function annotKick() { annotActiveUntil = Date.now() + 4000; if (!annotRaf) annotRaf = requestAnimationFrame(annotLoop); }
  function setAnnotate(on, color) {
    if (color) annotColor = color;
    annotOn = !!on;
    annotEnsure();
    annotWrap.style.pointerEvents = annotOn ? "auto" : "none";
    annotWrap.classList.toggle("on", annotOn);
    annotKick();
  }
  function annotNorm(e, r) { return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }; }
  function annotDown(e) {
    if (!annotOn) return;
    const r = annotPlace(); if (!r) return;
    annotDrawing = true; annotMoved = false; annotLast = annotNorm(e, r);
    e.preventDefault();
  }
  function annotMoveEv(e) {
    if (!annotOn || !annotDrawing) return;
    const r = annotPlace(); if (!r) return;
    const p = annotNorm(e, r);
    if (!annotMoved && Math.hypot((p.x - annotLast.x) * r.width, (p.y - annotLast.y) * r.height) < 5) return;
    annotMoved = true;
    annotStroke(annotLast.x, annotLast.y, p.x, p.y, annotColor);
    toPanel({ kind: "annot", akind: "draw", x: annotLast.x, y: annotLast.y, x2: p.x, y2: p.y, color: annotColor });
    annotLast = p;
  }
  function annotUp(e) {
    if (!annotDrawing) return;
    annotDrawing = false;
    if (annotMoved) return;
    const r = annotPlace(); if (!r) return;
    const p = annotNorm(e, r);
    if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return;
    annotPing(p.x, p.y, annotColor);
    toPanel({ kind: "annot", akind: "ping", x: p.x, y: p.y, color: annotColor });
  }
  function annotStroke(x1, y1, x2, y2, color) {
    annotEnsure(); const r = annotPlace(); if (!r || !annotCtx) return;
    annotCtx.strokeStyle = color; annotCtx.lineWidth = 4; annotCtx.lineCap = "round";
    annotCtx.beginPath(); annotCtx.moveTo(x1 * r.width, y1 * r.height); annotCtx.lineTo(x2 * r.width, y2 * r.height); annotCtx.stroke();
    annotKick();
  }
  function annotPing(x, y, color) {
    annotEnsure(); const r = annotPlace(); if (!r) return;
    const ring = document.createElement("div");
    ring.className = "wt-annot-ping";
    ring.style.left = (x * r.width) + "px"; ring.style.top = (y * r.height) + "px";
    ring.style.color = color; ring.style.borderColor = color;
    annotWrap.appendChild(ring);
    setTimeout(() => ring.remove(), 1300);
    annotKick();
  }
  function annotShow(d) {
    if (d.akind === "ping") annotPing(d.x, d.y, d.color || "#8ecbff");
    else if (d.akind === "draw") annotStroke(d.x, d.y, d.x2, d.y2, d.color || "#8ecbff");
  }

  // ---- Cinema mode: dim everything but the video (a shared "lights out") --------
  let cinemaEl = null, cinemaRaf = null;
  function cinemaPlace() {
    const v = video || pickVideo(); if (!v || !cinemaEl) return;
    const r = v.getBoundingClientRect();
    cinemaEl.style.left = r.left + "px"; cinemaEl.style.top = r.top + "px";
    cinemaEl.style.width = r.width + "px"; cinemaEl.style.height = r.height + "px";
  }
  function cinemaLoop() { cinemaPlace(); cinemaRaf = cinemaEl ? requestAnimationFrame(cinemaLoop) : null; }
  function setCinema(on) {
    if (on) {
      if (!cinemaEl) { cinemaEl = document.createElement("div"); cinemaEl.id = "wt-cinema"; document.documentElement.appendChild(cinemaEl); }
      cinemaPlace(); if (!cinemaRaf) cinemaRaf = requestAnimationFrame(cinemaLoop);
    } else if (cinemaEl) { cinemaEl.remove(); cinemaEl = null; }
  }

  // Frame-freeze: capture the current movie frame (fails on DRM/cross-origin video).
  function grabFrame() {
    const v = video || pickVideo();
    if (!v || !v.videoWidth) return null;
    try {
      const c = document.createElement("canvas");
      c.width = Math.min(640, v.videoWidth);
      c.height = Math.round((c.width * v.videoHeight) / v.videoWidth);
      c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", 0.7);
    } catch (_) { return null; } // tainted canvas (DRM) → null
  }

  // Redub subtitles, cover-my-eyes, instant-replay wipe — quick overlay toys.
  let subEl = null, subTimer = null;
  function showSubtitle(text) {
    if (!text) return;
    if (!subEl) { subEl = document.createElement("div"); subEl.id = "wt-subtitle"; document.documentElement.appendChild(subEl); }
    subEl.textContent = text; subEl.style.opacity = "1";
    clearTimeout(subTimer); subTimer = setTimeout(() => { if (subEl) subEl.style.opacity = "0"; }, 5000);
  }
  let coverEl = null;
  function setCover(on) {
    if (on) {
      if (!coverEl) { coverEl = document.createElement("div"); coverEl.id = "wt-cover"; coverEl.innerHTML = "<div>🙈</div><div class='wt-cover-t'>covering your eyes…</div>"; document.documentElement.appendChild(coverEl); }
    } else if (coverEl) { coverEl.remove(); coverEl = null; }
  }
  function replayWipe() {
    const w = document.createElement("div"); w.id = "wt-replay"; w.textContent = "🔁 INSTANT REPLAY";
    document.documentElement.appendChild(w); setTimeout(() => w.remove(), 1300);
  }

  // ---- Ghost cursors: share where you're pointing, with a sparkle trail + a
  // high-five spark when your two cursors meet on the frame. Normalized to the
  // video rect so it maps to the same spot in both windows.
  let presenceOn = false, cursorWrap = null, ghostDot = null, ghostLabel = null, onCursorMove = null;
  let lastLocalCur = null, lastRemoteCur = null, remoteSeenAt = 0, cursorRaf = null, hiFiveAt = 0, presenceName = "Partner";
  function cursorRect() { const v = video || pickVideo(); return v ? v.getBoundingClientRect() : null; }
  function cursorEnsure() {
    if (cursorWrap && cursorWrap.isConnected) return;
    cursorWrap = document.createElement("div"); cursorWrap.id = "wt-cursors";
    ghostDot = document.createElement("div"); ghostDot.className = "wt-ghost";
    ghostLabel = document.createElement("div"); ghostLabel.className = "wt-ghost-label";
    ghostDot.appendChild(ghostLabel); cursorWrap.appendChild(ghostDot);
    document.documentElement.appendChild(cursorWrap);
    if (!cursorRaf) cursorRaf = requestAnimationFrame(cursorLoop);
  }
  function cursorPlace() {
    const r = cursorRect(); if (!r || !cursorWrap) return null;
    cursorWrap.style.left = r.left + "px"; cursorWrap.style.top = r.top + "px";
    cursorWrap.style.width = r.width + "px"; cursorWrap.style.height = r.height + "px";
    return r;
  }
  function cursorLoop() {
    const r = cursorPlace();
    if (r && lastRemoteCur && ghostDot) {
      ghostDot.style.opacity = Date.now() - remoteSeenAt < 2500 ? "1" : "0";
      ghostDot.style.left = lastRemoteCur.x * r.width + "px";
      ghostDot.style.top = lastRemoteCur.y * r.height + "px";
      ghostLabel.textContent = presenceName;
    }
    cursorRaf = (presenceOn || (lastRemoteCur && Date.now() - remoteSeenAt < 2500)) ? requestAnimationFrame(cursorLoop) : null;
  }
  function spawnSparkle(px, py) {
    if (!cursorWrap) return;
    const s = document.createElement("div"); s.className = "wt-sparkle"; s.textContent = "✨";
    s.style.left = px + "px"; s.style.top = py + "px";
    cursorWrap.appendChild(s); setTimeout(() => s.remove(), 700);
  }
  function checkHiFive() {
    if (!lastLocalCur || !lastRemoteCur || Date.now() - remoteSeenAt > 500) return;
    if (Math.hypot(lastLocalCur.x - lastRemoteCur.x, lastLocalCur.y - lastRemoteCur.y) < 0.05 && Date.now() - hiFiveAt > 1500) {
      hiFiveAt = Date.now();
      const r = cursorRect(); if (!r) return;
      const px = lastLocalCur.x * r.width, py = lastLocalCur.y * r.height;
      for (let i = 0; i < 8; i++) setTimeout(() => spawnSparkle(px + (Math.random() * 50 - 25), py + (Math.random() * 50 - 25)), i * 35);
    }
  }
  function setPresence(on) {
    presenceOn = on;
    if (on) {
      cursorEnsure();
      if (!onCursorMove) {
        let last = 0;
        onCursorMove = (e) => {
          const now = Date.now(); if (now - last < 40) return; last = now;
          const r = cursorPlace(); if (!r) return;
          const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
          if (x < -0.05 || x > 1.05 || y < -0.05 || y > 1.05) return;
          lastLocalCur = { x, y }; toPanel({ kind: "cursor", x, y }); checkHiFive();
        };
        window.addEventListener("pointermove", onCursorMove);
      }
    } else if (onCursorMove) { window.removeEventListener("pointermove", onCursorMove); onCursorMove = null; }
  }
  function showRemoteCursor(x, y, name) {
    if (name) presenceName = name;
    lastRemoteCur = { x, y }; remoteSeenAt = Date.now();
    cursorEnsure();
    const r = cursorRect(); if (r) spawnSparkle(x * r.width, y * r.height);
    checkHiFive();
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
      case "drift": applyDrift(msg); break;
      case "stall": setStall(msg.on, msg.maxWait); break;
      case "annotate": setAnnotate(msg.on, msg.color); break;
      case "annot-show": annotShow(msg); break;
      case "cinema": setCinema(msg.on); break;
      case "grab-frame": toPanel({ kind: "frame", img: grabFrame(), meme: msg.meme }); break;
      case "subtitle": showSubtitle(msg.text); break;
      case "cover": setCover(msg.on); break;
      case "replay": replayWipe(); break;
      case "presence": setPresence(msg.on); break;
      case "cursor-show": showRemoteCursor(msg.x, msg.y, msg.name); break;
      case "request-state": sendResponse(currentState()); break;
    }
    // No async sendResponse used, so no need to return true.
  });

  // Let the panel know this tab is here, so it can re-sync after a Join redirect.
  toPanel({ kind: "hello", url: location.href, title: document.title });
})();
