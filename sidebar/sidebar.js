/* WatchTogether — side panel app logic.
   Runs as Chrome's side panel (one per window, persists across tabs and
   navigation). Talks to the active tab's content script over chrome messaging,
   and to the partner via Trystero (serverless rendezvous over public relays,
   no broker to run) or a raw RTCPeerConnection (manual copy-paste). Both paths
   feed one message handler. */

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // Send a message to the active tab's content script (video control / effects).
  function parentPost(msg) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const id = tabs && tabs[0] && tabs[0].id;
      if (id != null) chrome.tabs.sendMessage(id, { __wt: true, ...msg }, () => void chrome.runtime.lastError);
    });
  }

  // Built-in Giphy key so GIFs work out of the box with no setup.
  // (Public repo: this key is intentionally shipped. Regenerate at
  // developers.giphy.com if it ever gets abused.)
  const DEFAULT_GIPHY_KEY = "4AV58X7gVu01rrXsHmbiuxsJ9kIBeZIw";

  // ---- State --------------------------------------------------------------
  let settings = { me: "You", partner: "Partner", giphyKey: DEFAULT_GIPHY_KEY, autocam: true, named: false };
  let sendData = null;      // sends app data over the active transport
  let streamAdded = false;  // whether we've shared our mic/cam stream yet
  let rawPC = null;         // RTCPeerConnection (manual copy-paste mode)
  let rawDC = null;         // RTCDataChannel (manual mode)
  let localStream = null;
  let mediaTried = false;
  let mediaDenied = false;
  let micOn = false, camOn = false;
  let connectedOnce = false;
  let amInitiator = false;
  let sessionRecorded = false;
  const remoteState = { mic: false, cam: false };

  // ---- Settings -----------------------------------------------------------
  function loadSettings() {
    chrome.storage.local.get(["wt_settings"], (r) => {
      if (r.wt_settings) settings = { ...settings, ...r.wt_settings };
      if (!settings.giphyKey) settings.giphyKey = DEFAULT_GIPHY_KEY; // fall back to built-in key
      $("me-name").textContent = settings.me;
      $("set-me").value = settings.me;
      $("set-giphy").value = settings.giphyKey;
      $("set-autocam").checked = settings.autocam;
      $("local-label").textContent = settings.me;
      $("remote-label").textContent = settings.partner;
      refreshStats();
      if ($("pair-code")) $("pair-code").value = settings.pairCode || "";
      // First open: ask for a name before anything else, then remember it.
      if (!settings.named) {
        $("set-me-first").value = settings.me === "You" ? "" : settings.me;
        showPanel("name");
        setTimeout(() => $("set-me-first").focus(), 50);
      } else {
        showPanel("connect");
        // Already paired → connect automatically, no codes or buttons.
        if (settings.pairCode) {
          showPairStatus();
          connect();
        }
      }
    });
  }

  function saveName() {
    const n = $("set-me-first").value.trim();
    if (!n) { $("set-me-first").focus(); return; }
    settings.me = n;
    settings.named = true;
    chrome.storage.local.set({ wt_settings: settings });
    $("me-name").textContent = n;
    $("set-me").value = n;
    $("local-label").textContent = n;
    showPanel("connect");
  }
  function saveSettings() {
    settings.me = $("set-me").value.trim() || "You";
    settings.named = true;
    settings.giphyKey = $("set-giphy").value.trim();
    settings.autocam = $("set-autocam").checked;
    chrome.storage.local.set({ wt_settings: settings });
    $("me-name").textContent = settings.me;
    $("local-label").textContent = settings.me;
    $("remote-label").textContent = settings.partner;
    showPanel(connectedOnce ? "live" : "connect");
  }

  // ---- Panels -------------------------------------------------------------
  function showPanel(name) {
    ["name", "connect", "live", "settings", "history"].forEach((p) => {
      $(p + "-panel").classList.toggle("hidden", p !== name);
    });
  }

  // ---- Networking abstraction --------------------------------------------
  function netSend(obj) {
    try {
      if (sendData) sendData(obj);
      else if (rawDC && rawDC.readyState === "open") rawDC.send(JSON.stringify(obj));
    } catch (_) {}
  }

  function setStatus(s) {
    const dot = $("status-dot");
    dot.className = "dot " + s; // off | connecting | on
    dot.title = s === "on" ? "Connected" : s === "connecting" ? "Connecting…" : "Disconnected";
    $("presence-heart").className = s === "on" ? "heart-beat" : "heart-idle";
    const label = $("header-status");
    if (label) {
      label.textContent = s === "on"
        ? (settings.partner && settings.partner !== "Partner" ? settings.partner : "Connected")
        : s === "connecting" ? "Connecting…" : "Not connected";
    }
  }

  let everConnected = false;

  function onConnected() {
    clearTimeout(connectHint);
    if (connectedOnce) return;
    connectedOnce = true;
    setStatus("on");
    showPanel("live");
    addSys(everConnected ? "Reconnected 💞" : `Connected 💞 Say hi to ${settings.partner}!`);
    everConnected = true;
    netSend({ t: "name", name: settings.me });
    netSend({ t: "media-state", mic: micOn, cam: camOn });
    if (amInitiator) netSend({ t: "sync-req" });
    recordSession();
  }
  function onDisconnected() {
    // Partner left (closed panel / browser). We stay in the room, so Trystero
    // reconnects automatically when they come back.
    connectedOnce = false;
    setStatus("connecting");
  }

  // Raw RTCDataChannel wiring (manual copy-paste mode — no broker at all).
  function wireDC(dc) {
    rawDC = dc;
    dc.onopen = onConnected;
    dc.onmessage = (e) => { try { handleData(JSON.parse(e.data)); } catch (_) {} };
    dc.onclose = onDisconnected;
  }

  // ---- Serverless rendezvous via Trystero (no broker to run) --------------
  // Both partners join the same room (derived from the shared secret) over
  // public relays; Trystero connects them directly P2P and reconnects on its
  // own. No server, no host/guest claiming, no ghost ids.
  function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }
  function roomId() { return "wt" + hashStr((settings.pairCode || "").trim().toLowerCase()); }

  // We race multiple transports (torrent + MQTT) so we connect via whichever
  // network finds the peer first. Both partners join both rooms, so we can send
  // on any transport we're connected on and the partner receives it once (no
  // duplicates, since we send on a single transport at a time).
  let entries = [];      // [{ name, room, action, connected }]
  let primary = null;    // the entry we currently send on
  let connectHint = null;

  function leaveRoom() {
    entries.forEach((e) => { try { e.room.leave(); } catch (_) {} });
    entries = []; primary = null; sendData = null; streamAdded = false;
  }

  function repointSend() {
    const live = entries.find((e) => e.connected);
    primary = live || null;
    sendData = live ? (obj) => live.action.send(obj) : null;
  }

  function connect() {
    if (!settings.pairCode) return;
    if (typeof Trystero === "undefined") { showError("Networking failed to load — use Advanced (manual) below."); return; }
    leaveRoom();
    connectedOnce = false;
    setStatus("connecting");
    const rid = roomId();
    const cfg = { appId: "watchtogether", relayConfig: { redundancy: 6 } };
    const strategies = [
      { name: "mqtt", join: Trystero.mqtt && Trystero.mqtt.joinRoom },     // usually fastest
      { name: "torrent", join: Trystero.torrent && Trystero.torrent.joinRoom }, // reliable fallback
    ];
    console.log("[WT] joining room", rid, "selfId", Trystero.selfId);

    strategies.forEach((s) => {
      if (typeof s.join !== "function") return;
      let r;
      try { r = s.join(cfg, rid); } catch (e) { console.log("[WT]", s.name, "join error", e); return; }
      const action = r.makeAction("m");
      const entry = { name: s.name, room: r, action, connected: false };
      action.onMessage = (data) => handleData(data);
      r.onPeerJoin = (pid) => {
        console.log("[WT] peer joined via", s.name, pid);
        entry.connected = true;
        amInitiator = String(Trystero.selfId) > String(pid);
        if (!primary) repointSend();
        if (localStream && !streamAdded && primary) { try { primary.room.addStream(localStream); streamAdded = true; } catch (_) {} }
        onConnected();
      };
      r.onPeerLeave = (pid) => {
        console.log("[WT] peer left via", s.name, pid);
        entry.connected = false;
        if (entries.some((e) => e.connected)) {
          if (primary === entry) repointSend(); // failover to the other transport
        } else {
          primary = null; sendData = null;
          onDisconnected();
        }
      };
      r.onPeerStream = (stream) => remoteStreamHandler(stream);
      entries.push(entry);
    });

    if (!entries.length) { showError("Networking failed to start."); return; }

    clearTimeout(connectHint);
    connectHint = setTimeout(() => {
      if (!connectedOnce) addSys("Still connecting… make sure your partner has the panel open and typed the exact same secret word.");
    }, 15000);
  }

  // Leave the room cleanly when the panel closes.
  window.addEventListener("pagehide", leaveRoom);
  window.addEventListener("beforeunload", leaveRoom);

  function showPairStatus() {
    $("pair-setup").classList.add("hidden");
    $("pair-status").classList.remove("hidden");
    $("partner-name2").textContent = settings.partner && settings.partner !== "Partner" ? settings.partner : "your partner";
  }
  function startPairing() {
    const code = $("pair-code").value.trim();
    if (!code) { $("pair-code").focus(); return; }
    showError("");
    settings.pairCode = code;
    chrome.storage.local.set({ wt_settings: settings });
    showPairStatus();
    connect();
  }
  // Manual escape hatch: rejoin the room now.
  function forceReconnect() {
    if (!settings.pairCode) { addSys("Not paired yet."); return; }
    addSys("Reconnecting…");
    connect();
  }
  function unpair() {
    settings.pairCode = "";
    chrome.storage.local.set({ wt_settings: settings });
    leaveRoom();
    connectedOnce = false;
    everConnected = false;
    setStatus("off");
    $("pair-status").classList.add("hidden");
    $("pair-setup").classList.remove("hidden");
    showPanel("connect");
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
    ensureStreamShared();
    netSend({ t: "media-state", mic: micOn, cam: camOn });
  }
  async function toggleCam() {
    await ensureMedia();
    if (!localStream) return;
    camOn = !camOn;
    localStream.getVideoTracks().forEach((t) => (t.enabled = camOn));
    $("local-video").parentElement.classList.toggle("live", camOn);
    updateMediaButtons();
    ensureStreamShared();
    netSend({ t: "media-state", mic: micOn, cam: camOn });
  }
  function updateMediaButtons() {
    $("btn-mic").className = "media-btn " + (micOn ? "on" : "off");
    $("btn-cam").className = "media-btn " + (camOn ? "on" : "off");
    $("local-off").textContent = mediaDenied ? "blocked" : "cam off";
    $("local-off").style.display = camOn ? "none" : "flex";
  }
  // Add our mic/cam stream to the active transport once (Trystero renegotiates).
  function ensureStreamShared() {
    if (streamAdded || !primary || !localStream) return;
    try { primary.room.addStream(localStream); streamAdded = true; } catch (_) {}
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
        if (connectedOnce && $("header-status")) $("header-status").textContent = settings.partner;
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
        parentPost({ kind: "apply-video", action: d.action, time: d.time, rate: d.rate, paused: d.paused, url: d.url, title: d.title, fromName: settings.partner });
        break;
      case "sync-req": {
        const s = await getPageState();
        netSend({ t: "sync-state", state: s });
        break;
      }
      case "sync-state":
        if (d.state) {
          parentPost({ kind: "apply-video", action: d.state.paused ? "pause" : "play", time: d.state.time, rate: d.state.rate, paused: d.state.paused, url: d.state.url, title: d.state.title, fromName: settings.partner });
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
      case "invite":
        // Show the invite in the panel only (always available, works on any page
        // including new-tab/chrome://, and it does the redirect itself).
        pendingInvite = { url: d.url, title: d.title };
        showInviteBanner(d.title);
        break;
      case "invite-ack":
        addSys(`${settings.partner} is joining 💞`);
        break;
    }
  }

  // ---- Invite (you → partner) and accepting (partner → you) ---------------
  let pendingInvite = null;
  let pendingFollow = false;

  // Invite the partner to the video in the active tab.
  async function sendInvite() {
    if (!connectedOnce) { addSys("Not connected yet — pair first."); return; }
    const s = await getPageState();
    if (!s || !s.url || /^chrome|^about:|^edge|^devtools/.test(s.url)) { addSys("Open a video page first, then invite."); return; }
    netSend({ t: "invite", url: s.url, title: s.title });
    addSys(`Invite sent to ${settings.partner} 💌`);
  }

  function showInviteBanner(title) {
    const t = title ? `"${title.length > 70 ? title.slice(0, 67) + "…" : title}"` : "a video";
    $("invite-text").textContent = `💗 ${settings.partner} wants to watch ${t} together`;
    $("invite-banner").classList.remove("hidden");
  }
  function hideInviteBanner() { $("invite-banner").classList.add("hidden"); }

  // Accept: navigate the active tab ourselves (works even on new-tab/chrome://),
  // then re-sync to the partner once the page's content script says hello.
  function acceptInvite() {
    const url = pendingInvite && pendingInvite.url;
    hideInviteBanner();
    if (!url) return;
    pendingFollow = true;
    netSend({ t: "invite-ack" });
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const id = tabs && tabs[0] && tabs[0].id;
      if (id != null) chrome.tabs.update(id, { url });
      else chrome.tabs.create({ url });
    });
  }

  // ---- Page state request (ask the active tab's content script) ----------
  function getPageState() {
    return new Promise((res) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const id = tabs && tabs[0] && tabs[0].id;
        if (id == null) return res(null);
        let done = false;
        chrome.tabs.sendMessage(id, { __wt: true, kind: "request-state" }, (resp) => {
          void chrome.runtime.lastError;
          if (!done) { done = true; res(resp || null); }
        });
        setTimeout(() => { if (!done) { done = true; res(null); } }, 1500);
      });
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

  // ---- GIFs (Giphy) -------------------------------------------------------
  let gifTimer = null;
  async function searchGifs(q) {
    if (!settings.giphyKey) {
      $("gif-needkey").classList.remove("hidden");
      $("gif-results").innerHTML = "";
      return;
    }
    $("gif-needkey").classList.add("hidden");
    const base = "https://api.giphy.com/v1/gifs/";
    const url = q
      ? `${base}search?api_key=${settings.giphyKey}&q=${encodeURIComponent(q)}&limit=24&rating=pg-13&bundle=messaging_non_clips`
      : `${base}trending?api_key=${settings.giphyKey}&limit=24&rating=pg-13&bundle=messaging_non_clips`;
    try {
      const res = await fetch(url);
      const data = await res.json();
      if (data.meta && data.meta.status >= 400) throw new Error(data.meta.msg || "Giphy error");
      const grid = $("gif-results");
      grid.innerHTML = "";
      (data.data || []).forEach((g) => {
        const imgs = g.images || {};
        const thumb = imgs.fixed_width_small?.url || imgs.preview_gif?.url || imgs.fixed_height_small?.url;
        if (!thumb) return;
        const full = imgs.downsized_medium?.url || imgs.fixed_height?.url || imgs.original?.url || thumb;
        const img = document.createElement("img");
        img.src = thumb;
        img.addEventListener("click", () => {
          addMsg({ mine: true, gif: full });
          netSend({ t: "gif", url: full });
          $("gif-panel").classList.add("hidden");
        });
        grid.appendChild(img);
      });
      if (!grid.children.length) grid.innerHTML = '<div class="muted small">No GIFs found.</div>';
    } catch (e) {
      $("gif-results").innerHTML = '<div class="muted small">Couldn\'t reach Giphy. Check your API key.</div>';
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


  function showError(msg) {
    const el = $("connect-error");
    el.textContent = msg;
    el.classList.toggle("hidden", !msg);
  }

  // ---- Messages from content scripts (any tab in this window) ------------
  chrome.runtime.onMessage.addListener((d, sender) => {
    if (!d || d.__wt !== true) return;
    switch (d.kind) {
      case "video-event":
        netSend({ t: "video", action: d.action, time: d.time, rate: d.rate, paused: d.paused, url: d.url, title: d.title });
        break;
      case "video-found":
        $("video-warn").classList.add("found");
        $("video-warn").title = "Video detected — controls are synced";
        break;
      case "hello":
        // A tab (re)loaded — if it followed a Join (page banner or panel accept),
        // re-sync it to the partner.
        if ((d.following || pendingFollow) && connectedOnce) { netSend({ t: "sync-req" }); pendingFollow = false; }
        break;
      case "invite-accepted":
        if (connectedOnce) netSend({ t: "invite-ack" });
        break;
    }
  });

  // ---- Wire up the DOM ----------------------------------------------------
  function init() {
    loadSettings();
    buildEmoji();

    // Pairing
    $("btn-pair").addEventListener("click", startPairing);
    $("pair-code").addEventListener("keydown", (e) => { if (e.key === "Enter") startPairing(); });
    $("btn-unpair").addEventListener("click", unpair);

    // Manual mode (advanced fallback)
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
    $("btn-invite").addEventListener("click", sendInvite);
    $("invite-join").addEventListener("click", acceptInvite);
    $("invite-no").addEventListener("click", hideInviteBanner);
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
    $("btn-close").addEventListener("click", () => { try { window.close(); } catch (_) {} });
    $("btn-settings").addEventListener("click", () => showPanel("settings"));
    $("btn-reconnect").addEventListener("click", forceReconnect);
    $("btn-save-settings").addEventListener("click", saveSettings);
    $("btn-clear-history").addEventListener("click", () => {
      chrome.storage.local.set({ wt_stats: { count: 0, streak: 0, lastDate: null, history: [] } }, () => { refreshStats(); renderHistory(); });
    });
    $("giphy-link").addEventListener("click", () => window.open("https://developers.giphy.com/", "_blank"));

    // History
    $("btn-history").addEventListener("click", () => { renderHistory(); showPanel("history"); });
    $("btn-history-back").addEventListener("click", () => showPanel(connectedOnce ? "live" : "connect"));

    // First-run name gate
    $("btn-name-continue").addEventListener("click", saveName);
    $("set-me-first").addEventListener("keydown", (e) => { if (e.key === "Enter") saveName(); });

    // Initial panel is chosen by loadSettings (name gate on first run, else connect).
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
