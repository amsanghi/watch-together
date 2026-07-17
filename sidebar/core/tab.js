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
export function registerTabListener() {
  chrome.runtime.onMessage.addListener((d, sender) => {
    if (!d || d.__wt !== true) return;
    switch (d.kind) {
      case "video-event":
        netSend({ t: "video", action: d.action, time: d.time, rate: d.rate, paused: d.paused, url: d.url, title: d.title });
        break;
      case "video-stall":
        netSend({ t: "stall", on: !!d.on });
        break;
      case "annot":
        netSend({ t: "annot", akind: d.akind, x: d.x, y: d.y, x2: d.x2, y2: d.y2, color: d.color });
        break;
      case "cursor":
        netSend({ t: "cursor", x: d.x, y: d.y });
        break;
      case "frame": // a captured movie frame → into the shared gallery + to the partner
        if (d.img) { addMsg({ mine: true, who: S.settings.me, gif: d.img }); addToGallery("img", d.img); netSend({ t: "snap", img: d.img }); }
        else addSys("Couldn't grab this video (DRM-protected 🔒)");
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
