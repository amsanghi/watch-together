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
                   anniversary: "", bdayMe: "", bdayPartner: "" };
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
      $("me-name").textContent = settings.me;
      $("set-me").value = settings.me;
      $("set-giphy").value = settings.giphyKey;
      $("set-autocam").checked = settings.autocam;
      $("set-anniversary").value = settings.anniversary || "";
      $("set-bday-me").value = settings.bdayMe || "";
      $("set-bday-partner").value = settings.bdayPartner || "";
      $("local-label").textContent = settings.me;
      $("remote-label").textContent = settings.partner;
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
    settings.anniversary = $("set-anniversary").value || "";
    settings.bdayMe = $("set-bday-me").value || "";
    settings.bdayPartner = $("set-bday-partner").value || "";
    chrome.storage.local.set({ wt_settings: settings });
    $("me-name").textContent = settings.me;
    $("local-label").textContent = settings.me;
    $("remote-label").textContent = settings.partner;
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
      const s = await navigator.mediaDevices.getUserMedia(kind === "video" ? { video: true } : { audio: true });
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
        $("card-out").textContent = (d.kind === "wyr" ? "🤔 Would you rather: " : "🎴 ") + d.text;
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
      $("partner-clock").textContent = `🕒 ${settings.partner}'s time: ${hh}:${mm}`;
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
    "stay in with movies or go out dancing?",
    "have a beach day or a mountain cabin?",
    "breakfast in bed or midnight snacks?",
    "travel the world or build a cozy home?",
    "read minds or teleport?",
    "always be too hot or too cold?",
    "relive our first date or fast-forward to our 50th anniversary?",
  ];
  const TOD = [
    "Truth: what did you first think when you met me?",
    "Dare: send me your most ridiculous selfie right now.",
    "Truth: what's a secret talent you have?",
    "Dare: do your best impression of me.",
    "Truth: what's your favorite thing we've watched together?",
    "Dare: blow a kiss and mean it. 😘",
    "Truth: what's something you want more of in our relationship?",
  ];
  function drawCard(kind) {
    const deck = kind === "wyr" ? WYR : TOD;
    const text = deck[Math.floor(Math.random() * deck.length)];
    $("card-out").classList.remove("hidden");
    $("card-out").textContent = (kind === "wyr" ? "🤔 Would you rather: " : "🎴 ") + text;
    netSend({ t: "card", kind, text });
  }

  // --- Tic-tac-toe ---
  let tttBoard, tttTurn;
  function tttBuild() {
    const b = $("ttt-board"); b.innerHTML = "";
    for (let i = 0; i < 9; i++) {
      const c = document.createElement("div"); c.className = "cell"; c.dataset.i = i;
      c.addEventListener("click", () => tttClick(i));
      b.appendChild(c);
    }
  }
  function tttReset(broadcast) {
    tttBoard = Array(9).fill("");
    tttTurn = "X";
    document.querySelectorAll("#ttt-board .cell").forEach((c) => { c.textContent = ""; c.className = "cell"; });
    $("ttt-status").textContent = "X starts — tap any square";
    if (broadcast) netSend({ t: "ttt", reset: true });
  }
  function tttClick(i) {
    if (!tttBoard || tttBoard[i] || tttWinner()) return;
    // your mark = whichever side moves; simplest: you always place the current turn's mark
    const mark = tttTurn;
    tttApply(i, mark);
    netSend({ t: "ttt", cell: i, mark });
  }
  function tttApply(i, mark) {
    if (!tttBoard) tttReset(false);
    if (tttBoard[i]) return;
    tttBoard[i] = mark;
    const cell = document.querySelector(`#ttt-board .cell[data-i="${i}"]`);
    if (cell) { cell.textContent = mark === "X" ? "✕" : "◯"; cell.classList.add(mark.toLowerCase()); }
    tttTurn = mark === "X" ? "O" : "X";
    const w = tttWinner();
    $("ttt-status").textContent = w ? (w === "draw" ? "It's a draw 🤝" : `${w} wins! 🎉`) : `${tttTurn}'s turn`;
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

  function openFun() {
    renderQotd();
    refreshDates();
    renderWatchlist();
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
    $("btn-heartbeat").addEventListener("click", sendHeartbeat);
    $("btn-snap").addEventListener("click", sendSnap);
    $("btn-kiss-pause").addEventListener("click", sendKissPause);

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
    $("wyr-btn").addEventListener("click", () => drawCard("wyr"));
    $("tod-btn").addEventListener("click", () => drawCard("tod"));
    $("ttt-reset").addEventListener("click", () => tttReset(true));
    $("doodle-clear").addEventListener("click", () => doodleClear(true));
    tttBuild(); tttReset(false);
    doodleInit();
    chrome.storage.local.get(["wt_watchlist"], (r) => { if (Array.isArray(r.wt_watchlist)) { watchlist = r.wt_watchlist; renderWatchlist(); } });

    // Initial panel is chosen by loadSettings (name gate on first run, else connect).
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
