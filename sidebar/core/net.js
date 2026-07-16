// WatchTogether — networking core: the transport-agnostic send, and the single
// dispatcher for everything that arrives from the partner.
//
// `netSend(obj)` writes to whichever transport is active (a Trystero action, the
// relay socket, or the manual RTCDataChannel) — set by the transports into
// S.sendData / S.rawDC.
//
// `handleData(d)` is the ONE place the wire protocol is decoded: `d.t` selects
// a handler, which lives in the feature module that owns it. Keeping it as a
// single switch makes it the readable protocol reference and preserves the exact
// ordering the app relied on (lastRx first; ping/pong/please-reload before the
// switch). To add a message type, add a `case` here that calls into a module.
//
// Exports: netSend, handleData.

import { S } from "./state.js";
import { parentPost, getPageState } from "./tab.js";
import { updateRemoteTile } from "./media.js";
import { applyPartnerName, applyPartnerTheme } from "./settings.js";
import { hardReconnect, recentlyReloaded } from "./connection.js";
import { connectRelay } from "../transports/relay.js";
import { addMsg, addSys, showTyping } from "../features/chat.js";
import { burst, beatFast, runCountdown } from "../features/reactions.js";
import { receiveInvite } from "../features/invite.js";
import { refreshDates } from "../features/stats.js";
import { receiveWeather } from "../features/weather.js";
import { addTimelineItem } from "../features/timeline.js";
import {
  showPartnerMood, setWatchlist, setPartnerRating, setRemoteHold, showLetter,
  bumpCount, setCuddle, receiveMemory,
} from "../features/couple.js";
import { renderQotdAnswer, showPartnerCard, setQuizQuestion, renderQuizAnswer } from "../features/prompts.js";
import {
  tttReset, tttApply, doodleClear, doodleRemote, receiveRps, c4Reset, c4Apply,
  setEmojiPuzzle, renderEmojiGuess, emojiReveal,
} from "../features/games.js";
import { addToGallery, receivePbOpen, applyPbSettings, pbApplyIncomingShots, receivePbGo } from "../features/photobooth.js";

// Send over the active transport. Trystero/relay set S.sendData; manual mode
// falls back to the raw data channel.
export function netSend(obj) {
  try {
    if (S.sendData) S.sendData(obj);
    else if (S.rawDC && S.rawDC.readyState === "open") S.rawDC.send(JSON.stringify(obj));
  } catch (_) {}
}

