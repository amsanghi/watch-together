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
  let settings = { me: "You", partner: "Partner", giphyKey: DEFAULT_GIPHY_KEY, autocam: true, named: false,
                   anniversary: "", bdayMe: "", bdayPartner: "", petName: "", themeColor: "" };
  let partnerReal = "Partner";   // partner's actual name; settings.partner = petName || partnerReal
  let counts = { kiss: 0, hug: 0 };
  let scrapbook = [];            // [{text, date}]
  let scheduled = [];            // [{text, when, id}] surprise notes still pending
  let handSeconds = 0;           // lifetime hand-holding seconds
  let sendData = null;      // sends app data over the active transport
  let rawPC = null;         // RTCPeerConnection (manual copy-paste mode)
  let rawDC = null;         // RTCDataChannel (manual mode)
  let localStream = null;
  let mediaDenied = false;
  let micOn = false, camOn = false;
  let connectedOnce = false;
  let amInitiator = false;
  let sessionRecorded = false;
  const remoteState = { mic: false, cam: false };

  // ---- Settings -----------------------------------------------------------
  function loadSettings() {
    chrome.storage.local.get(["wt_settings", "wt_media"], (r) => {
      if (r.wt_settings) settings = { ...settings, ...r.wt_settings };
      if (r.wt_media) { wantMic = !!r.wt_media.mic; wantCam = !!r.wt_media.cam; }
      if (!settings.giphyKey) settings.giphyKey = DEFAULT_GIPHY_KEY; // fall back to built-in key
      if (settings.petName) settings.partner = settings.petName;
      $("me-name").textContent = settings.me;
      $("set-me").value = settings.me;
      $("set-giphy").value = settings.giphyKey;
      $("set-autocam").checked = settings.autocam;
      $("set-petname").value = settings.petName || "";
      $("set-theme").value = settings.themeColor || "#ff7ec0";
      $("set-anniversary").value = settings.anniversary || "";
      $("set-bday-me").value = settings.bdayMe || "";
      $("set-bday-partner").value = settings.bdayPartner || "";
      $("local-label").textContent = settings.me;
      $("remote-label").textContent = settings.partner;
      if (settings.themeColor) applyTheme(settings.themeColor);
      refreshStats();
      refreshDates();
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
        // Restore mic/cam to their last state (if permission's already granted).
        if (wantMic || wantCam) resumeMedia();
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
    settings.petName = $("set-petname").value.trim();
    const newColor = $("set-theme").value;
    const colorChanged = newColor !== settings.themeColor;
    settings.themeColor = newColor;
    settings.anniversary = $("set-anniversary").value || "";
    settings.bdayMe = $("set-bday-me").value || "";
    settings.bdayPartner = $("set-bday-partner").value || "";
    settings.partner = settings.petName || partnerReal || "Partner";
    chrome.storage.local.set({ wt_settings: settings });
    applyTheme(settings.themeColor);
    if (colorChanged) netSend({ t: "theme", color: settings.themeColor });
    $("me-name").textContent = settings.me;
    $("local-label").textContent = settings.me;
    $("remote-label").textContent = settings.partner;
    if (connectedOnce && $("header-status")) $("header-status").textContent = settings.partner;
    refreshDates();
    showPanel(connectedOnce ? "live" : "connect");
  }

  // ---- Panels -------------------------------------------------------------
  function showPanel(name) {
    ["name", "connect", "live", "settings", "history", "fun"].forEach((p) => {
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
    clearTimeout(reconnectTimer);
    if (connectedOnce) return;
    connectedOnce = true;
    setStatus("on");
    showPanel("live");
    addSys(everConnected ? "Reconnected 💞" : `Connected 💞 Say hi to ${settings.partner}!`);
    everConnected = true;
    netSend({ t: "name", name: settings.me });
    netSend({ t: "media-state", mic: micOn, cam: camOn });
    netSend({ t: "profile", tz: -new Date().getTimezoneOffset() }); // minutes east of UTC
    if (settings.themeColor) netSend({ t: "theme", color: settings.themeColor });
    if (myWeather) netSend({ t: "weather", ...myWeather });
    if (watchlist.length) netSend({ t: "watchlist", items: watchlist });
    if (amInitiator) netSend({ t: "sync-req" });
    recordSession();
  }
  function onDisconnected() {
    // Partner left (closed panel / browser). We stay in the room, so Trystero
    // reconnects automatically when they come back.
    connectedOnce = false;
    setStatus("connecting");
    scheduleReconnect();
  }

  // If we don't actually connect within a while, rebuild the rooms and try
  // again. Covers the "closed the panel and reopened" case where the first
  // handshake can stall on a stale peer.
  let reconnectTimer = null;
  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (!connectedOnce && settings.pairCode) connect();
    }, 9000 + Math.floor(Math.random() * 3000));
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
    entries = []; primary = null; sendData = null; sharedTracks.clear();
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
        reshareTo(r, pid); // (re)send our mic/cam to this (possibly rejoined) peer
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
      r.onPeerTrack = (track, stream) => remoteStreamHandler(stream); // addTrack fires this, not onPeerStream
      entries.push(entry);
    });

    if (!entries.length) { showError("Networking failed to start."); return; }

    clearTimeout(connectHint);
    connectHint = setTimeout(() => {
      if (!connectedOnce) addSys("Still connecting… make sure your partner has the panel open and typed the exact same secret word.");
    }, 15000);
    scheduleReconnect(); // retry the whole rendezvous if it stalls (e.g. after reopen)
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
    await ensureKind("audio"); await ensureKind("video");
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
    await ensureKind("audio"); await ensureKind("video");
    if (localStream) localStream.getTracks().forEach((t) => rawPC.addTrack(t, localStream));
    const ans = await rawPC.createAnswer();
    await rawPC.setLocalDescription(ans);
    await iceComplete(rawPC);
    $("guest-answer").value = enc(rawPC.localDescription);
  }

  // ---- Media (mic / cam) --------------------------------------------------
  const sharedTracks = new Set();
  function hasKind(kind) {
    if (!localStream) return false;
    return (kind === "video" ? localStream.getVideoTracks() : localStream.getAudioTracks()).length > 0;
  }
  // Push any local tracks we have to all currently-connected peers (used when we
  // first enable mic/cam). Deduped so we don't double-add to the same peers.
  function shareAll() {
    if (!primary || !localStream) return;
    localStream.getTracks().forEach((t) => {
      if (sharedTracks.has(t)) return;
      try { primary.room.addTrack(t, localStream); sharedTracks.add(t); } catch (_) {}
    });
  }
  // (Re)send our tracks to ONE specific peer that just (re)joined — bypasses the
  // dedup since a rejoined peer is a brand-new connection that has nothing yet.
  function reshareTo(room, pid) {
    if (!localStream) return;
    localStream.getTracks().forEach((t) => {
      try { room.addTrack(t, localStream, { target: pid }); } catch (_) {}
    });
  }
  // Acquire ONE kind (camera or mic) on demand. Asks only for what was clicked,
  // is retryable if the prompt was dismissed, and survives one device missing.
  async function ensureKind(kind) {
    if (hasKind(kind)) return true;
    try {
      const s = await navigator.mediaDevices.getUserMedia(kind === "video"
        ? { video: { width: { ideal: 1280 }, height: { ideal: 720 } } }
        : { audio: true });
      if (!localStream) { localStream = new MediaStream(); $("local-video").srcObject = localStream; }
      s.getTracks().forEach((t) => { t.enabled = false; localStream.addTrack(t); });
      mediaDenied = false;
      shareAll();
      return true;
    } catch (e) {
      mediaDenied = true;
      updateMediaButtons();
      const dev = kind === "video" ? "camera" : "microphone";
      const name = (e && e.name) || "error";
      console.log("[WT] getUserMedia(" + kind + ") failed:", name, e && e.message);
      let why;
      if (name === "NotAllowedError" || name === "SecurityError")
        why = `access is blocked. Open chrome://settings/content/${kind === "video" ? "camera" : "microphone"}, remove/allow this extension, then reopen the panel`;
      else if (name === "NotReadableError" || name === "AbortError")
        why = `the ${dev} is in use by another app or tab — close it and tap again`;
      else if (name === "NotFoundError" || name === "OverconstrainedError")
        why = `no ${dev} was found on this computer`;
      else why = `couldn't access it (${name})`;
      addSys(`Couldn't turn on the ${dev} — ${why}.`);
      return false;
    }
  }

  function saveMedia() { chrome.storage.local.set({ wt_media: { mic: micOn, cam: camOn } }); }

  async function toggleMic() {
    if (!micOn) { if (!(await ensureKind("audio"))) return; }
    micOn = !micOn;
    localStream.getAudioTracks().forEach((t) => (t.enabled = micOn));
    updateMediaButtons();
    saveMedia();
    netSend({ t: "media-state", mic: micOn, cam: camOn });
  }
  async function toggleCam() {
    if (!camOn) { if (!(await ensureKind("video"))) return; }
    camOn = !camOn;
    localStream.getVideoTracks().forEach((t) => (t.enabled = camOn));
    $("local-video").parentElement.classList.toggle("live", camOn);
    updateMediaButtons();
    saveMedia();
    netSend({ t: "media-state", mic: micOn, cam: camOn });
  }

  // Auto-resume mic/cam to their last state — but only if the browser permission
  // is already granted (so we never trigger a prompt without a click).
  let wantMic = false, wantCam = false;
  async function resumeMedia() {
    const permGranted = async (name) => {
      try { return (await navigator.permissions.query({ name })).state === "granted"; }
      catch (_) { return false; }
    };
    if (wantCam && !camOn && (await permGranted("camera"))) {
      if (await ensureKind("video")) {
        camOn = true;
        localStream.getVideoTracks().forEach((t) => (t.enabled = true));
        $("local-video").parentElement.classList.add("live");
      }
    }
    if (wantMic && !micOn && (await permGranted("microphone"))) {
      if (await ensureKind("audio")) {
        micOn = true;
        localStream.getAudioTracks().forEach((t) => (t.enabled = true));
      }
    }
    updateMediaButtons();
    if (camOn || micOn) netSend({ t: "media-state", mic: micOn, cam: camOn });
  }
  function updateMediaButtons() {
    $("btn-mic").className = "media-btn " + (micOn ? "on" : "off");
    $("btn-cam").className = "media-btn " + (camOn ? "on" : "off");
    $("local-off").textContent = mediaDenied ? "allow access" : "cam off";
    $("local-off").style.display = camOn ? "none" : "flex";
    syncFunCams();
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
    syncFunCams();
  }

  // Mirror the live camera tiles into the Fun panel's strip so you can still
  // see each other while playing games / reading letters. Multiple <video>
  // elements can share the same MediaStream, so we just copy srcObject across.
  function syncFunCams() {
    const fl = $("fun-local-video"), fr = $("fun-remote-video");
    if (!fl || !fr) return;
    const lv = $("local-video"), rv = $("remote-video");
    if (fl.srcObject !== lv.srcObject) fl.srcObject = lv.srcObject;
    if (fr.srcObject !== rv.srcObject) fr.srcObject = rv.srcObject;
    $("fun-cam").classList.toggle("hidden", !connectedOnce);
    fl.parentElement.classList.toggle("live", camOn);
    $("fun-local-off").textContent = mediaDenied ? "allow access" : "cam off";
    $("fun-local-off").style.display = camOn ? "none" : "flex";
    const rHas = !!rv.srcObject;
    fr.parentElement.classList.toggle("live", rHas && remoteState.cam);
    $("fun-remote-off").textContent = !rHas ? "waiting…" : remoteState.cam ? "" : "cam off";
    $("fun-remote-off").style.display = rHas && remoteState.cam ? "none" : "flex";
    $("fun-local-label").textContent = settings.me;
    $("fun-remote-label").textContent = settings.partner;
  }

  // ---- Incoming data handler ---------------------------------------------
  async function handleData(d) {
    if (!d || !d.t) return;
    switch (d.t) {
      case "name":
        partnerReal = d.name || partnerReal;
        settings.partner = settings.petName || partnerReal;
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
        burst(d.reaction);
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
      case "profile":
        if (typeof d.tz === "number") { partnerTz = d.tz; refreshDates(); }
        break;
      case "mood":
        $("partner-mood").textContent = d.mood ? `${settings.partner}: ${d.mood}` : "";
        break;
      case "heartbeat":
        beatFast(); burst("heart");
        try { navigator.vibrate && navigator.vibrate([60, 40, 60]); } catch (_) {}
        addSys(`💓 ${settings.partner}'s heartbeat`);
        break;
      case "greet":
        parentPost({ kind: "toast", text: d.kind === "gm" ? `☀️ Good morning from ${settings.partner}!` : `🌙 Good night from ${settings.partner}!` });
        addSys(d.kind === "gm" ? `☀️ ${settings.partner} says good morning` : `🌙 ${settings.partner} says good night`);
        break;
      case "snap":
        addMsg({ mine: false, who: settings.partner, gif: d.img });
        addToGallery("img", d.img);
        break;
      case "clip":
        addMsg({ mine: false, who: settings.partner, clip: d.clip });
        addToGallery("clip", d.clip);
        break;
      case "pb-open":
        if ($("pb-overlay").classList.contains("hidden")) { addSys(`📸 ${settings.partner} opened the photobooth`); openPhotobooth(true); }
        break;
      case "pb-set":
        applyPbSettings(d);
        break;
      case "pb-photo":
        if (Array.isArray(d.shots)) {
          if (pbSession && !pbSession.done) { pbSession.partnerShots = d.shots; pbMaybeStitch(); }
          else pbIncomingShots = d.shots; // arrived before our own capture finished
        }
        break;
      case "pb-go":
        (async () => {
          if ($("pb-overlay").classList.contains("hidden")) await openPhotobooth(true);
          applyPbSettings(d);
          pbRun();
        })();
        break;
      case "kiss-pause":
        parentPost({ kind: "apply-video", action: "pause" });
        burst("kiss");
        addSys(`💋 ${settings.partner} paused for a kiss`);
        break;
      case "qotd":
        renderQotdAnswer(settings.partner, d.text);
        break;
      case "card":
        $("card-out").classList.remove("hidden");
        $("card-out").textContent = cardLabel(d.kind) + d.text;
        addSys(`${settings.partner} drew a card — check ✨`);
        break;
      case "watchlist":
        if (Array.isArray(d.items)) { watchlist = d.items; renderWatchlist(); }
        break;
      case "rate":
        partnerRating = d.value; maybeRevealRatings();
        break;
      case "ttt":
        if (d.reset) { tttReset(false); }
        else if (typeof d.cell === "number") tttApply(d.cell, d.mark);
        break;
      case "doodle":
        if (d.clear) doodleClear(false);
        else doodleRemote(d);
        break;
      case "theme":
        if (d.color) { settings.themeColor = d.color; applyTheme(d.color); chrome.storage.local.set({ wt_settings: settings }); if ($("set-theme")) $("set-theme").value = d.color; }
        break;
      case "hand":
        setRemoteHold(!!d.on);
        break;
      case "letter":
        showLetter(partnerReal && settings.partner, d.text);
        break;
      case "count":
        bumpCount(d.kind, true);
        break;
      case "quiz-q":
        setQuizQuestion(d.q, false);
        break;
      case "quiz-a":
        renderQuizAnswer(settings.partner, d.text);
        break;
      case "cuddle":
        setCuddle(!!d.on, false);
        break;
      case "memory":
        if (d.item) { scrapbook.unshift(d.item); scrapbook = scrapbook.slice(0, 100); chrome.storage.local.set({ wt_scrapbook: scrapbook }); renderScrapbook(); }
        break;
      case "weather":
        partnerWeather = { temp: d.temp, code: d.code, isDay: d.isDay };
        renderPartnerWeather();
        break;
      case "rps":
        if (d.reset) rpsReset(false);
        else { rpsPartner = d.pick; rpsEval(); }
        break;
      case "c4":
        if (d.reset) c4Reset(false);
        else if (typeof d.col === "number") c4Apply(d.col, d.color);
        break;
      case "emoji-q":
        if (typeof d.i === "number") setEmojiPuzzle(d.deck || "movie", d.i, false);
        break;
      case "emoji-a":
        renderEmojiGuess(settings.partner, d.text);
        break;
      case "emoji-r":
        emojiReveal(false);
        break;
      case "mark":
        addTimelineItem({ time: d.time, emoji: d.emoji, who: d.who || settings.partner, title: d.title || "", url: d.url || "" });
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
  function addMsg({ mine, who, text, gif, clip }) {
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
    if (clip) {
      const v = document.createElement("video");
      v.src = clip; v.loop = true; v.autoplay = true; v.muted = true; v.playsInline = true;
      v.style.maxWidth = "100%"; v.style.borderRadius = "14px"; v.style.display = "block";
      el.appendChild(v);
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
  const FX_EMOJI = { heart: "❤️", kiss: "😘", fire: "🔥", laugh: "😂", wow: "😮", sad: "🥲" };
  // Burst emojis BOTH on the page (over the video) and inside the panel, so it's
  // always visible even on pages where content scripts can't run (new-tab etc.).
  function burst(kind) {
    parentPost({ kind: "reaction", reaction: kind });
    spawnPanelHearts(kind);
  }
  function spawnPanelHearts(kind, count = 12) {
    const cont = $("fx-overlay");
    if (!cont) return;
    const emoji = FX_EMOJI[kind] || "❤️";
    for (let i = 0; i < count; i++) {
      const el = document.createElement("div");
      el.className = "fx-heart";
      el.textContent = emoji;
      el.style.left = 6 + Math.random() * 84 + "%";
      el.style.fontSize = 20 + Math.random() * 22 + "px";
      el.style.setProperty("--dx", (Math.random() * 80 - 40) + "px");
      el.style.setProperty("--r", (Math.random() * 50 - 25) + "deg");
      el.style.setProperty("--d", 2.2 + Math.random() * 1.5 + "s");
      el.style.animationDelay = Math.random() * 0.4 + "s";
      cont.appendChild(el);
      setTimeout(() => el.remove(), 4200);
    }
  }
  function sendReaction(kind) {
    netSend({ t: "reaction", reaction: kind });
    burst(kind);
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


  // ======================================================================
  // ---- Cute extras (the ✨ Fun panel + quick gestures) -----------------
  // ======================================================================
  let partnerTz = null;       // partner's UTC offset in minutes
  let watchlist = [];         // [{text, done}]
  let myRating = null, partnerRating = null;

  // --- Dates: days together, next event, partner's clock ---
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
  function refreshDates() {
    const now = new Date();
    if (settings.anniversary) {
      const n = daysBetween(settings.anniversary, now);
      $("days-together").textContent = n >= 0 ? `💕 ${n.toLocaleString()} days together` : "💕 counting down…";
    } else {
      $("days-together").textContent = "💕 set your dates in ⚙ settings";
    }
    // next event among anniversary + birthdays
    const events = [];
    if (settings.anniversary) events.push(["💞 Anniversary", nextOccurrence(settings.anniversary)]);
    if (settings.bdayMe) events.push(["🎂 Your birthday", nextOccurrence(settings.bdayMe)]);
    if (settings.bdayPartner) events.push([`🎂 ${settings.partner}'s birthday`, nextOccurrence(settings.bdayPartner)]);
    events.sort((a, b) => a[1] - b[1]);
    if (events.length) {
      const [label, when] = events[0];
      const days = Math.round((when - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
      $("next-event").textContent = days === 0 ? `${label} is TODAY! 🎉` : `${label} in ${days} day${days === 1 ? "" : "s"}`;
      if (days === 0) celebrate();
    } else { $("next-event").textContent = ""; }
    // partner clock
    if (partnerTz != null) {
      const utc = now.getTime() + now.getTimezoneOffset() * 60000;
      const theirs = new Date(utc + partnerTz * 60000);
      const hh = String(theirs.getHours()).padStart(2, "0"), mm = String(theirs.getMinutes()).padStart(2, "0");
      const sky = theirs.getHours() >= 6 && theirs.getHours() < 19 ? "☀️" : "🌙";
      $("partner-clock").textContent = `${sky} ${settings.partner}'s time: ${hh}:${mm}`;
    } else { $("partner-clock").textContent = ""; }
  }
  let celebratedToday = false;
  function celebrate() {
    if (celebratedToday) return;
    celebratedToday = true;
    burst("heart");
    parentPost({ kind: "toast", text: "🎉 Happy day, lovebirds! 💕" });
  }
  setInterval(refreshDates, 60000); // keep the clock fresh

  // --- Mood ---
  function setMood(mood) {
    document.querySelectorAll(".mood-opt").forEach((b) => b.classList.toggle("sel", b.dataset.mood === mood));
    netSend({ t: "mood", mood });
  }

  // --- Greetings / heartbeat / kiss / snap ---
  function sendGreet(kind) { netSend({ t: "greet", kind }); addSys(kind === "gm" ? "☀️ Sent good morning" : "🌙 Sent good night"); }
  function sendHeartbeat() { netSend({ t: "heartbeat" }); beatFast(); }
  function sendKissPause() {
    netSend({ t: "kiss-pause" });
    parentPost({ kind: "apply-video", action: "pause" });
    burst("kiss");
  }
  function sendSnap() {
    const v = $("local-video");
    if (!v || !v.srcObject) { addSys("Turn your camera on first 📷"); return; }
    try {
      const c = document.createElement("canvas");
      c.width = 320; c.height = Math.round(320 * (v.videoHeight || 240) / (v.videoWidth || 320));
      const ctx = c.getContext("2d");
      ctx.translate(c.width, 0); ctx.scale(-1, 1); // un-mirror
      ctx.drawImage(v, 0, 0, c.width, c.height);
      const img = c.toDataURL("image/jpeg", 0.6);
      addMsg({ mine: true, gif: img });
      netSend({ t: "snap", img });
    } catch (_) { addSys("Couldn't take a snap."); }
  }

  // --- Question of the day (deterministic by date, same for both) ---
  const QOTD = [
    "What's a tiny thing I do that you love?",
    "Where would you teleport us right now?",
    "What's your favorite memory of us?",
    "What song reminds you of me?",
    "What's something new you want us to try together?",
    "What made you smile today?",
    "If we had a free day tomorrow, how would we spend it?",
    "What's a dream you haven't told me yet?",
    "What's your comfort food and would you share it with me?",
    "What's the most attractive thing about me (besides looks)?",
    "What would our perfect lazy Sunday look like?",
    "What's a little adventure you want to go on with me?",
  ];
  function todaysQuestion() {
    const epochDay = Math.floor((Date.now() + new Date().getTimezoneOffset() * -60000) / 86400000);
    return QOTD[epochDay % QOTD.length];
  }
  function renderQotd() { $("qotd-q").textContent = todaysQuestion(); }
  function renderQotdAnswer(who, text) {
    const el = document.createElement("div");
    el.className = "ans";
    el.innerHTML = "<b></b> <span></span>";
    el.querySelector("b").textContent = who + ":";
    el.querySelector("span").textContent = text;
    $("qotd-answers").appendChild(el);
  }
  function sendQotd() {
    const t = $("qotd-input").value.trim();
    if (!t) return;
    renderQotdAnswer(settings.me, t);
    netSend({ t: "qotd", text: t });
    $("qotd-input").value = "";
  }

  // --- Love jar ---
  const JAR = [
    "You make ordinary days feel special. 💕",
    "I'd choose you again, every time.",
    "Your laugh is my favorite sound.",
    "Home is wherever you are. 🏡",
    "I'm so proud of you.",
    "You're my favorite hello and hardest goodbye.",
    "Thanks for being exactly you.",
    "I fall for you a little more every day.",
    "You + me = my favorite team. 🫶",
    "Even my boring moments are better with you.",
  ];
  function pullJar() {
    const note = JAR[Math.floor(Math.random() * JAR.length)];
    const el = $("jar-note");
    el.textContent = note;
    el.classList.remove("hidden");
  }

  // --- Rate & reveal ---
  function setMyRating(v) {
    myRating = v;
    document.querySelectorAll("#rate-stars span").forEach((s) => s.classList.toggle("on", Number(s.dataset.v) <= v));
    netSend({ t: "rate", value: v });
    $("rate-status").textContent = partnerRating ? "" : "Sent! Waiting for " + settings.partner + "…";
    maybeRevealRatings();
  }
  function maybeRevealRatings() {
    if (myRating != null && partnerRating != null) {
      $("rate-status").textContent = `You: ${"★".repeat(myRating)} · ${settings.partner}: ${"★".repeat(partnerRating)}`;
    }
  }

  // --- Watchlist ---
  function renderWatchlist() {
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
  function addWatchItem() {
    const t = $("wl-input").value.trim();
    if (!t) return;
    watchlist.push({ text: t, done: false });
    $("wl-input").value = "";
    saveWatchlist();
  }

  // --- Would you rather / truth or dare ---
  const WYR = [
    "have me on top or be on top of me?",
    "a slow tease all night or be taken right now?",
    "feel my mouth or my hands on you first?",
    "be blindfolded or do the blindfolding?",
    "loud and rough or quiet and teasing?",
    "morning sex or middle-of-the-night sex?",
    "be tied up or tie me up?",
    "make out for an hour first or skip straight to it?",
    "shower together or soak in the bath together?",
    "have me whisper filth in your ear or stay silent and just feel it?",
    "wear something tiny for me or nothing at all?",
    "get a striptease or give me one?",
    "be in charge tonight or be told exactly what to do?",
    "have me kiss down your neck or kiss down mine?",
    "do it with the lights on or in the dark?",
    "be teased until you beg or tease me until I beg?",
    "a quickie somewhere risky or hours behind a locked door?",
    "have me bite you or scratch you?",
    "trade nudes all day or get edged over video all night?",
    "be pinned against the wall or pressed into the bed?",
    "bring a toy into it or just our hands?",
    "role-play strangers who just met or lovers reuniting after months?",
    "lace or bare skin?",
    "have me go slow and deep or fast and relentless?",
    "be woken up by my mouth or my hands?",
    "get a hickey somewhere hidden or somewhere you can't cover?",
    "once, intense and quick, or three times, slow all night?",
    "watch me touch myself or be watched while you touch yourself?",
    "have your hair pulled or your wrists held down?",
    "dirty talk over the phone or a no-words video call?",
    "be the dominant one tonight or the submissive one?",
    "a full-body massage that turns into more, or skip the wait?",
    "leave the curtains open or the door unlocked?",
    "be praised the whole time or teased and bossed around?",
    "have me describe every move before I make it or surprise you?",
  ];
  const NHIE = [
    "touched myself thinking about you.",
    "gotten turned on in public because of you.",
    "saved a photo of you for... later.",
    "had a sex dream about you.",
    "wanted to sneak off somewhere risky with you.",
    "fantasized about something with you I've never said out loud.",
    "gotten off during a call with you.",
    "pictured you while alone in the shower.",
    "wanted you so badly I couldn't focus on anything else.",
    "imagined a roleplay or threesome scenario with you.",
    "worn something just hoping you'd take it off me.",
    "lied about being busy because my thoughts about you were filthy.",
    "wanted to get caught fooling around with you.",
    "replayed a hot memory of us to get through a boring day.",
    "sent a risky text and both regretted and loved it.",
    "wanted to try something I saw and instantly thought of us.",
    "gotten jealous and then weirdly turned on by it.",
    "wanted to skip a whole event just to stay in bed with you.",
    "moaned your name when you weren't there.",
    "edged myself waiting to be with you.",
  ];
  const CONFESS = [
    "Confess the filthiest thought you've had about me this week.",
    "Admit the one thing you want me to do but are too shy to ask.",
    "Tell me the fantasy about us you replay the most.",
    "Confess every place you've imagined us doing it.",
    "Admit what you were really thinking last time you looked at me like that.",
    "Tell me the hottest dream you've ever had about us.",
    "Confess a kink you want to explore with me.",
    "Admit the last time you got off thinking about me — and exactly how.",
    "Tell me the dirtiest thing you wish you were brave enough to say out loud.",
    "Confess the part of me you can't stop thinking about.",
    "Admit one rule you'd love me to break with you.",
    "Tell me the naughtiest thing you've ever secretly wanted to try.",
    "Confess what you'd do to me right now if there were zero limits.",
    "Admit the most desperate you've ever been for me.",
    "Tell me a turn-on you've never confessed to anyone.",
    "Confess what you wear (or don't) just for me.",
    "Admit the wildest thing you've done while thinking of me.",
  ];
  const FANTASY = [
    "We're alone in a hotel room with the whole night ahead. What happens first?",
    "I surprise you in the shower. Walk me through it.",
    "You're tied to the bed and I'm in charge. What do I do to you?",
    "We can't make a single sound or we'll get caught. How does it play out?",
    "You find me waiting in your favorite thing to peel off me. Then what?",
    "We're strangers who just locked eyes across a bar. Take it from there.",
    "I'm yours to command for one hour. What's your very first order?",
    "Lights off, blindfold on — describe everything you'd do to me.",
    "One night, a long list of firsts. Pick the three you want most.",
    "You're teasing me under the table at dinner. How far do you take it?",
    "I tell you not to touch yourself until I say so. How long do you last?",
    "We reunite after weeks apart and can't keep our hands off. Describe the first ten minutes.",
    "You get to direct me like your own private show. What do you have me do?",
    "We have the whole house to ourselves for 24 hours. What's the plan?",
  ];
  const FINISH = [
    "Tonight I want you to ___.",
    "I can't stop thinking about your ___.",
    "If you were here right now, I'd ___.",
    "The first thing I'd take off you is ___.",
    "I love it most when you ___.",
    "I've always wanted to try ___ with you.",
    "You drive me wild when you ___.",
    "Right now I'm imagining ___.",
    "Next time I see you, be ready for ___.",
    "I want you to beg me for ___.",
    "My favorite place for your mouth is ___.",
    "I'd let you ___ anytime you wanted.",
    "The dirtiest thing I'd whisper to you is ___.",
    "I get weak whenever you ___.",
  ];
  // Explicit, but built for long distance — everything works over video, voice,
  // photos or text. Just the two of you. 🔞
  const TRUTH = [
    "What's the dirtiest thought you've had about me today?",
    "Where exactly do you want my hands right now?",
    "What's the wildest place you'd want to have sex with me?",
    "Describe, step by step, what you'd do to me if I were in bed with you right now.",
    "What turns you on the fastest when we're together?",
    "What's a fantasy about me you've touched yourself to?",
    "Tell me the last time you got off thinking about me — and what you imagined.",
    "What's something you've always wanted me to do to you but never asked?",
    "Which part of my body do you crave the most?",
    "Rougher or slower — how do you want me tonight?",
    "What's the naughtiest photo of me you've saved, and what do you do with it?",
    "What do you want me to whisper in your ear while we're at it?",
    "What's a kink of yours I don't know about yet?",
    "Have you ever gotten off during a call with me? Tell me everything.",
    "Which outfit of mine makes you want to tear it off?",
    "Where do you most want my mouth?",
    "What's the loudest I've ever made you — and how?",
    "What's something you want to try in bed that we never have?",
    "Tell me exactly how you like to be touched when you're alone.",
    "What's the hottest thing I've ever done to you?",
    "If I could only use my hands or my mouth tonight, which do you choose?",
    "What's your favorite position with me and why?",
    "How many times have you pictured me naked today?",
    "What's the filthiest text you wish I'd send you right now?",
    "What do you want me to do to you the second we're alone again?",
    "Tell me your most secret fantasy starring us.",
    "What's the most turned on I've ever gotten you in public?",
    "What sound do you make that you hope drives me crazy?",
    "Is there a toy you've imagined using with me?",
    "Where on your body do you most want my lips right now?",
    "What's the dirtiest thing you'd let me do to you on camera?",
    "What were you imagining the last time you bit your lip at me?",
    "Morning, night, or the middle of the day — when do you want me most?",
    "What's the one thing I do that instantly gets you going?",
    "What would you beg me for tonight if I made you?",
    "What's the most desperate you've ever been for me?",
    "Describe the last dream you had about us in detail.",
    "What's a word you want me to call you in bed?",
  ];
  const DARE = [
    "Take off one piece of clothing on camera, slowly.",
    "Send me a photo of the part of you that aches for me most.",
    "Touch yourself the way you want me to — 15 seconds, on camera.",
    "Describe, in filthy detail, what you'd do to me — out loud for 30 seconds.",
    "Send me a voice note moaning my name.",
    "Strip down to whatever's under your clothes and show me.",
    "Run your hands slowly over yourself while I watch.",
    "Text me the dirtiest thing you want to do to me — no filter.",
    "Bite your lip, look at the camera, and tell me you're mine.",
    "Show me your favorite spot to be touched — and touch it.",
    "Take a teasing photo and send it to me right now.",
    "Whisper into the mic exactly how you want tonight to go.",
    "Take something off and tell me what you'd do next.",
    "Send a photo with one button (or layer) fewer than you have now.",
    "Moan for me — loud — on camera.",
    "Pose the way you'd want me to find you in bed.",
    "Tell me, to my face, your dirtiest fantasy about us.",
    "Trace your fingers down your body while holding eye contact.",
    "Record a 10-second clip of your most irresistible move.",
    "Send me the most NSFW selfie you'd only ever send me.",
    "Show me how you'd kiss me if I were there.",
    "Say out loud what you're imagining doing to me right now.",
    "Take off your shirt and tell me you wish I were doing it.",
    "Beg me for something — and mean it.",
    "Give the camera a few seconds of a slow striptease.",
    "Tell me exactly where you want me tonight.",
    "Send a photo of you biting your lip thinking about me.",
    "Touch the spot you most want my mouth on.",
    "Say the filthiest sentence you can think of, looking right at me.",
    "Show me what you do when you can't stop thinking about me.",
    "Send me a teasing video peeling off one layer.",
    "Whisper what you'd do if I walked in right now with nothing on.",
    "Press close to the camera and tell me a secret you want me to act on.",
    "Show me, with your hands, exactly how you want to be held down.",
    "Send me one photo that'll keep me up all night.",
    "Undo one thing and leave it for me to imagine the rest.",
    "Tell me your safe word — then dare me to make you need it.",
    "Look into the camera and tell me what you'd do to me first.",
  ];
  const CARD_DECKS = { wyr: WYR, truth: TRUTH, dare: DARE, nhie: NHIE, confess: CONFESS, fantasy: FANTASY, finish: FINISH };
  const CARD_LABELS = {
    wyr: "🤔 Would you rather: ", truth: "💬 Truth: ", dare: "🔥 Dare: ",
    nhie: "🙊 Never have I ever ", confess: "😈 ", fantasy: "🎬 Picture this: ", finish: "✍️ Finish it: ",
  };
  function cardLabel(kind) { return CARD_LABELS[kind] || "🎴 "; }
  function drawCard(kind) {
    if (kind === "random") { const ks = Object.keys(CARD_DECKS); kind = ks[Math.floor(Math.random() * ks.length)]; }
    const deck = CARD_DECKS[kind] || TRUTH;
    const text = deck[Math.floor(Math.random() * deck.length)];
    $("card-out").classList.remove("hidden");
    $("card-out").textContent = cardLabel(kind) + text;
    netSend({ t: "card", kind, text });
  }

  // --- Tic-tac-toe (each side owns one mark; you can only play your own turns) ---
  let tttBoard, tttTurn, tttMyMark = "X";
  function myMark() { return amInitiator ? "X" : "O"; } // initiator is X and moves first
  function tttBuild() {
    const b = $("ttt-board"); b.innerHTML = "";
    for (let i = 0; i < 9; i++) {
      const c = document.createElement("div"); c.className = "cell"; c.dataset.i = i;
      c.addEventListener("click", () => tttClick(i));
      b.appendChild(c);
    }
  }
  function tttStatus() {
    tttMyMark = myMark();
    const w = tttWinner();
    if (w) { $("ttt-status").textContent = w === "draw" ? "It's a draw 🤝" : `${w === tttMyMark ? "You" : settings.partner} win${w === tttMyMark ? "" : "s"}! 🎉`; return; }
    $("ttt-status").textContent = tttTurn === tttMyMark ? `Your turn (${tttMyMark})` : `${settings.partner}'s turn`;
  }
  function tttReset(broadcast) {
    tttBoard = Array(9).fill("");
    tttTurn = "X";
    tttMyMark = myMark();
    document.querySelectorAll("#ttt-board .cell").forEach((c) => { c.textContent = ""; c.className = "cell"; });
    tttStatus();
    if (broadcast) netSend({ t: "ttt", reset: true });
  }
  function tttClick(i) {
    if (!tttBoard) tttReset(false);
    if (tttBoard[i] || tttWinner()) return;
    tttMyMark = myMark();
    if (tttTurn !== tttMyMark) { $("ttt-status").textContent = `Wait for ${settings.partner} ⏳`; return; }
    tttApply(i, tttMyMark);
    netSend({ t: "ttt", cell: i, mark: tttMyMark });
  }
  function tttApply(i, mark) {
    if (!tttBoard) tttReset(false);
    if (tttBoard[i]) return;
    tttBoard[i] = mark;
    const cell = document.querySelector(`#ttt-board .cell[data-i="${i}"]`);
    if (cell) { cell.textContent = mark === "X" ? "✕" : "◯"; cell.classList.add(mark.toLowerCase()); }
    tttTurn = mark === "X" ? "O" : "X";
    tttStatus();
  }
  function tttWinner() {
    const L = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
    for (const [a,b,c] of L) if (tttBoard[a] && tttBoard[a] === tttBoard[b] && tttBoard[a] === tttBoard[c]) return tttBoard[a];
    return tttBoard.every(Boolean) ? "draw" : null;
  }

  // --- Doodle together ---
  let dctx, drawing = false, lastX = 0, lastY = 0;
  function doodleInit() {
    const c = $("doodle"); if (!c) return;
    dctx = c.getContext("2d");
    const pos = (e) => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) * c.width / r.width, (e.clientY - r.top) * c.height / r.height]; };
    c.addEventListener("pointerdown", (e) => { drawing = true; [lastX, lastY] = pos(e); });
    c.addEventListener("pointermove", (e) => {
      if (!drawing) return;
      const [x, y] = pos(e);
      const color = $("doodle-color").value;
      doodleLine(lastX, lastY, x, y, color);
      netSend({ t: "doodle", x0: lastX, y0: lastY, x1: x, y1: y, color });
      [lastX, lastY] = [x, y];
    });
    window.addEventListener("pointerup", () => { drawing = false; });
  }
  function doodleLine(x0, y0, x1, y1, color) {
    if (!dctx) return;
    dctx.strokeStyle = color; dctx.lineWidth = 3; dctx.lineCap = "round";
    dctx.beginPath(); dctx.moveTo(x0, y0); dctx.lineTo(x1, y1); dctx.stroke();
  }
  function doodleRemote(d) { doodleLine(d.x0, d.y0, d.x1, d.y1, d.color); }
  function doodleClear(broadcast) {
    if (dctx) dctx.clearRect(0, 0, $("doodle").width, $("doodle").height);
    if (broadcast) netSend({ t: "doodle", clear: true });
  }

  // --- Theme color (shared accent) ---
  function shade(hex, pct) {
    hex = (hex || "#ff7ec0").replace("#", "");
    if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
    const num = parseInt(hex, 16);
    let r = (num >> 16) & 255, g = (num >> 8) & 255, b = num & 255;
    const t = pct < 0 ? 0 : 255, p = Math.abs(pct);
    r = Math.round((t - r) * p) + r; g = Math.round((t - g) * p) + g; b = Math.round((t - b) * p) + b;
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }
  function applyTheme(color) {
    if (!color) return;
    const light = shade(color, 0.32), deep = shade(color, -0.18);
    const r = document.documentElement.style;
    r.setProperty("--accent", color);
    r.setProperty("--accent-d", deep);
    r.setProperty("--accent2", light);
    r.setProperty("--grad", `linear-gradient(135deg, ${light} 0%, ${color} 100%)`);
    r.setProperty("--grad-purple", `linear-gradient(135deg, ${shade(color, 0.1)} 0%, ${color} 100%)`);
    r.setProperty("--glow", `0 0 16px ${color}80`);
  }

  // --- Hold hands ---
  let localHold = false, remoteHold = false, holdTimer = null;
  function fmtDur(s) {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
  }
  function renderHands() {
    $("hold-status").textContent = handSeconds ? `🤝 ${fmtDur(handSeconds)} held together` : "Hold together to feel each other 💞";
  }
  function setLocalHold(on) {
    if (localHold === on) return;
    localHold = on;
    $("hold-btn").classList.toggle("holding", on);
    netSend({ t: "hand", on });
    checkBothHold();
  }
  function setRemoteHold(on) { remoteHold = on; checkBothHold(); }
  function checkBothHold() {
    const both = localHold && remoteHold;
    $("hold-btn").classList.toggle("both", both);
    if (both && !holdTimer) {
      try { navigator.vibrate && navigator.vibrate([40, 30, 40]); } catch (_) {}
      spawnPanelHearts("heart", 6);
      $("hold-status").textContent = "💞 holding hands…";
      holdTimer = setInterval(() => {
        handSeconds++;
        if (handSeconds % 4 === 0) spawnPanelHearts("heart", 3);
        $("hold-status").textContent = `💞 ${fmtDur(handSeconds)} holding hands…`;
        if (handSeconds % 5 === 0) chrome.storage.local.set({ wt_hands: handSeconds });
      }, 1000);
    } else if (!both && holdTimer) {
      clearInterval(holdTimer); holdTimer = null;
      chrome.storage.local.set({ wt_hands: handSeconds });
      renderHands();
    }
  }

  // --- Kiss & hug counters ---
  function renderCounts() {
    $("kiss-count").textContent = counts.kiss || 0;
    $("hug-count").textContent = counts.hug || 0;
  }
  function bumpCount(kind, fromRemote) {
    if (kind !== "kiss" && kind !== "hug") return;
    counts[kind] = (counts[kind] || 0) + 1;
    chrome.storage.local.set({ wt_counts: counts });
    renderCounts();
    const btn = document.querySelector(`.count-btn[data-count="${kind}"]`);
    if (btn) { btn.classList.remove("pop"); void btn.offsetWidth; btn.classList.add("pop"); }
    burst(kind === "kiss" ? "kiss" : "heart");
    if (!fromRemote) netSend({ t: "count", kind });
    if (counts[kind] % 100 === 0) {
      spawnPanelHearts(kind === "kiss" ? "kiss" : "heart", 26);
      parentPost({ kind: "toast", text: `${kind === "kiss" ? "💋" : "🤗"} ${counts[kind]} ${kind === "kiss" ? "kisses" : "hugs"} together!` });
    }
  }

  // --- Love letters ---
  function sendLetter() {
    const t = $("letter-input").value.trim();
    if (!t) { $("letter-input").focus(); return; }
    netSend({ t: "letter", text: t });
    $("letter-input").value = "";
    addSys("💌 Love letter sent");
  }
  function showLetter(from, text) {
    if (!text) return;
    $("letter-from").textContent = (from || settings.partner) + " wrote:";
    $("letter-body").textContent = text;
    $("letter-paper").classList.add("hidden");
    $("letter-envelope").classList.remove("hidden");
    $("letter-hint").classList.remove("hidden");
    $("letter-overlay").classList.remove("hidden");
  }
  function openLetter() {
    $("letter-paper").classList.remove("hidden");
    $("letter-envelope").classList.add("hidden");
    $("letter-hint").classList.add("hidden");
    spawnPanelHearts("heart", 22);
    try { navigator.vibrate && navigator.vibrate(60); } catch (_) {}
  }
  function closeLetter() { $("letter-overlay").classList.add("hidden"); }

  // --- Surprise scheduled notes ---
  function renderScheduled() {
    const el = $("sched-list");
    el.innerHTML = "";
    scheduled.slice().sort((a, b) => a.when - b.when).forEach((s) => {
      const row = document.createElement("div");
      const when = new Date(s.when);
      const snip = s.text.length > 24 ? s.text.slice(0, 24) + "…" : s.text;
      row.textContent = `⏰ "${snip}" — ${when.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
      el.appendChild(row);
    });
  }
  function addScheduled() {
    const text = $("sched-text").value.trim();
    const whenStr = $("sched-when").value;
    if (!text) { $("sched-text").focus(); return; }
    if (!whenStr) { $("sched-when").focus(); return; }
    const when = new Date(whenStr).getTime();
    if (!when || when <= Date.now()) { addSys("Pick a time in the future ⏰"); return; }
    scheduled.push({ text, when });
    chrome.storage.local.set({ wt_scheduled: scheduled });
    $("sched-text").value = ""; $("sched-when").value = "";
    renderScheduled();
    addSys(`⏰ Surprise note set for ${new Date(when).toLocaleString()} — delivered when you're both online`);
  }
  function checkScheduled() {
    if (!scheduled.length) return;
    const now = Date.now();
    const due = scheduled.filter((s) => s.when <= now);
    if (!due.length) return;
    if (!(sendData || (rawDC && rawDC.readyState === "open"))) return; // keep queued until connected
    due.forEach((s) => netSend({ t: "letter", text: s.text }));
    scheduled = scheduled.filter((s) => s.when > now);
    chrome.storage.local.set({ wt_scheduled: scheduled });
    renderScheduled();
    addSys(`💌 Delivered ${due.length} surprise note${due.length > 1 ? "s" : ""}`);
  }
  setInterval(checkScheduled, 20000);

  // --- How well do you know me? quiz ---
  const QUIZ_Q = [
    "What's my favorite food?",
    "What's my dream vacation spot?",
    "What song do I have on repeat?",
    "What's my biggest fear?",
    "What's my go-to comfort movie?",
    "What's my favorite way to relax?",
    "What's my coffee/tea order?",
    "What would my perfect date be?",
    "What's my favorite thing about you?",
    "What's a hidden talent of mine?",
    "What's my favorite season?",
    "What makes me laugh the hardest?",
  ];
  function setQuizQuestion(q, broadcast) {
    $("quiz-q").textContent = q ? "💘 " + q : "";
    $("quiz-answers").innerHTML = "";
    $("quiz-input").value = "";
    if (broadcast) netSend({ t: "quiz-q", q });
  }
  function newQuiz() { setQuizQuestion(QUIZ_Q[Math.floor(Math.random() * QUIZ_Q.length)], true); }
  function renderQuizAnswer(who, text) {
    const el = document.createElement("div");
    el.className = "ans";
    el.innerHTML = "<b></b> <span></span>";
    el.querySelector("b").textContent = who + ":";
    el.querySelector("span").textContent = text;
    $("quiz-answers").appendChild(el);
  }
  function sendQuiz() {
    const t = $("quiz-input").value.trim();
    if (!t) return;
    if (!$("quiz-q").textContent) newQuiz();
    renderQuizAnswer(settings.me, t);
    netSend({ t: "quiz-a", text: t });
    $("quiz-input").value = "";
  }

  // --- Cuddle / goodnight mode ---
  let cuddleEnd = 0, cuddleTick = null;
  function setCuddle(on, broadcast) {
    $("cuddle-overlay").classList.toggle("hidden", !on);
    $("cuddle-sub").textContent = on ? `Goodnight, ${settings.partner} 🌙` : "";
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
  function setSleepTimer(min) {
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
    if (camOn) toggleCam();
    if (micOn) toggleMic();
    parentPost({ kind: "apply-video", action: "pause" });
    $("cuddle-countdown").textContent = "Sweet dreams 💤";
  }

  // --- Memory scrapbook ---
  function renderScrapbook() {
    const list = $("mem-list");
    list.innerHTML = "";
    if (!scrapbook.length) { list.innerHTML = '<div class="muted small">No memories yet — add your first 💕</div>'; return; }
    scrapbook.forEach((m) => {
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
  function addMemory() {
    const t = $("mem-input").value.trim();
    if (!t) return;
    const item = { text: t, date: todayStr() };
    scrapbook.unshift(item); scrapbook = scrapbook.slice(0, 100);
    chrome.storage.local.set({ wt_scrapbook: scrapbook });
    $("mem-input").value = "";
    renderScrapbook();
    netSend({ t: "memory", item });
  }

  // --- Same sky / weather (Open-Meteo, no API key) ---
  let myWeather = null, partnerWeather = null;
  function wmoEmoji(code) {
    if (code === 0) return "☀️";
    if (code === 1 || code === 2) return "🌤️";
    if (code === 3) return "☁️";
    if (code === 45 || code === 48) return "🌫️";
    if ([51, 53, 55, 56, 57].includes(code)) return "🌦️";
    if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "🌧️";
    if ([71, 73, 75, 77, 85, 86].includes(code)) return "❄️";
    if ([95, 96, 99].includes(code)) return "⛈️";
    return "🌡️";
  }
  function renderMyWeather() {
    if (!myWeather) { $("my-weather").textContent = ""; return; }
    $("my-weather").textContent = `${myWeather.isDay ? "☀️" : "🌙"} You: ${wmoEmoji(myWeather.code)} ${myWeather.temp}°C`;
  }
  function renderPartnerWeather() {
    if (!partnerWeather) return;
    $("partner-weather").textContent = `${partnerWeather.isDay ? "☀️" : "🌙"} ${settings.partner}: ${wmoEmoji(partnerWeather.code)} ${partnerWeather.temp}°C`;
  }
  function shareWeather() {
    if (!navigator.geolocation) { addSys("Location isn't available on this device."); return; }
    $("weather-btn").textContent = "Getting location…";
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        const { latitude, longitude } = pos.coords;
        // round to ~1km for privacy; we only ever send the summary, never coords
        const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude.toFixed(2)}&longitude=${longitude.toFixed(2)}&current=temperature_2m,weather_code,is_day`);
        const d = await r.json();
        const c = d.current || {};
        myWeather = { temp: Math.round(c.temperature_2m), code: c.weather_code, isDay: c.is_day ? 1 : 0 };
        chrome.storage.local.set({ wt_weather: myWeather });
        $("weather-btn").textContent = "Update my weather 🔄";
        renderMyWeather();
        netSend({ t: "weather", ...myWeather });
      } catch (e) { $("weather-btn").textContent = "Share my weather"; addSys("Couldn't fetch the weather right now."); }
    }, () => { $("weather-btn").textContent = "Share my weather"; addSys("Location permission denied — can't share weather."); }, { timeout: 10000 });
  }

  // --- Rock paper scissors ---
  let rpsMy = null, rpsPartner = null;
  const RPS_E = { rock: "🪨", paper: "📄", scissors: "✂️" };
  function rpsPick(p) {
    rpsMy = p;
    document.querySelectorAll(".rps-opt").forEach((b) => b.classList.toggle("sel", b.dataset.rps === p));
    netSend({ t: "rps", pick: p });
    rpsEval();
  }
  function rpsEval() {
    if (rpsMy && rpsPartner) {
      const beats = { rock: "scissors", paper: "rock", scissors: "paper" };
      const res = rpsMy === rpsPartner ? "it's a tie 🤝" : beats[rpsMy] === rpsPartner ? "you win! 🎉" : `${settings.partner} wins 😘`;
      $("rps-status").textContent = `${RPS_E[rpsMy]} vs ${RPS_E[rpsPartner]} — ${res}`;
    } else if (rpsMy) {
      $("rps-status").textContent = `Locked in ${RPS_E[rpsMy]} — waiting for ${settings.partner}…`;
    }
  }
  function rpsReset(broadcast) {
    rpsMy = null; rpsPartner = null;
    document.querySelectorAll(".rps-opt").forEach((b) => b.classList.remove("sel"));
    $("rps-status").textContent = "Pick one — revealed when you both have.";
    if (broadcast) netSend({ t: "rps", reset: true });
  }

  // --- Connect 4 (7 cols x 6 rows; each side owns a color, turn-based) ---
  let c4Board, c4Turn;
  function c4Color() { return amInitiator ? "r" : "y"; } // initiator is red and moves first
  function c4Build() {
    const b = $("c4-board"); b.innerHTML = "";
    for (let i = 0; i < 42; i++) {
      const c = document.createElement("div"); c.className = "c4-cell"; c.dataset.i = i;
      c.addEventListener("click", () => c4Click(i % 7));
      b.appendChild(c);
    }
  }
  function c4Status() {
    const mine = c4Color();
    const w = c4Winner();
    if (w) { $("c4-status").textContent = w === "draw" ? "Draw 🤝" : `${w === mine ? "You" : settings.partner} win${w === mine ? "" : "s"}! 🎉`; return; }
    $("c4-status").textContent = c4Turn === mine ? `Your turn (${mine === "r" ? "🔴" : "🟡"})` : `${settings.partner}'s turn`;
  }
  function c4Reset(broadcast) {
    c4Board = Array(42).fill(""); c4Turn = "r";
    document.querySelectorAll("#c4-board .c4-cell").forEach((c) => { c.className = "c4-cell"; });
    c4Status();
    if (broadcast) netSend({ t: "c4", reset: true });
  }
  function c4DropRow(col) { for (let row = 5; row >= 0; row--) if (!c4Board[row * 7 + col]) return row; return -1; }
  function c4Click(col) {
    if (!c4Board) c4Reset(false);
    if (c4Winner()) return;
    const mine = c4Color();
    if (c4Turn !== mine) { $("c4-status").textContent = `Wait for ${settings.partner} ⏳`; return; }
    if (c4DropRow(col) < 0) return;
    c4Apply(col, mine);
    netSend({ t: "c4", col, color: mine });
  }
  function c4Apply(col, color) {
    if (!c4Board) c4Reset(false);
    const row = c4DropRow(col); if (row < 0) return;
    const idx = row * 7 + col; c4Board[idx] = color;
    const cell = document.querySelector(`#c4-board .c4-cell[data-i="${idx}"]`);
    if (cell) cell.classList.add(color === "r" ? "red" : "yellow");
    c4Turn = color === "r" ? "y" : "r";
    c4Status();
  }
  function c4Winner() {
    if (!c4Board) return null;
    const at = (r, c) => (r < 0 || r > 5 || c < 0 || c > 6) ? "" : c4Board[r * 7 + c];
    for (let r = 0; r < 6; r++) for (let c = 0; c < 7; c++) {
      const v = at(r, c); if (!v) continue;
      for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]])
        if (at(r + dr, c + dc) === v && at(r + 2 * dr, c + 2 * dc) === v && at(r + 3 * dr, c + 3 * dc) === v) return v;
    }
    return c4Board.every(Boolean) ? "draw" : null;
  }

  // --- Guess the emoji (multiple decks, incl. explicit ones) ---
  const EMOJI_DECKS = {
    movie: [
      { e: "🦁👑", a: "The Lion King" }, { e: "🚢🧊💔", a: "Titanic" }, { e: "👻🚫", a: "Ghostbusters" },
      { e: "🧙‍♂️💍🌋", a: "The Lord of the Rings" }, { e: "🤡🎈🚸", a: "It" }, { e: "🦖🏝️", a: "Jurassic Park" },
      { e: "🔍🐠", a: "Finding Nemo" }, { e: "❄️👭👸", a: "Frozen" }, { e: "🕷️🧑", a: "Spider-Man" },
      { e: "💊🔴🔵🕶️", a: "The Matrix" }, { e: "🚗⚡🏁", a: "Cars" }, { e: "🤖❤️🌱", a: "WALL-E" },
      { e: "🎈🏠👴", a: "Up" }, { e: "🦇🃏", a: "The Dark Knight" }, { e: "👽📞🏠🌕", a: "E.T." },
      { e: "🐀👨‍🍳🍝", a: "Ratatouille" }, { e: "👧🐉🏯", a: "Spirited Away" }, { e: "🐠🔍👨‍👦", a: "Finding Nemo" },
      { e: "🧸🤠🚀", a: "Toy Story" }, { e: "🦈🌊🩸", a: "Jaws" },
    ],
    spicy: [
      { e: "👅🍆", a: "Blowjob" }, { e: "👅🌮", a: "Eating out / oral" }, { e: "👅🍑", a: "Rimming" },
      { e: "✊🍆💦", a: "Handjob" }, { e: "🍆🍑", a: "Anal" }, { e: "6️⃣9️⃣", a: "Sixty-nine" },
      { e: "🍆👄💦", a: "Deepthroat" }, { e: "💦😮", a: "Facial" }, { e: "⛓️🙇", a: "Bondage" },
      { e: "✋🍑👏", a: "Spanking" }, { e: "🔥💬", a: "Dirty talk" }, { e: "📱🍆💦", a: "Sexting" },
      { e: "🎥🛏️", a: "Sex tape" }, { e: "👀🪟", a: "Voyeurism" }, { e: "3️⃣🛏️", a: "Threesome" },
      { e: "🧊🛏️", a: "Ice play" }, { e: "🕯️🔥💧", a: "Wax play" }, { e: "👠🦶👅", a: "Foot fetish" },
      { e: "🪶😏", a: "Teasing" }, { e: "🙈⛓️", a: "Blindfold & restraints" }, { e: "💍🔓💞", a: "Open relationship" },
      { e: "🐆🛏️🔥", a: "Rough sex" }, { e: "🚿💦🛁", a: "Shower sex" }, { e: "🚗🌙🔥", a: "Car sex" },
      { e: "🎭👫", a: "Role play" }, { e: "👑🙇‍♂️", a: "Dom / sub" }, { e: "🤏🍒🤏", a: "Nipple play" },
      { e: "😈🔒🔑", a: "Chastity / control" }, { e: "🥵💦😮‍💨", a: "Orgasm" }, { e: "💋⬇️⬇️⬇️", a: "Kissing down the body" },
      { e: "🛌🌅🍆", a: "Morning sex" }, { e: "👅🔋", a: "Edging" },
    ],
    position: [
      { e: "🐶💨", a: "Doggy style" }, { e: "🤠🐎", a: "Cowgirl" }, { e: "🤠↩️", a: "Reverse cowgirl" },
      { e: "🥄👤👤", a: "Spooning" }, { e: "😇🛏️", a: "Missionary" }, { e: "6️⃣9️⃣", a: "Sixty-nine" },
      { e: "🪑🍆", a: "Lap sit" }, { e: "🧎‍♀️🧎", a: "Kneeling" }, { e: "🙆‍♀️⬆️🦵", a: "Legs up" },
      { e: "🌉", a: "The bridge" }, { e: "🧍🧍🔥", a: "Standing" }, { e: "🐍🤸", a: "The pretzel" },
      { e: "🚪🧍🍑", a: "Against the wall" }, { e: "🛋️🍑⬆️", a: "Bent over" }, { e: "🌮👇🪑", a: "Face-sitting" },
      { e: "🦋🛏️", a: "The butterfly" }, { e: "🦵✂️🦵", a: "Scissoring" },
    ],
    phrase: [
      { e: "🛏️🌙🔥", a: "Sex tonight" }, { e: "👅⬇️⬇️", a: "Go down on me" }, { e: "🍑👏👏", a: "Spank me" },
      { e: "🙏🍆", a: "Beg for it" }, { e: "💦🛏️", a: "Make a mess" }, { e: "🔒💋", a: "Locked-door quickie" },
      { e: "📞🍆💦", a: "Phone sex" }, { e: "👀📹🔥", a: "Watch me" }, { e: "⛓️🛏️😈", a: "Tie me up" },
      { e: "🍑📸", a: "Send nudes" }, { e: "🥵👅", a: "Turn me on" }, { e: "🔝🍆", a: "Get on top" },
      { e: "👅🍑👅", a: "Eat me out" }, { e: "🤲🍒", a: "Touch me" }, { e: "💋🔁🌙", a: "All night long" },
      { e: "😈🗣️👂", a: "Talk dirty to me" }, { e: "🙇‍♀️🍆💦", a: "On your knees" }, { e: "🛏️🆓❓", a: "You free tonight?" },
    ],
    sext: [
      { e: "🍆➡️🍑", a: "I want you inside me" }, { e: "😩💭🫵🔁", a: "I can't stop thinking about you" },
      { e: "🙏🛏️🌙", a: "Come to bed" }, { e: "👅👉🫵", a: "I want to taste you" },
      { e: "🥵🫵🔥", a: "You make me so hot" }, { e: "📸🍑🙏", a: "Send me a pic" },
      { e: "🤲🫵🔛🙋", a: "I need your hands on me" }, { e: "💦👀🫵", a: "Look what you do to me" },
      { e: "⏳🚫🙅", a: "I can't wait any longer" }, { e: "🛌🫵🔜", a: "Get over here" },
      { e: "👀👅🫵", a: "I want to watch you" }, { e: "🔥💬👂", a: "Talk dirty to me" },
      { e: "🙈⛓️🙏", a: "Tie me up" }, { e: "💋🔝➡️⬇️", a: "Kiss me everywhere" },
      { e: "🫵🔛🙏", a: "I want you on top" }, { e: "🌙🆓🛏️❓", a: "Are you free tonight?" },
    ],
  };
  const EMOJI_DECK_LABELS = { movie: "🎬 Movie", spicy: "🔥 Sexy act", position: "🛏️ Position", phrase: "🗯️ Dirty phrase", sext: "💌 Sext" };
  let emojiDeck = "movie", emojiIdx = -1;
  function setEmojiPuzzle(deck, i, broadcast) {
    if (!EMOJI_DECKS[deck]) deck = "movie";
    emojiDeck = deck; emojiIdx = i;
    $("emoji-puzzle").textContent = EMOJI_DECKS[deck][i].e;
    $("emoji-answer").textContent = ""; $("emoji-answer").classList.add("hidden");
    $("emoji-guesses").innerHTML = ""; $("emoji-guess").value = "";
    if (broadcast) netSend({ t: "emoji-q", deck, i });
  }
  function emojiNew(deck) {
    if (deck === "random" || !deck) { const ks = Object.keys(EMOJI_DECKS); deck = ks[Math.floor(Math.random() * ks.length)]; }
    setEmojiPuzzle(deck, Math.floor(Math.random() * EMOJI_DECKS[deck].length), true);
  }
  function renderEmojiGuess(who, text) {
    const el = document.createElement("div");
    el.className = "ans"; el.innerHTML = "<b></b> <span></span>";
    el.querySelector("b").textContent = who + ":"; el.querySelector("span").textContent = text;
    $("emoji-guesses").appendChild(el);
  }
  function emojiSendGuess() {
    if (emojiIdx < 0) emojiNew("random");
    const t = $("emoji-guess").value.trim(); if (!t) return;
    renderEmojiGuess(settings.me, t);
    netSend({ t: "emoji-a", text: t });
    $("emoji-guess").value = "";
  }
  function emojiReveal(broadcast) {
    if (emojiIdx < 0) return;
    const el = $("emoji-answer");
    el.textContent = (EMOJI_DECK_LABELS[emojiDeck] || "🎬") + ": " + EMOJI_DECKS[emojiDeck][emojiIdx].a;
    el.classList.remove("hidden");
    if (broadcast) netSend({ t: "emoji-r" });
  }

  // --- Reaction timeline (bookmark movie moments, jump back together) ---
  let timeline = [];
  function fmtClock(sec) {
    sec = Math.floor(sec || 0);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ":" : "") + String(m).padStart(h ? 2 : 1, "0") + ":" + String(s).padStart(2, "0");
  }
  async function bookmarkMoment(emoji) {
    const st = await getPageState();
    if (!st || st.time == null) { addSys("Play a video first to bookmark a moment 🎬"); return; }
    const item = { time: Math.floor(st.time), emoji, who: settings.me, title: st.title || "", url: st.url || "" };
    addTimelineItem(item);
    burst("heart");
    addSys(`🔖 Bookmarked ${emoji} at ${fmtClock(item.time)}`);
    netSend({ t: "mark", time: item.time, emoji, who: settings.me, title: item.title, url: item.url });
  }
  function addTimelineItem(item) {
    timeline.push(item);
    timeline.sort((a, b) => a.time - b.time);
    timeline = timeline.slice(0, 200);
    chrome.storage.local.set({ wt_timeline: timeline });
    renderTimeline();
  }
  function renderTimeline() {
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
    parentPost({ kind: "apply-video", action: "play", time: m.time, url: m.url, fromName: settings.me });
    netSend({ t: "video", action: "seek", time: m.time, url: m.url });
  }
  function clearTimeline() { timeline = []; chrome.storage.local.set({ wt_timeline: timeline }); renderTimeline(); }

  // --- Photobooth 📸 ---
  const PB_FILTERS = {
    none: "none",
    bw: "grayscale(1) contrast(1.08)",
    sepia: "sepia(0.85)",
    vintage: "sepia(0.4) contrast(1.2) saturate(1.5) hue-rotate(-12deg)",
    dreamy: "brightness(1.12) saturate(1.35) contrast(0.95) blur(0.4px)",
    blush: "saturate(1.5) brightness(1.06) contrast(1.04)",
    neon: "saturate(2.2) contrast(1.35) hue-rotate(18deg)",
    invert: "invert(1)",
  };
  let pbFilter = "none", pbMode = "single", pbLayout = "me", pbSticker = "💕", pbBusy = false, pbTimer = 3;
  let pbResult = null, pbClip = null, pbResultType = "img", pbDrawCtx = null;
  let pbSession = null, pbIncomingShots = null, pbStitchTimer = null;
  let gallery = [];
  const pbWait = (ms) => new Promise((r) => setTimeout(r, ms));
  const blobToDataURL = (blob) => new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });

  async function openPhotobooth(remote) {
    $("pb-overlay").classList.remove("hidden");
    $("pb-result").classList.add("hidden");
    $("pb-live").classList.remove("hidden");
    if (!remote) netSend({ t: "pb-open" });
    pbSyncStatus();
    if (!camOn) { try { await toggleCam(); } catch (_) {} }
    $("pb-local").srcObject = localStream;
    pbUpdatePreview();
  }
  function closePhotobooth() { $("pb-overlay").classList.add("hidden"); }
  function pbSyncStatus() {
    $("pb-sync").textContent = connectedOnce
      ? `💞 Synced with ${settings.partner} — you'll snap together`
      : "Solo mode — connect to snap together";
  }
  // Apply settings pushed by the partner (no rebroadcast).
  function applyPbSettings(d) {
    if (d.filter != null) { pbFilter = d.filter; pbSelect("pb-filters", "filter", pbFilter); }
    if (d.mode != null) { pbMode = d.mode; pbSelect("pb-mode", "mode", pbMode); }
    if (d.layout != null) { pbLayout = d.layout; pbSelect("pb-layout", "layout", pbLayout); }
    if (d.sticker != null) { pbSticker = d.sticker; pbSelect("pb-stickers", "sticker", pbSticker); }
    if (d.timer != null) { pbTimer = d.timer; pbSelect("pb-timer", "timer", String(pbTimer)); }
    pbUpdatePreview();
  }
  function broadcastPbSet() {
    netSend({ t: "pb-set", filter: pbFilter, mode: pbMode, layout: pbLayout, sticker: pbSticker, timer: pbTimer });
  }
  // Start a synced capture: both panels run the same timer and snap together.
  function pbStart() {
    if (pbBusy) return;
    netSend({ t: "pb-go", mode: pbMode, layout: pbLayout, filter: pbFilter, sticker: pbSticker, timer: pbTimer });
    pbRun();
  }
  function pbRun() { if (pbBusy) return; return pbMode === "boom" ? pbRunClip() : pbRunPhoto(); }
  function pbUpdatePreview() {
    const rv = $("pb-remote");
    const useUs = pbLayout === "us" && $("remote-video").srcObject;
    if (useUs) { rv.srcObject = $("remote-video").srcObject; rv.classList.remove("hidden"); }
    else rv.classList.add("hidden");
    const f = PB_FILTERS[pbFilter] || "none";
    $("pb-local").style.filter = f;
    rv.style.filter = f;
    document.querySelectorAll("#pb-stage .pb-stk").forEach((s) => { s.textContent = pbSticker; });
  }
  function pbSelect(container, attr, val) {
    document.querySelectorAll(`#${container} [data-${attr}]`).forEach((b) => b.classList.toggle("sel", b.dataset[attr] === val));
  }
  function pbCountdown(seconds) {
    return new Promise((res) => {
      let n = seconds || pbTimer || 3;
      const el = $("pb-count");
      el.textContent = n; el.classList.remove("hidden");
      const iv = setInterval(() => {
        n--;
        if (n <= 0) { clearInterval(iv); el.textContent = "📸"; setTimeout(() => { el.classList.add("hidden"); res(); }, 240); }
        else el.textContent = n;
      }, 1000);
    });
  }
  function pbFlash() { const f = $("pb-flash"); f.classList.remove("go"); void f.offsetWidth; f.classList.add("go"); }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function drawCover(ctx, video, x, y, w, h, mirror, filter) {
    ctx.save();
    roundRect(ctx, x, y, w, h, 2); ctx.clip();
    const vw = video && video.videoWidth, vh = video && video.videoHeight;
    if (!vw || !vh) { ctx.fillStyle = "#2c1f38"; ctx.fillRect(x, y, w, h); ctx.restore(); return; }
    const scale = Math.max(w / vw, h / vh);
    const dw = vw * scale, dh = vh * scale;
    const dx = x + (w - dw) / 2, dy = y + (h - dh) / 2;
    ctx.filter = filter || "none";
    if (mirror) { ctx.translate(2 * (x + w / 2), 0); ctx.scale(-1, 1); }
    ctx.drawImage(video, dx, dy, dw, dh);
    ctx.restore();
  }
  // Grab one full-res frame of the LOCAL camera (mirrored, filter baked in).
  // We capture each side locally in HD and exchange the frames, so both halves
  // of an "Us" shot are crisp instead of the low-res streamed video.
  function pbGrabLocal(filterKey) {
    const v = $("local-video");
    let w = v.videoWidth || 1280, h = v.videoHeight || 720;
    const cap = 1280;
    if (Math.max(w, h) > cap) { const sc = cap / Math.max(w, h); w = Math.round(w * sc); h = Math.round(h * sc); }
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const cx = c.getContext("2d");
    cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = "high";
    cx.filter = PB_FILTERS[filterKey] || "none";
    // Capture in true orientation (NOT mirrored). The live preview is mirrored
    // for a natural selfie feel, but the saved photo should read correctly.
    cx.drawImage(v, 0, 0, w, h);
    return c.toDataURL("image/jpeg", 0.92);
  }
  function loadImg(src) { return new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; }); }
  function drawImgCover(ctx, img, x, y, w, h) {
    if (!img || !img.naturalWidth) { ctx.fillStyle = "#2c1f38"; ctx.fillRect(x, y, w, h); return; }
    const vw = img.naturalWidth, vh = img.naturalHeight;
    const scale = Math.max(w / vw, h / vh);
    const dw = vw * scale, dh = vh * scale;
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    ctx.restore();
  }
  // Stitch HD frames into the final framed photo / strip.
  async function pbStitch(leftShots, rightShots, p) {
    const useUs = !!rightShots;
    const shots = p.shots;
    const cellH = 720, halfW = Math.round(cellH * 4 / 3); // 4:3 cells
    const cellW = useUs ? halfW * 2 : halfW;
    const pad = Math.round(cellW * 0.035), gap = Math.round(cellH * 0.05), footer = Math.round(cellH * 0.17);
    const W = cellW + pad * 2, H = pad * 2 + shots * cellH + (shots - 1) * gap + footer;
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const ctx = c.getContext("2d");
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    const bg = ctx.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, "#3a2247"); bg.addColorStop(1, "#241531");
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    for (let s = 0; s < shots; s++) {
      const y = pad + s * (cellH + gap);
      ctx.save(); roundRect(ctx, pad, y, cellW, cellH, 22); ctx.clip();
      ctx.fillStyle = "#1d1424"; ctx.fillRect(pad, y, cellW, cellH);
      drawImgCover(ctx, await loadImg(leftShots[s]), pad, y, useUs ? halfW : cellW, cellH);
      if (useUs) drawImgCover(ctx, await loadImg(rightShots[s]), pad + halfW, y, halfW, cellH);
      ctx.restore();
      if (p.sticker) {
        ctx.fillStyle = "#fff"; ctx.font = Math.round(cellH * 0.1) + "px serif";
        ctx.textBaseline = "top"; ctx.textAlign = "left"; ctx.fillText(p.sticker, pad + 16, y + 14);
        ctx.textBaseline = "bottom"; ctx.textAlign = "right"; ctx.fillText(p.sticker, pad + cellW - 16, y + cellH - 14);
        ctx.textBaseline = "alphabetic";
      }
    }
    const bw = Math.max(5, Math.round(W * 0.01));
    ctx.lineWidth = bw; ctx.strokeStyle = "#ff7ec0";
    roundRect(ctx, bw, bw, W - 2 * bw, H - 2 * bw, 30); ctx.stroke();
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffe9f4"; ctx.font = "700 " + Math.round(footer * 0.42) + "px system-ui, sans-serif";
    ctx.fillText(p.caption, W / 2, H - footer * 0.55);
    ctx.fillStyle = "#c19ccf"; ctx.font = "600 " + Math.round(footer * 0.26) + "px system-ui, sans-serif";
    ctx.fillText(new Date().toLocaleDateString(), W / 2, H - footer * 0.2);
    return c.toDataURL("image/jpeg", 0.92);
  }
  function pbFinish(dataUrl) {
    pbResult = dataUrl;
    showImageResult(dataUrl);
    addToGallery("img", dataUrl);
    $("pb-capture").disabled = false;
    $("pb-sync").textContent = "";
    pbBusy = false; pbSession = null;
    clearTimeout(pbStitchTimer);
    spawnPanelHearts(pbSticker === "🔥" ? "fire" : "heart", 14);
    pbSyncStatus();
  }
  async function pbMaybeStitch() {
    if (!pbSession || pbSession.done || !pbSession.myShots || !pbSession.partnerShots) return;
    pbSession.done = true;
    const left = amInitiator ? pbSession.myShots : pbSession.partnerShots;
    const right = amInitiator ? pbSession.partnerShots : pbSession.myShots;
    pbFinish(await pbStitch(left, right, pbSession));
  }
  async function pbRunPhoto() {
    if (pbBusy) return;
    pbBusy = true;
    $("pb-capture").disabled = true;
    const shots = pbMode === "strip" ? 3 : 1;
    const useUs = pbLayout === "us" && $("remote-video").srcObject;
    const filterKey = pbFilter;
    const caption = ($("pb-caption").value.trim()) || `${settings.me} 💕 ${settings.partner}`;
    const myShots = [];
    for (let s = 0; s < shots; s++) {
      await pbCountdown(s === 0 ? pbTimer : Math.min(3, pbTimer));
      myShots.push(pbGrabLocal(filterKey));
      pbFlash();
      await pbWait(450);
    }
    if (!useUs) {
      pbFinish(await pbStitch(myShots, null, { shots, sticker: pbSticker, caption }));
      return;
    }
    // "Us": exchange HD frames so both panels stitch the same crisp photo.
    pbSession = { shots, sticker: pbSticker, caption, myShots, partnerShots: pbIncomingShots, done: false };
    pbIncomingShots = null;
    netSend({ t: "pb-photo", shots: myShots, total: shots, sticker: pbSticker, caption });
    $("pb-sync").textContent = `✨ Stitching your HD photo with ${settings.partner}…`;
    pbMaybeStitch();
    clearTimeout(pbStitchTimer);
    pbStitchTimer = setTimeout(async () => {
      if (pbSession && !pbSession.done) { pbSession.done = true; pbFinish(await pbStitch(pbSession.myShots, null, pbSession)); }
    }, 12000);
  }

  function showImageResult(dataUrl) {
    pbResultType = "img";
    const img = $("pb-img");
    $("pb-img-wrap").classList.remove("hidden");
    $("pb-clip").classList.add("hidden");
    $("pb-draw-row").classList.remove("hidden");
    img.onload = () => {
      const dc = $("pb-draw");
      dc.width = img.naturalWidth; dc.height = img.naturalHeight;
      pbDrawCtx = dc.getContext("2d");
    };
    img.src = dataUrl;
    $("pb-live").classList.add("hidden");
    $("pb-result").classList.remove("hidden");
  }

  // Boomerang / short looping clip via MediaRecorder on a filtered canvas.
  async function pbRunClip() {
    if (!window.MediaRecorder) { addSys("Looping clips aren't supported on this browser — try a strip 🎞️"); return; }
    pbBusy = true; $("pb-capture").disabled = true;
    const lv = $("local-video"), rv = $("remote-video");
    const useUs = pbLayout === "us" && rv.srcObject;
    const filter = PB_FILTERS[pbFilter] || "none";
    const W = 320, H = 240;
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const cx = cv.getContext("2d");
    await pbCountdown(pbTimer);
    const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) || "video/webm";
    const stream = cv.captureStream(15);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 1200000 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const done = new Promise((res) => { rec.onstop = res; });
    rec.start();
    pbFlash();
    const start = performance.now(), dur = 2200; let raf;
    const draw = () => {
      cx.fillStyle = "#1d1424"; cx.fillRect(0, 0, W, H);
      if (useUs) { drawCover(cx, lv, 0, 0, W / 2, H, true, filter); drawCover(cx, rv, W / 2, 0, W / 2, H, false, filter); }
      else drawCover(cx, lv, 0, 0, W, H, true, filter);
      if (pbSticker) { cx.filter = "none"; cx.font = "22px serif"; cx.textAlign = "left"; cx.fillText(pbSticker, 6, 26); cx.textAlign = "right"; cx.fillText(pbSticker, W - 6, H - 10); }
      if (performance.now() - start < dur) raf = requestAnimationFrame(draw);
      else rec.stop();
    };
    draw();
    await done;
    if (raf) cancelAnimationFrame(raf);
    const url = await blobToDataURL(new Blob(chunks, { type: mime }));
    showClipResult(url);
    addToGallery("clip", url);
    pbBusy = false; $("pb-capture").disabled = false;
    spawnPanelHearts("heart", 14);
  }

  function showClipResult(url) {
    pbResultType = "clip"; pbClip = url;
    $("pb-clip").src = url;
    $("pb-clip").classList.remove("hidden");
    $("pb-img-wrap").classList.add("hidden");
    $("pb-draw-row").classList.add("hidden");
    $("pb-live").classList.add("hidden");
    $("pb-result").classList.remove("hidden");
  }
  function pbComposite() {
    const img = $("pb-img");
    if (!img.naturalWidth) return pbResult;
    const base = document.createElement("canvas");
    base.width = img.naturalWidth; base.height = img.naturalHeight;
    const bx = base.getContext("2d");
    bx.drawImage(img, 0, 0);
    const dc = $("pb-draw");
    if (dc.width) bx.drawImage(dc, 0, 0, base.width, base.height);
    return base.toDataURL("image/jpeg", 0.85);
  }
  function pbSend() {
    if (pbResultType === "clip") {
      if (!pbClip) return;
      addMsg({ mine: true, clip: pbClip });
      netSend({ t: "clip", clip: pbClip });
    } else {
      const out = pbComposite();
      addMsg({ mine: true, gif: out });
      netSend({ t: "snap", img: out });
    }
    addSys("📸 Sent a photobooth pic");
    closePhotobooth();
  }
  function pbSave() {
    if (pbResultType === "clip") { addSys("📸 It's in your gallery below 👇"); return; }
    addPhotoToScrapbook(pbComposite());
    addSys("📖 Saved to your scrapbook");
  }
  function pbDownload() {
    const a = document.createElement("a");
    if (pbResultType === "clip") { if (!pbClip) return; a.href = pbClip; a.download = "watchtogether-clip.webm"; }
    else { a.href = pbComposite(); a.download = "watchtogether-photobooth.jpg"; }
    a.click();
  }
  function pbRetake() {
    pbClearDraw();
    $("pb-result").classList.add("hidden");
    $("pb-live").classList.remove("hidden");
  }
  function addPhotoToScrapbook(img) {
    scrapbook.unshift({ img, date: todayStr() });
    scrapbook = scrapbook.slice(0, 100);
    chrome.storage.local.set({ wt_scrapbook: scrapbook });
    renderScrapbook();
  }

  // Doodle on the captured photo
  function pbDrawInit() {
    const c = $("pb-draw"); if (!c) return;
    let drawing = false, lx = 0, ly = 0;
    const pos = (e) => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) * c.width / r.width, (e.clientY - r.top) * c.height / r.height]; };
    c.addEventListener("pointerdown", (e) => { if (!pbDrawCtx) return; drawing = true; [lx, ly] = pos(e); e.preventDefault(); });
    c.addEventListener("pointermove", (e) => {
      if (!drawing || !pbDrawCtx) return;
      const [x, y] = pos(e);
      pbDrawCtx.strokeStyle = $("pb-draw-color").value;
      pbDrawCtx.lineWidth = Math.max(3, c.width / 90); pbDrawCtx.lineCap = "round"; pbDrawCtx.lineJoin = "round";
      pbDrawCtx.beginPath(); pbDrawCtx.moveTo(lx, ly); pbDrawCtx.lineTo(x, y); pbDrawCtx.stroke();
      [lx, ly] = [x, y];
    });
    window.addEventListener("pointerup", () => { drawing = false; });
  }
  function pbClearDraw() { if (pbDrawCtx) pbDrawCtx.clearRect(0, 0, $("pb-draw").width, $("pb-draw").height); }

  // --- Shared photobooth gallery ---
  function addToGallery(type, data) {
    if (!data) return;
    gallery.unshift({ type, data, date: todayStr() });
    gallery = gallery.slice(0, 60);
    chrome.storage.local.set({ wt_gallery: gallery });
    renderGallery();
  }
  function renderGallery() {
    const grid = $("gallery-grid"); if (!grid) return;
    grid.innerHTML = "";
    if (!gallery.length) { grid.innerHTML = '<div class="muted small gallery-empty">No photos yet — open the photobooth 🎞️</div>'; return; }
    gallery.forEach((g) => {
      let el;
      if (g.type === "clip") { el = document.createElement("video"); el.src = g.data; el.muted = true; el.loop = true; el.autoplay = true; el.playsInline = true; }
      else { el = document.createElement("img"); el.src = g.data; el.alt = "photo"; }
      el.title = "Tap to send again";
      el.addEventListener("click", () => resendGalleryItem(g));
      grid.appendChild(el);
    });
  }
  function resendGalleryItem(g) {
    if (g.type === "clip") { addMsg({ mine: true, clip: g.data }); netSend({ t: "clip", clip: g.data }); }
    else { addMsg({ mine: true, gif: g.data }); netSend({ t: "snap", img: g.data }); }
    addSys("📸 Sent from your gallery");
    burst("heart");
  }
  function clearGallery() { gallery = []; chrome.storage.local.set({ wt_gallery: gallery }); renderGallery(); }

  function openFun() {
    renderQotd();
    refreshDates();
    renderWatchlist();
    renderCounts();
    renderHands();
    renderScheduled();
    renderScrapbook();
    renderMyWeather();
    renderPartnerWeather();
    renderTimeline();
    renderGallery();
    syncFunCams();
    showPanel("fun");
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
    $("btn-poke").addEventListener("click", () => { netSend({ t: "poke" }); beatFast(); });
    $("btn-snap").addEventListener("click", sendSnap);
    $("btn-photobooth").addEventListener("click", openPhotobooth);

    // Photobooth
    $("pb-close").addEventListener("click", closePhotobooth);
    $("pb-capture").addEventListener("click", pbStart);
    $("pb-send").addEventListener("click", pbSend);
    $("pb-save").addEventListener("click", pbSave);
    $("pb-download").addEventListener("click", pbDownload);
    $("pb-retake").addEventListener("click", pbRetake);
    document.querySelectorAll("#pb-filters .pb-chip").forEach((b) =>
      b.addEventListener("click", () => { pbFilter = b.dataset.filter; pbSelect("pb-filters", "filter", pbFilter); pbUpdatePreview(); broadcastPbSet(); }));
    document.querySelectorAll("#pb-stickers .pb-chip").forEach((b) =>
      b.addEventListener("click", () => { pbSticker = b.dataset.sticker; pbSelect("pb-stickers", "sticker", pbSticker); pbUpdatePreview(); broadcastPbSet(); }));
    document.querySelectorAll("#pb-mode button").forEach((b) =>
      b.addEventListener("click", () => { pbMode = b.dataset.mode; pbSelect("pb-mode", "mode", pbMode); broadcastPbSet(); }));
    document.querySelectorAll("#pb-layout button").forEach((b) =>
      b.addEventListener("click", () => { pbLayout = b.dataset.layout; pbSelect("pb-layout", "layout", pbLayout); pbUpdatePreview(); broadcastPbSet(); }));
    document.querySelectorAll("#pb-timer button").forEach((b) =>
      b.addEventListener("click", () => { pbTimer = Number(b.dataset.timer); pbSelect("pb-timer", "timer", String(pbTimer)); broadcastPbSet(); }));
    pbDrawInit();
    $("pb-draw-clear").addEventListener("click", pbClearDraw);
    $("gallery-clear").addEventListener("click", clearGallery);

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
    $("set-theme").addEventListener("input", () => applyTheme($("set-theme").value));
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

    // ---- Fun panel ----
    $("btn-fun").addEventListener("click", openFun);
    $("btn-fun-back").addEventListener("click", () => showPanel(connectedOnce ? "live" : "connect"));
    document.querySelectorAll(".mood-opt").forEach((b) => b.addEventListener("click", () => setMood(b.dataset.mood)));
    $("mood-text").addEventListener("keydown", (e) => { if (e.key === "Enter") { setMood($("mood-text").value.trim()); } });
    $("qotd-send").addEventListener("click", sendQotd);
    $("qotd-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendQotd(); });
    $("jar-btn").addEventListener("click", pullJar);
    document.querySelectorAll("#rate-stars span").forEach((s) => s.addEventListener("click", () => setMyRating(Number(s.dataset.v))));
    $("wl-add").addEventListener("click", addWatchItem);
    $("wl-input").addEventListener("keydown", (e) => { if (e.key === "Enter") addWatchItem(); });
    document.querySelectorAll(".card-btn[data-card]").forEach((b) => b.addEventListener("click", () => drawCard(b.dataset.card)));
    $("ttt-reset").addEventListener("click", () => tttReset(true));
    $("doodle-clear").addEventListener("click", () => doodleClear(true));
    tttBuild(); tttReset(false);
    doodleInit();

    // Same sky / weather
    $("weather-btn").addEventListener("click", shareWeather);
    // Rock paper scissors
    document.querySelectorAll(".rps-opt").forEach((b) => b.addEventListener("click", () => rpsPick(b.dataset.rps)));
    $("rps-reset").addEventListener("click", () => rpsReset(true));
    // Connect 4
    c4Build(); c4Reset(false);
    $("c4-reset").addEventListener("click", () => c4Reset(true));
    // Guess the emoji (multi-deck)
    document.querySelectorAll(".emoji-deck-btn").forEach((b) => b.addEventListener("click", () => emojiNew(b.dataset.deck)));
    $("emoji-reveal").addEventListener("click", () => emojiReveal(true));
    $("emoji-send").addEventListener("click", emojiSendGuess);
    $("emoji-guess").addEventListener("keydown", (e) => { if (e.key === "Enter") emojiSendGuess(); });
    // Reaction timeline
    document.querySelectorAll(".mark-btn").forEach((b) => b.addEventListener("click", () => bookmarkMoment(b.dataset.mark)));
    $("btn-bookmark").addEventListener("click", () => bookmarkMoment("❤️"));
    $("timeline-clear").addEventListener("click", clearTimeline);

    // ---- New couple features ----
    // Hold hands (press & hold)
    const hb = $("hold-btn");
    const holdOn = (e) => { e.preventDefault(); setLocalHold(true); };
    const holdOff = () => setLocalHold(false);
    hb.addEventListener("pointerdown", holdOn);
    hb.addEventListener("pointerup", holdOff);
    hb.addEventListener("pointerleave", holdOff);
    hb.addEventListener("pointercancel", holdOff);
    // Kiss & hug counters
    document.querySelectorAll(".count-btn[data-count]").forEach((b) =>
      b.addEventListener("click", () => bumpCount(b.dataset.count, false))
    );
    // Love letter
    $("letter-send").addEventListener("click", sendLetter);
    $("letter-envelope").addEventListener("click", openLetter);
    $("letter-close").addEventListener("click", closeLetter);
    // Surprise scheduled note
    $("sched-add").addEventListener("click", addScheduled);
    // Quiz
    $("quiz-new").addEventListener("click", newQuiz);
    $("quiz-send").addEventListener("click", sendQuiz);
    $("quiz-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendQuiz(); });
    // Cuddle / goodnight mode
    $("btn-cuddle").addEventListener("click", () => setCuddle(true, true));
    $("cuddle-exit").addEventListener("click", () => setCuddle(false, true));
    document.querySelectorAll(".cuddle-tmr").forEach((b) =>
      b.addEventListener("click", () => setSleepTimer(Number(b.dataset.min)))
    );
    // Memory scrapbook
    $("mem-add").addEventListener("click", addMemory);
    $("mem-input").addEventListener("keydown", (e) => { if (e.key === "Enter") addMemory(); });

    chrome.storage.local.get(["wt_watchlist", "wt_counts", "wt_scrapbook", "wt_scheduled", "wt_hands", "wt_weather", "wt_timeline", "wt_gallery"], (r) => {
      if (Array.isArray(r.wt_watchlist)) { watchlist = r.wt_watchlist; renderWatchlist(); }
      if (r.wt_counts) counts = { kiss: r.wt_counts.kiss || 0, hug: r.wt_counts.hug || 0 };
      if (Array.isArray(r.wt_scrapbook)) scrapbook = r.wt_scrapbook;
      if (Array.isArray(r.wt_scheduled)) scheduled = r.wt_scheduled;
      if (typeof r.wt_hands === "number") handSeconds = r.wt_hands;
      if (r.wt_weather) { myWeather = r.wt_weather; $("weather-btn").textContent = "Update my weather 🔄"; }
      if (Array.isArray(r.wt_timeline)) timeline = r.wt_timeline;
      if (Array.isArray(r.wt_gallery)) gallery = r.wt_gallery;
      renderCounts(); renderHands(); renderScheduled(); renderScrapbook(); renderMyWeather(); renderTimeline(); renderGallery();
    });

    // Initial panel is chosen by loadSettings (name gate on first run, else connect).
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
