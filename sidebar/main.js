// WatchTogether — side-panel entry point.
// This is the composition root: it imports every module and, on load, runs
// init() which wires all the DOM event listeners, defines the Fun-panel opener,
// starts the periodic timers, registers the content-script + page-unload
// listeners, and loads the persisted couple collections. Nothing here holds
// logic — it just connects the UI to the feature modules.
//
// Loaded as `<script type="module">` from sidebar.html, AFTER the classic
// `../lib/trystero.js` script (which sets window.Trystero).

import { $ } from "./core/dom.js";
import { S } from "./core/state.js";
import { showPanel } from "./core/ui.js";
import { netSend } from "./core/net.js";
import { loadSettings, saveName, saveSettings, applyTheme } from "./core/settings.js";
import { startPairing, unpair, forceReconnect, leaveRoom, onNetworkWake } from "./core/connection.js";
import { registerTabListener, getPageState, parentPost } from "./core/tab.js";
import { toggleMic, toggleCam, setRemoteVolume, syncFunCams, initDeviceRecovery } from "./core/media.js";
import { startAudioLoop, resumeAudioCtx, onMicEvent } from "./core/audioproc.js";
import { manualHost, manualHostFinish, manualGuestGen } from "./transports/manual.js";
import { sendChat, buildEmoji, searchGifs, searchGifsDebounced } from "./features/chat.js";
import { sendReaction, sendSnap, beatFast } from "./features/reactions.js";
import { sendSfx } from "./features/soundboard.js";
import { sendInvite, acceptInvite, hideInviteBanner } from "./features/invite.js";
import {
  openPhotobooth, closePhotobooth, pbStart, pbSend, pbSave, pbDownload, pbRetake,
  pbOnControl, pbDrawInit, pbClearDraw, clearGallery, renderGallery, loadGallery,
} from "./features/photobooth.js";
import { renderHistory, refreshStats, refreshDates } from "./features/stats.js";
import { shareWeather, renderMyWeather, renderPartnerWeather } from "./features/weather.js";
import { bookmarkMoment, clearTimeline, renderTimeline, loadTimeline } from "./features/timeline.js";
import {
  setMood, setMyRating, addWatchItem, renderWatchlist, renderCounts, renderHands,
  renderScheduled, renderScrapbook, setLocalHold, bumpCount, sendLetter, openLetter,
  closeLetter, addScheduled, checkScheduled, setCuddle, setSleepTimer, addMemory,
  loadWatchlist,
} from "./features/couple.js";
import { renderQotd, sendQotd, pullJar, drawCard, newQuiz, sendQuiz } from "./features/prompts.js";
import {
  tttBuild, tttReset, doodleInit, doodleClear, rpsPick, rpsReset, c4Build, c4Reset,
  emojiNew, emojiReveal, emojiSendGuess,
} from "./features/games.js";

// Opens the Fun panel and refreshes everything it shows.
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