// Decode one message from the partner. `lastRx` (liveness) is stamped first, and
// the connection-control messages are handled before the feature switch.
export async function handleData(d) {
  if (!d || !d.t) return;
  S.lastRx = Date.now(); // any traffic counts as "the link is alive"
  if (d.t === "ping") { netSend({ t: "pong" }); return; }
  if (d.t === "pong") return;
  if (d.t === "please-reload") { // partner wants a clean re-link
    if (S.relayMode) connectRelay();        // relay: rebuild the socket, don't reload the page
    else if (!recentlyReloaded()) hardReconnect();
    return;
  }
  switch (d.t) {
    case "name":
      applyPartnerName(d.name);
      break;
    case "chat":
      addMsg({ mine: false, who: S.settings.partner, text: d.text });
      break;
    case "gif":
      addMsg({ mine: false, who: S.settings.partner, gif: d.url });
      break;
    case "reaction":
      burst(d.reaction);
      break;
    case "video":
      parentPost({ kind: "apply-video", action: d.action, time: d.time, rate: d.rate, paused: d.paused, url: d.url, title: d.title, fromName: S.settings.partner });
      break;
    case "pos": // initiator's periodic playback position → follower nudges out drift
      if (!S.amInitiator && typeof d.time === "number") parentPost({ kind: "drift", time: d.time, paused: d.paused });
      break;
    case "stall": // partner is buffering — pause and wait for them
      parentPost({ kind: "stall", on: !!d.on });
      break;
    case "sync-req": {
      const s = await getPageState();
      netSend({ t: "sync-state", state: s });
      break;
    }
    case "sync-state":
      if (d.state) {
        parentPost({ kind: "apply-video", action: d.state.paused ? "pause" : "play", time: d.state.time, rate: d.state.rate, paused: d.state.paused, url: d.state.url, title: d.state.title, fromName: S.settings.partner });
      }
      break;
    case "typing":
      showTyping(d.on);
      break;
    case "poke":
      parentPost({ kind: "poke", text: `💗 ${S.settings.partner} misses you!` });
      beatFast();
      break;
    case "countdown":
      runCountdown(false);
      break;
    case "media-state":
      S.remoteState.mic = d.mic; S.remoteState.cam = d.cam;
      updateRemoteTile();
      break;
    case "invite":
      // Show the invite in the panel only (always available, works on any page
      // including new-tab/chrome://, and it does the redirect itself).
      receiveInvite(d.url, d.title);
      break;
    case "invite-ack":
      addSys(`${S.settings.partner} is joining 💞`);
      break;
    case "profile":
      if (typeof d.tz === "number") { S.partnerTz = d.tz; refreshDates(); }
      break;
    case "mood":
      showPartnerMood(d.mood);
      break;
    case "heartbeat":
      beatFast(); burst("heart");
      try { navigator.vibrate && navigator.vibrate([60, 40, 60]); } catch (_) {}
      addSys(`💓 ${S.settings.partner}'s heartbeat`);
      break;
    case "greet":
      parentPost({ kind: "toast", text: d.kind === "gm" ? `☀️ Good morning from ${S.settings.partner}!` : `🌙 Good night from ${S.settings.partner}!` });
      addSys(d.kind === "gm" ? `☀️ ${S.settings.partner} says good morning` : `🌙 ${S.settings.partner} says good night`);
      break;
    case "snap":
      addMsg({ mine: false, who: S.settings.partner, gif: d.img });
      addToGallery("img", d.img);
      break;
    case "clip":
      addMsg({ mine: false, who: S.settings.partner, clip: d.clip });
      addToGallery("clip", d.clip);
      break;
    case "pb-open":
      receivePbOpen();
      break;
    case "pb-set":
      applyPbSettings(d);
      break;
    case "pb-photo":
      pbApplyIncomingShots(d.shots);
      break;
    case "pb-go":
      receivePbGo(d);
      break;
    case "kiss-pause":
      parentPost({ kind: "apply-video", action: "pause" });
      burst("kiss");
      addSys(`💋 ${S.settings.partner} paused for a kiss`);
      break;
    case "qotd":
      renderQotdAnswer(S.settings.partner, d.text);
      break;
    case "card":
      showPartnerCard(d.kind, d.text);
      break;
    case "watchlist":
      setWatchlist(d.items);
      break;
    case "rate":
      setPartnerRating(d.value);
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
      applyPartnerTheme(d.color);
      break;
    case "hand":
      setRemoteHold(!!d.on);
      break;
    case "letter":
      showLetter(S.partnerReal && S.settings.partner, d.text);
      break;
    case "count":
      bumpCount(d.kind, true);
      break;
    case "quiz-q":
      setQuizQuestion(d.q, false);
      break;
    case "quiz-a":
      renderQuizAnswer(S.settings.partner, d.text);
      break;
    case "cuddle":
      setCuddle(!!d.on, false);
      break;
    case "memory":
      receiveMemory(d.item);
      break;
    case "weather":
      receiveWeather(d.temp, d.code, d.isDay);
      break;
    case "rps":
      receiveRps(d);
      break;
    case "c4":
      if (d.reset) c4Reset(false);
      else if (typeof d.col === "number") c4Apply(d.col, d.color);
      break;
    case "emoji-q":
      if (typeof d.i === "number") setEmojiPuzzle(d.deck || "movie", d.i, false);
      break;
    case "emoji-a":
      renderEmojiGuess(S.settings.partner, d.text);
      break;
    case "emoji-r":
      emojiReveal(false);
      break;
    case "mark":
      addTimelineItem({ time: d.time, emoji: d.emoji, who: d.who || S.settings.partner, title: d.title || "", url: d.url || "" });
      break;
  }
}
