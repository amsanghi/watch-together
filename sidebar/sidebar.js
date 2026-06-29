/* WatchTogether — sidebar app logic.
   Lives inside an extension-origin iframe injected into the page so that
   getUserMedia works on any host site. Talks to the page via window.parent
   postMessage, and to the partner via PeerJS (broker) or a raw
   RTCPeerConnection (manual copy-paste). Both paths feed one message handler. */

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const parentPost = (msg) => window.parent.postMessage({ __wt: true, ...msg }, "*");

  // ---- State --------------------------------------------------------------
  let settings = { me: "You", partner: "Partner", tenorKey: "", autocam: true };
  let peer = null;          // PeerJS instance (broker mode)
  let conn = null;          // PeerJS DataConnection
  let currentCall = null;   // PeerJS MediaConnection
  let rawPC = null;         // RTCPeerConnection (manual mode)
  let rawDC = null;         // RTCDataChannel (manual mode)
  let remotePeerId = null;
  let localStream = null;
  let mediaTried = false;
  let mediaDenied = false;
  let micOn = false, camOn = false;
  let connectedOnce = false;
  let amInitiator = false;
  let floatMode = false;
  let sessionRecorded = false;
  const remoteState = { mic: false, cam: false };

  // ---- Settings -----------------------------------------------------------
  function loadSettings() {
    chrome.storage.local.get(["wt_settings"], (r) => {
      if (r.wt_settings) settings = { ...settings, ...r.wt_settings };
      $("me-name").textContent = settings.me;
      $("set-me").value = settings.me;
      $("set-partner").value = settings.partner;
      $("set-tenor").value = settings.tenorKey;
      $("set-autocam").checked = settings.autocam;
      $("local-label").textContent = settings.me;
      $("remote-label").textContent = settings.partner;
      refreshStats();
    });
  }
  function saveSettings() {
    settings.me = $("set-me").value.trim() || "You";
    settings.partner = $("set-partner").value.trim() || "Partner";
    settings.tenorKey = $("set-tenor").value.trim();
    settings.autocam = $("set-autocam").checked;
    chrome.storage.local.set({ wt_settings: settings });
    $("me-name").textContent = settings.me;
    $("local-label").textContent = settings.me;
    $("remote-label").textContent = settings.partner;
    showPanel(connectedOnce ? "live" : "connect");
  }

  // ---- Panels -------------------------------------------------------------
  function showPanel(name) {
    ["connect", "live", "settings", "history"].forEach((p) => {
      $(p + "-panel").classList.toggle("hidden", p !== name);
    });
  }

  // ---- Networking abstraction --------------------------------------------
  function netSend(obj) {
    try {
      if (conn && conn.open) conn.send(obj);
      else if (rawDC && rawDC.readyState === "open") rawDC.send(JSON.stringify(obj));
    } catch (_) {}
  }

  function setStatus(s) {
    const dot = $("status-dot");
    dot.className = "dot " + s; // off | connecting | on
    dot.title = s === "on" ? "Connected" : s === "connecting" ? "Connecting…" : "Disconnected";
    $("presence-heart").className = s === "on" ? "heart-beat" : "heart-idle";
  }

  function onConnected() {
    if (connectedOnce) return;
    connectedOnce = true;
    setStatus("on");
    showPanel("live");
    addSys(`Connected 💞 Say hi to ${settings.partner}!`);
    netSend({ t: "name", name: settings.me });
    netSend({ t: "media-state", mic: micOn, cam: camOn });
    if (amInitiator) netSend({ t: "sync-req" });
    recordSession();
  }

  function onDisconnected() {
    if (!connectedOnce) return;
    setStatus("off");
    addSys("Disconnected.");
  }

  // PeerJS DataConnection wiring
  function wireConn(c) {
    conn = c;
    remotePeerId = c.peer;
    c.on("open", onConnected);
    c.on("data", (d) => handleData(d));
    c.on("close", onDisconnected);
    c.on("error", (e) => showError("Connection error: " + (e?.message || e)));
  }

  // Raw RTCDataChannel wiring
  function wireDC(dc) {
    rawDC = dc;
    dc.onopen = onConnected;
    dc.onmessage = (e) => { try { handleData(JSON.parse(e.data)); } catch (_) {} };
    dc.onclose = onDisconnected;
  }

  // ---- Broker (PeerJS) ----------------------------------------------------
  function shortCode() {
    const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let s = "";
    for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  function makePeer(id) {
    if (typeof Peer === "undefined") {
      showError("PeerJS failed to load. Use Manual mode instead.");
      return null;
    }
    // "wt-" prefix avoids collisions with other apps on the public broker.
    const p = id ? new Peer("wt-" + id) : new Peer();
    p.on("error", (e) => {
      if (e.type === "unavailable-id") showError("That room code is taken — try creating again.");
      else if (e.type === "peer-unavailable") showError("No one is in that room yet, or the code is wrong.");
      else showError("Broker error: " + e.type);
      setStatus("off");
    });
    return p;
  }

  async function createRoom() {
    showError("");
    const code = shortCode();
    setStatus("connecting");
    peer = makePeer(code);
    if (!peer) return;
    peer.on("open", () => {
      $("room-code").textContent = code;
      $("room-share").classList.remove("hidden");
      addSysReady();
    });
    peer.on("connection", (c) => wireConn(c));
    peer.on("call", async (call) => {
      await ensureMedia();
      call.answer(localStream || undefined);
      currentCall = call;
      call.on("stream", remoteStreamHandler);
    });
  }

  async function joinRoom() {
    showError("");
    const raw = $("join-code").value.trim().toUpperCase().replace(/^WT-/, "");
    if (!raw) return showError("Enter the room code your partner shared.");
    amInitiator = true;
    setStatus("connecting");
    peer = makePeer(null);
    if (!peer) return;
    peer.on("open", async () => {
      wireConn(peer.connect("wt-" + raw, { reliable: true }));
      await ensureMedia();
      try {
        currentCall = peer.call("wt-" + raw, localStream || new MediaStream());
        currentCall.on("stream", remoteStreamHandler);
      } catch (_) {}
    });
  }

  // ---- Manual mode (raw WebRTC, copy-paste) -------------------------------
  function newPC() {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    });
    pc.ontrack = (e) => remoteStreamHandler(e.streams[0]);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") onConnected();
      if (["failed", "disconnected", "closed"].includes(pc.connectionState)) onDisconnected();
    };
    return pc;
  }
  function iceComplete(pc) {
    return new Promise((res) => {
      if (pc.iceGatheringState === "complete") return res();
      const f = () => {
        if (pc.iceGatheringState === "complete") {
          pc.removeEventListener("icegatheringstatechange", f);
          res();
        }
      };
      pc.addEventListener("icegatheringstatechange", f);
      setTimeout(res, 4000); // proceed even if a relay candidate lingers
    });
  }
  const enc = (o) => btoa(JSON.stringify(o));
  const dec = (s) => JSON.parse(atob(s.trim()));

  async function manualHost() {
    showError("");
    setStatus("connecting");
    rawPC = newPC();
    wireDC(rawPC.createDataChannel("wt"));
    await ensureMedia();
    if (localStream) localStream.getTracks().forEach((t) => rawPC.addTrack(t, localStream));
    const offer = await rawPC.createOffer();
    await rawPC.setLocalDescription(offer);
    await iceComplete(rawPC);
    $("host-offer").value = enc(rawPC.localDescription);
  }
  async function manualHostFinish() {
    try {
      await rawPC.setRemoteDescription(dec($("host-answer").value));
    } catch (e) {
      showError("Couldn't read that reply code. Make sure you pasted all of it.");
    }
  }
  async function manualGuestGen() {
    showError("");
    setStatus("connecting");
    amInitiator = true;
    rawPC = newPC();
    rawPC.ondatachannel = (e) => wireDC(e.channel);
    try {
      await rawPC.setRemoteDescription(dec($("guest-offer").value));
    } catch (e) {
      return showError("Couldn't read that invite code. Make sure you pasted all of it.");
    }
    await ensureMedia();
    if (localStream) localStream.getTracks().forEach((t) => rawPC.addTrack(t, localStream));
    const ans = await rawPC.createAnswer();
    await rawPC.setLocalDescription(ans);
    await iceComplete(rawPC);
    $("guest-answer").value = enc(rawPC.localDescription);
  }

  // ---- Media (mic / cam) --------------------------------------------------
  async function ensureMedia() {
    if (mediaTried) return localStream;
    mediaTried = true;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      localStream.getAudioTracks().forEach((t) => (t.enabled = false));
      localStream.getVideoTracks().forEach((t) => (t.enabled = false));
      $("local-video").srcObject = localStream;
      micOn = false; camOn = false;
      updateMediaButtons();
    } catch (e) {
      mediaDenied = true;
      addSys("Mic/cam unavailable — chat & sync still work. (" + (e.name || "blocked") + ")");
    }
    return localStream;
  }

  async function toggleMic() {
    await ensureMedia();
    if (!localStream) return;
    micOn = !micOn;
    localStream.getAudioTracks().forEach((t) => (t.enabled = micOn));
    updateMediaButtons();
    ensureCall();
    netSend({ t: "media-state", mic: micOn, cam: camOn });
  }
  async function toggleCam() {
    await ensureMedia();
    if (!localStream) return;
    camOn = !camOn;
    localStream.getVideoTracks().forEach((t) => (t.enabled = camOn));
    $("local-video").parentElement.classList.toggle("live", camOn);
    updateMediaButtons();
    ensureCall();
    netSend({ t: "media-state", mic: micOn, cam: camOn });
  }
  function updateMediaButtons() {
    $("btn-mic").className = "media-btn " + (micOn ? "on" : "off");
    $("btn-cam").className = "media-btn " + (camOn ? "on" : "off");
    $("local-off").textContent = mediaDenied ? "blocked" : "cam off";
    $("local-off").style.display = camOn ? "none" : "flex";
  }
  // If broker mode connected but no media call yet (lazy), start one now.
  function ensureCall() {
    if (currentCall || !peer || !remotePeerId || !localStream) return;
    try {
      currentCall = peer.call(remotePeerId, localStream);
      currentCall.on("stream", remoteStreamHandler);
    } catch (_) {}
  }
  function remoteStreamHandler(stream) {
    const rv = $("remote-video");
    rv.srcObject = stream;
    updateRemoteTile();
  }
  function updateRemoteTile() {
    const tile = $("remote-video").parentElement;
    const hasStream = !!$("remote-video").srcObject;
    tile.classList.toggle("live", hasStream && remoteState.cam);
    $("remote-off").textContent = !hasStream ? "waiting…" : remoteState.cam ? "" : "cam off";
    $("remote-off").style.display = hasStream && remoteState.cam ? "none" : "flex";
  }

  // ---- Incoming data handler ---------------------------------------------
  async function handleData(d) {
    if (!d || !d.t) return;
    switch (d.t) {
      case "name":
        settings.partner = d.name || settings.partner;
        $("remote-label").textContent = settings.partner;
        break;
      case "chat":
        addMsg({ mine: false, who: settings.partner, text: d.text });
        break;
      case "gif":
        addMsg({ mine: false, who: settings.partner, gif: d.url });
        break;
      case "reaction":
        parentPost({ kind: "reaction", reaction: d.reaction });
        break;
      case "video":
        parentPost({ kind: "apply-video", action: d.action, time: d.time, rate: d.rate });
        break;
      case "sync-req": {
        const s = await getPageState();
        netSend({ t: "sync-state", state: s });
        break;
      }
      case "sync-state":
        if (d.state) {
          parentPost({ kind: "apply-video", action: d.state.paused ? "pause" : "play", time: d.state.time, rate: d.state.rate });
          addSys(`Synced to ${settings.partner}'s spot ⏱️`);
        }
        break;
      case "typing":
        showTyping(d.on);
        break;
      case "poke":
        parentPost({ kind: "poke", text: `💗 ${settings.partner} misses you!` });
        beatFast();
        break;
      case "countdown":
        runCountdown(false);
        break;
      case "media-state":
        remoteState.mic = d.mic; remoteState.cam = d.cam;
        updateRemoteTile();
        break;
    }
  }

  // ---- Page state request (from content script) --------------------------
  let stateReqId = 0;
  const stateWaiters = {};
  function getPageState() {
    return new Promise((res) => {
      const id = ++stateReqId;
      stateWaiters[id] = res;
      parentPost({ kind: "request-state", reqId: id });
      setTimeout(() => { if (stateWaiters[id]) { delete stateWaiters[id]; res(null); } }, 1500);
    });
  }

  // ---- Chat UI ------------------------------------------------------------
  function addMsg({ mine, who, text, gif }) {
    const el = document.createElement("div");
    el.className = "msg " + (mine ? "me" : "them");
    if (!mine) {
      const w = document.createElement("div");
      w.className = "who"; w.textContent = who;
      el.appendChild(w);
    }
    if (text) {
      const t = document.createElement("div");
      t.textContent = text;
      el.appendChild(t);
    }
    if (gif) {
      const img = document.createElement("img");
      img.src = gif; img.alt = "gif";
      el.appendChild(img);
    }
    const chat = $("chat");
    chat.appendChild(el);
    chat.scrollTop = chat.scrollHeight;
  }
  function addSys(text) {
    const el = document.createElement("div");
    el.className = "msg sys";
    el.textContent = text;
    $("chat").appendChild(el);
    $("chat").scrollTop = $("chat").scrollHeight;
  }
  function addSysReady() { /* placeholder for future "room ready" hint */ }

  let typingTimer = null;
  function showTyping(on) {
    const el = $("typing-ind");
    el.classList.toggle("hidden", !on);
    el.textContent = on ? `${settings.partner} is typing…` : "";
    clearTimeout(typingTimer);
    if (on) typingTimer = setTimeout(() => el.classList.add("hidden"), 4000);
  }

  function sendChat() {
    const input = $("msg-input");
    const text = input.value.trim();
    if (!text) return;
    addMsg({ mine: true, text });
    netSend({ t: "chat", text });
    input.value = "";
    netSend({ t: "typing", on: false });
  }

  // ---- Couple features ----------------------------------------------------
  function sendReaction(kind) {
    netSend({ t: "reaction", reaction: kind });
    parentPost({ kind: "reaction", reaction: kind });
  }
  function beatFast() {
    const h = $("presence-heart");
    h.style.animationDuration = "0.5s";
    setTimeout(() => (h.style.animationDuration = ""), 2500);
  }
  function runCountdown(initiator) {
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

  // ---- Emoji --------------------------------------------------------------
  const EMOJIS = ("😀 😂 🥰 😍 😘 😅 😊 😎 🤩 🥳 😜 🤗 🤔 🙄 😴 😭 😡 👍 👎 👏 🙌 🙏 💪 👀 "
    + "❤️ 🧡 💛 💚 💙 💜 🖤 💖 💕 💞 💓 💗 💘 💝 💋 🌹 🔥 ✨ 🎉 🍿 🎬 🥂 🍕 🌙 ⭐ ☕ 🐻 🐱 🐶 🦦").trim().split(/\s+/);
  function buildEmoji() {
    const p = $("emoji-panel");
    EMOJIS.forEach((e) => {
      const b = document.createElement("button");
      b.textContent = e;
      b.addEventListener("click", () => {
        $("msg-input").value += e;
        $("msg-input").focus();
      });
      p.appendChild(b);
    });
  }

  // ---- GIFs (Tenor) -------------------------------------------------------
  let gifTimer = null;
  async function searchGifs(q) {
    if (!settings.tenorKey) {
      $("gif-needkey").classList.remove("hidden");
      $("gif-results").innerHTML = "";
      return;
    }
    $("gif-needkey").classList.add("hidden");
    const base = "https://tenor.googleapis.com/v2/";
    const url = q
      ? `${base}search?q=${encodeURIComponent(q)}&key=${settings.tenorKey}&limit=20&media_filter=tinygif&client_key=watchtogether`
      : `${base}featured?key=${settings.tenorKey}&limit=20&media_filter=tinygif&client_key=watchtogether`;
    try {
      const res = await fetch(url);
      const data = await res.json();
      const grid = $("gif-results");
      grid.innerHTML = "";
      (data.results || []).forEach((g) => {
        const media = g.media_formats?.tinygif || g.media_formats?.gif;
        if (!media) return;
        const img = document.createElement("img");
        img.src = media.url;
        img.addEventListener("click", () => {
          const full = g.media_formats?.gif?.url || media.url;
          addMsg({ mine: true, gif: full });
          netSend({ t: "gif", url: full });
          $("gif-panel").classList.add("hidden");
        });
        grid.appendChild(img);
      });
    } catch (e) {
      $("gif-results").innerHTML = '<div class="muted small">Couldn\'t reach Tenor. Check your API key.</div>';
    }
  }

  // ---- Stats / streak / history ------------------------------------------
  function todayStr() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function dayDiff(a, b) {
    return Math.round((new Date(b) - new Date(a)) / 86400000);
  }
  async function recordSession() {
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
  function refreshStats() {
    chrome.storage.local.get(["wt_stats"], (r) => {
      const st = r.wt_stats || { count: 0, streak: 0, history: [] };
      $("streak").textContent = `🔥 ${st.streak || 0} day streak`;
      $("watch-count").textContent = `🎬 ${st.count || 0} together`;
    });
  }
  function renderHistory() {
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

  // ---- Layout / float / drag ---------------------------------------------
  function togglePopout() {
    floatMode = !floatMode;
    document.body.classList.toggle("float", floatMode);
    parentPost({ kind: "set-layout", mode: floatMode ? "float" : "dock" });
  }
  function setupDrag() {
    const h = $("drag-handle");
    let down = false;
    h.addEventListener("pointerdown", (e) => { down = true; h.setPointerCapture(e.pointerId); parentPost({ kind: "drag-start" }); });
    h.addEventListener("pointermove", (e) => { if (down) parentPost({ kind: "drag-move", dx: e.movementX, dy: e.movementY }); });
    h.addEventListener("pointerup", (e) => { down = false; h.releasePointerCapture(e.pointerId); parentPost({ kind: "drag-end" }); });
  }

  function showError(msg) {
    const el = $("connect-error");
    el.textContent = msg;
    el.classList.toggle("hidden", !msg);
  }

  // ---- Messages from the page (content script) ---------------------------
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || d.__wt !== true || e.source !== window.parent) return;
    switch (d.kind) {
      case "video-event":
        netSend({ t: "video", action: d.action, time: d.time, rate: d.rate });
        break;
      case "video-found":
        $("video-warn").classList.add("found");
        $("video-warn").title = "Video detected — controls are synced";
        break;
      case "state-reply":
        if (stateWaiters[d.reqId]) { stateWaiters[d.reqId](d.state); delete stateWaiters[d.reqId]; }
        break;
    }
  });

  // ---- Wire up the DOM ----------------------------------------------------
  function init() {
    loadSettings();
    buildEmoji();
    setupDrag();

    // Connection mode segmented control
    document.querySelectorAll(".seg-btn").forEach((b) =>
      b.addEventListener("click", () => {
        document.querySelectorAll(".seg-btn").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        const manual = b.dataset.mode === "manual";
        $("manual-ui").classList.toggle("hidden", !manual);
        $("broker-ui").classList.toggle("hidden", manual);
      })
    );

    $("btn-create").addEventListener("click", createRoom);
    $("btn-join").addEventListener("click", joinRoom);
    $("join-code").addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoom(); });
    $("btn-copy-code").addEventListener("click", () => navigator.clipboard.writeText($("room-code").textContent));

    // Manual mode
    $("btn-manual-host").addEventListener("click", () => { $("manual-host-ui").classList.remove("hidden"); $("manual-guest-ui").classList.add("hidden"); manualHost(); });
    $("btn-manual-guest").addEventListener("click", () => { $("manual-guest-ui").classList.remove("hidden"); $("manual-host-ui").classList.add("hidden"); });
    $("btn-host-finish").addEventListener("click", manualHostFinish);
    $("btn-guest-gen").addEventListener("click", manualGuestGen);
    $("btn-copy-offer").addEventListener("click", () => navigator.clipboard.writeText($("host-offer").value));
    $("btn-copy-answer").addEventListener("click", () => navigator.clipboard.writeText($("guest-answer").value));

    // Media
    $("btn-mic").addEventListener("click", toggleMic);
    $("btn-cam").addEventListener("click", toggleCam);
    $("btn-leave").addEventListener("click", () => location.reload());

    // Couple bar
    document.querySelectorAll(".cute-btn[data-react]").forEach((b) =>
      b.addEventListener("click", () => sendReaction(b.dataset.react))
    );
    $("btn-countdown").addEventListener("click", () => runCountdown(true));
    $("btn-poke").addEventListener("click", () => { netSend({ t: "poke" }); beatFast(); });

    // Composer
    $("btn-send").addEventListener("click", sendChat);
    $("msg-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });
    $("msg-input").addEventListener("input", () => {
      netSend({ t: "typing", on: $("msg-input").value.length > 0 });
    });
    $("btn-emoji").addEventListener("click", () => {
      $("emoji-panel").classList.toggle("hidden");
      $("gif-panel").classList.add("hidden");
    });

    // GIFs
    $("btn-gif").addEventListener("click", () => {
      const panel = $("gif-panel");
      panel.classList.toggle("hidden");
      $("emoji-panel").classList.add("hidden");
      if (!panel.classList.contains("hidden")) searchGifs("");
    });
    $("gif-close").addEventListener("click", () => $("gif-panel").classList.add("hidden"));
    $("gif-q").addEventListener("input", () => {
      clearTimeout(gifTimer);
      gifTimer = setTimeout(() => searchGifs($("gif-q").value.trim()), 350);
    });

    // Header buttons
    $("btn-popout").addEventListener("click", togglePopout);
    $("btn-close").addEventListener("click", () => parentPost({ kind: "close-panel" }));
    $("btn-settings").addEventListener("click", () => showPanel("settings"));
    $("btn-save-settings").addEventListener("click", saveSettings);
    $("btn-clear-history").addEventListener("click", () => {
      chrome.storage.local.set({ wt_stats: { count: 0, streak: 0, lastDate: null, history: [] } }, () => { refreshStats(); renderHistory(); });
    });
    $("tenor-link").addEventListener("click", () => window.open("https://developers.google.com/tenor/guides/quickstart", "_blank"));

    // History
    $("btn-history").addEventListener("click", () => { renderHistory(); showPanel("history"); });
    $("btn-history-back").addEventListener("click", () => showPanel(connectedOnce ? "live" : "connect"));

    showPanel("connect");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
