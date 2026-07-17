// WatchTogether — intimacy toys: a synced kiss cam and a "breathe together"
// wind-down guide. Both are full-panel overlays mirrored to each side.
//
// Exports: sendKissCam, showKissCam, sendBreathe, showBreathe.

import { netSend } from "../core/net.js";
import { $ } from "../core/dom.js";

let kcT = null, brT = null;

export function sendKissCam() { netSend({ t: "kisscam" }); showKissCam(); }
export function showKissCam() {
  const el = $("kisscam"); if (!el) return;
  el.classList.remove("hidden");
  clearTimeout(kcT); kcT = setTimeout(() => el.classList.add("hidden"), 4500);
}

export function sendBreathe() { netSend({ t: "breathe" }); showBreathe(); }
export function showBreathe() {
  const el = $("breathe"); if (!el) return;
  el.classList.remove("hidden");
  clearTimeout(brT); brT = setTimeout(() => el.classList.add("hidden"), 32000);
}
