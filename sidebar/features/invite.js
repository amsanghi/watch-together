// WatchTogether — "watch this together" invites. You invite the partner to the
// video in your active tab; they get a banner in the panel (works on any page,
// including new-tab/chrome://) and one click navigates their tab and re-syncs.
//
// Exports: sendInvite, showInviteBanner, hideInviteBanner, acceptInvite,
//   receiveInvite.

import { $ } from "../core/dom.js";
import { S } from "../core/state.js";
import { netSend } from "../core/net.js";
import { getPageState } from "../core/tab.js";
import { addSys } from "./chat.js";

let pendingInvite = null;

// Invite the partner to the video in the active tab.
export async function sendInvite() {
  if (!S.connectedOnce) { addSys("Not connected yet — pair first."); return; }
  const s = await getPageState();
  if (!s || !s.url || /^chrome|^about:|^edge|^devtools/.test(s.url)) { addSys("Open the video first, then invite them."); return; }
  netSend({ t: "invite", url: s.url, title: s.title });
  addSys(`Invite sent to ${S.settings.partner}.`);
}

export function showInviteBanner(title) {
  const t = title ? (title.length > 70 ? title.slice(0, 67) + "…" : title) : "something";
  const el = $("invite-text");
  el.innerHTML = "";
  const who = document.createElement("b"); who.textContent = S.settings.partner;
  el.append(who, document.createTextNode(" wants to watch "));
  const what = document.createElement("i"); what.textContent = t;
  el.append(what, document.createTextNode(" with you."));
  $("invite-banner").classList.remove("hidden");
}
export function hideInviteBanner() { $("invite-banner").classList.add("hidden"); }

// Accept: navigate the active tab ourselves (works even on new-tab/chrome://),
// then re-sync to the partner once the page's content script says hello.
export function acceptInvite() {
  const url = pendingInvite && pendingInvite.url;
  hideInviteBanner();
  if (!url) return;
  S.pendingFollow = true;
  netSend({ t: "invite-ack" });
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const id = tabs && tabs[0] && tabs[0].id;
    if (id != null) chrome.tabs.update(id, { url });
    else chrome.tabs.create({ url });
  });
}

// Partner invited us (net.js `invite` case): remember it + show the banner.
export function receiveInvite(url, title) {
  pendingInvite = { url, title };
  showInviteBanner(title);
}
