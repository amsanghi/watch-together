// WatchTogether — the active-tab bridge.
// Talks to the active tab's content script (content.js) over chrome messaging:
// pushes video/effect commands to the page, pulls the page's current <video>
// state, and listens for events the page reports back (play/pause/seek,
// "video found", tab hello, invite accepted).
//
// Exports: parentPost, getPageState, registerTabListener.

import { $ } from "./dom.js";
import { S } from "./state.js";
import { netSend } from "./net.js";
import { addMsg, addSys } from "../features/chat.js";
import { addToGallery } from "../features/photobooth.js";
import { checkCapsules } from "../features/capsule.js";

// Send a message to the active tab's content script (video control / effects).
export function parentPost(msg) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const id = tabs && tabs[0] && tabs[0].id;
    if (id != null) chrome.tabs.sendMessage(id, { __wt: true, ...msg }, () => void chrome.runtime.lastError);
  });
}

// Ask the active tab's content script for the page's current <video> state.
// Resolves null if nothing answers within 1.5s (e.g. chrome:// / new-tab pages).
export function getPageState() {
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

// Messages from content scripts (any tab in this window). Registered once from
// init() so all listener wiring stays visible in main.js.
// Turn a captured frame into a top/bottom-text meme, then share it.
function makeMeme(img) {
  const top = (prompt("Top text (optional):") || "").toUpperCase();
  const bottom = (prompt("Bottom text (optional):") || "").toUpperCase();
  const im = new Image();
  im.onload = () => {
    const c = document.createElement("canvas"); c.width = im.width; c.height = im.height;
    const x = c.getContext("2d"); x.drawImage(im, 0, 0);
    const fs = Math.round(c.width / 10);
    x.font = "900 " + fs + "px Impact, system-ui, sans-serif"; x.textAlign = "center";
    x.lineWidth = Math.max(2, fs / 10); x.strokeStyle = "#000"; x.fillStyle = "#fff";
    x.textBaseline = "top"; if (top) { x.strokeText(top, c.width / 2, 8); x.fillText(top, c.width / 2, 8); }
    x.textBaseline = "bottom"; if (bottom) { x.strokeText(bottom, c.width / 2, c.height - 8); x.fillText(bottom, c.width / 2, c.height - 8); }
    const out = c.toDataURL("image/jpeg", 0.8);
    addMsg({ mine: true, who: S.settings.me, gif: out }); addToGallery("img", out); netSend({ t: "snap", img: out });
  };
  im.src = img;
}

export function registerTabListener() {
  chrome.runtime.onMessage.addListener((d, sender) => {
    if (!d || d.__wt !== true) return;
    switch (d.kind) {
      case "video-event":
        netSend({ t: "video", action: d.action, time: d.time, rate: d.rate, paused: d.paused, url: d.url, title: d.title });
        checkCapsules(d);
        break;
      case "video-stall":
        netSend({ t: "stall", on: !!d.on });
        break;
      case "annot":
        netSend({ t: "annot", akind: d.akind, x: d.x, y: d.y, x2: d.x2, y2: d.y2, color: d.color, emoji: d.emoji });
        break;
      case "cursor":
        netSend({ t: "cursor", x: d.x, y: d.y });
        break;
      case "frame": // a captured movie frame → gallery + partner (optionally meme'd)
        if (d.img) {
          if (d.meme) makeMeme(d.img);
          else { addMsg({ mine: true, who: S.settings.me, gif: d.img }); addToGallery("img", d.img); netSend({ t: "snap", img: d.img }); }
        } else addSys("Couldn't grab this video (DRM-protected 🔒)");
        break;
      case "video-found":
        $("video-warn").classList.add("found");
        $("video-warn").title = "Video detected — controls are synced";
        break;
      case "hello":
        // A tab (re)loaded — if it followed a Join (page banner or panel accept),
        // re-sync it to the partner.
        if ((d.following || S.pendingFollow) && S.connectedOnce) { netSend({ t: "sync-req" }); S.pendingFollow = false; }
        break;
      case "invite-accepted":
        if (S.connectedOnce) netSend({ t: "invite-ack" });
        break;
    }
  });
}