// ---- Wire up the DOM ----------------------------------------------------
function init() {
  loadSettings();
  buildEmoji();

  // Pairing
  $("btn-pair").addEventListener("click", startPairing);
  $("pair-code").addEventListener("keydown", (e) => { if (e.key === "Enter") startPairing(); });
  if ($("relay-url")) $("relay-url").addEventListener("keydown", (e) => { if (e.key === "Enter") startPairing(); });
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

  // Partner volume
  $("vol-slider").addEventListener("input", (e) => setRemoteVolume(Number(e.target.value)));
  let lastVol = 100;
  $("vol-icon").addEventListener("click", () => {
    if ((S.settings.volume || 0) > 0) { lastVol = S.settings.volume; setRemoteVolume(0); }
    else setRemoteVolume(lastVol || 100);
  });

  // Couple bar
  document.querySelectorAll(".cute-btn[data-react]").forEach((b) =>
    b.addEventListener("click", () => sendReaction(b.dataset.react))
  );
  $("btn-invite").addEventListener("click", sendInvite);
  $("invite-join").addEventListener("click", acceptInvite);
  $("invite-no").addEventListener("click", hideInviteBanner);
  $("btn-poke").addEventListener("click", () => { netSend({ t: "poke" }); beatFast(); });
  document.querySelectorAll("[data-sfx]").forEach((b) => b.addEventListener("click", () => sendSfx(b.dataset.sfx)));
  let annotateOn = false;
  $("btn-annotate").addEventListener("click", () => {
    annotateOn = !annotateOn;
    $("btn-annotate").classList.toggle("on", annotateOn);
    parentPost({ kind: "annotate", on: annotateOn, color: S.settings.themeColor || "#ff7ec0" });
  });
  let cinemaOn = false;
  $("btn-cinema").addEventListener("click", () => {
    cinemaOn = !cinemaOn;
    $("btn-cinema").classList.toggle("on", cinemaOn);
    netSend({ t: "cinema", on: cinemaOn }); parentPost({ kind: "cinema", on: cinemaOn });
  });
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
    b.addEventListener("click", () => pbOnControl("filter", b.dataset.filter)));
  document.querySelectorAll("#pb-stickers .pb-chip").forEach((b) =>
    b.addEventListener("click", () => pbOnControl("sticker", b.dataset.sticker)));
  document.querySelectorAll("#pb-mode button").forEach((b) =>
    b.addEventListener("click", () => pbOnControl("mode", b.dataset.mode)));
  document.querySelectorAll("#pb-layout button").forEach((b) =>
    b.addEventListener("click", () => pbOnControl("layout", b.dataset.layout)));
  document.querySelectorAll("#pb-timer button").forEach((b) =>
    b.addEventListener("click", () => pbOnControl("timer", b.dataset.timer)));
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
  $("gif-q").addEventListener("input", () => searchGifsDebounced($("gif-q").value.trim()));

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
  $("btn-history-back").addEventListener("click", () => showPanel(S.connectedOnce ? "live" : "connect"));

  // First-run name gate
  $("btn-name-continue").addEventListener("click", saveName);
  $("set-me-first").addEventListener("keydown", (e) => { if (e.key === "Enter") saveName(); });

  // ---- Fun panel ----
  $("btn-fun").addEventListener("click", openFun);
  $("btn-fun-back").addEventListener("click", () => showPanel(S.connectedOnce ? "live" : "connect"));
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

  // ---- Side effects that were module-scope in the original monolith ----
  registerTabListener();                          // content-script → panel messages
  startAudioLoop();                               // mic-gate / auto-duck / auto-level loop
  onMicEvent(() => { sendSfx("applause"); sendReaction("laugh"); }); // clap → applause + burst on both
  document.addEventListener("pointerdown", resumeAudioCtx); // unlock the AudioContext on first click
  window.addEventListener("online", onNetworkWake);         // proactive reconnect on network return
  document.addEventListener("visibilitychange", () => { if (!document.hidden) onNetworkWake(); });

  // Live call-audio tuning sliders: apply to S.settings on input (the audio loop
  // reads them every tick), show the value, and persist on release.
  document.querySelectorAll(".audio-tune").forEach((el) => {
    const out = document.getElementById(el.id + "-val");
    el.addEventListener("input", () => {
      S.settings[el.dataset.key] = Number(el.value);
      if (out) out.textContent = el.value;
    });
    el.addEventListener("change", () => chrome.storage.local.set({ wt_settings: S.settings }));
  });
  window.addEventListener("pagehide", leaveRoom); // leave the room cleanly on close
  window.addEventListener("beforeunload", leaveRoom);
  setInterval(refreshDates, 60000);               // keep the partner clock fresh
  setInterval(checkScheduled, 20000);             // deliver due surprise notes
  initDeviceRecovery();                           // re-acquire mic/cam if a device is unplugged mid-call
  let lastPosAt = 0;                              // broadcast position so the follower can correct drift
  setInterval(async () => {
    if (!S.connectedOnce || !S.amInitiator) return;
    if (Date.now() - lastPosAt < (S.settings.syncInterval || 5) * 1000) return;
    const s = await getPageState();
    if (s && typeof s.time === "number" && !s.paused) { lastPosAt = Date.now(); netSend({ t: "pos", time: s.time, paused: s.paused }); }
  }, 1500);

  // Initial storage load for the persisted couple collections.
  chrome.storage.local.get(["wt_watchlist", "wt_counts", "wt_scrapbook", "wt_scheduled", "wt_hands", "wt_weather", "wt_timeline", "wt_gallery"], (r) => {
    if (Array.isArray(r.wt_watchlist)) loadWatchlist(r.wt_watchlist);
    if (r.wt_counts) S.counts = { kiss: r.wt_counts.kiss || 0, hug: r.wt_counts.hug || 0 };
    if (Array.isArray(r.wt_scrapbook)) S.scrapbook = r.wt_scrapbook;
    if (Array.isArray(r.wt_scheduled)) S.scheduled = r.wt_scheduled;
    if (typeof r.wt_hands === "number") S.handSeconds = r.wt_hands;
    if (r.wt_weather) { S.myWeather = r.wt_weather; $("weather-btn").textContent = "Update my weather 🔄"; }
    if (Array.isArray(r.wt_timeline)) loadTimeline(r.wt_timeline);
    if (Array.isArray(r.wt_gallery)) loadGallery(r.wt_gallery);
    renderCounts(); renderHands(); renderScheduled(); renderScrapbook(); renderMyWeather(); renderTimeline(); renderGallery();
  });

  // Initial panel is chosen by loadSettings (name gate on first run, else connect).
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
