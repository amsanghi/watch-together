// WatchTogether — top-level UI chrome: which panel is visible, the presence
// state (which everything else in the stylesheet keys off), and the pairing
// error line.
//
// Exports: showPanel, setStatus, showError, initials.

import { $ } from "./dom.js";
import { S } from "./state.js";

// Show exactly one of the top-level panels; hide the rest.
export function showPanel(name) {
  ["name", "connect", "live", "settings", "history", "fun"].forEach((p) => {
    $(p + "-panel").classList.toggle("hidden", p !== name);
  });
}

export function initials(name) {
  const c = (name || "").trim().charAt(0);
  return c ? c.toUpperCase() : "·";
}

// Reflect the connection state. `data-presence` on #app is the single switch the
// stylesheet reads — the two header dots, the presence thread and the accent
// treatment all follow from it. `s` is "off" | "connecting" | "on".
export function setStatus(s) {
  const app = $("app");
  if (app) app.dataset.presence = s;

  const dot = $("status-dot");
  dot.className = "p-dot p-them " + s;
  dot.title = s === "on" ? "They're here" : s === "connecting" ? "Reaching them…" : "Not connected";

  const named = S.settings.partner && S.settings.partner !== "Partner";
  const label = $("header-status");
  if (label) {
    label.textContent = s === "on"
      ? (named ? S.settings.partner : "Connected")
      : s === "connecting" ? (named ? S.settings.partner : "Connecting") : "Not connected";
  }
  const sub = $("header-sub");
  if (sub) {
    sub.textContent = s === "on" ? "watching together" : s === "connecting" ? "reaching them" : "WatchTogether";
  }
}

export function showError(msg) {
  const el = $("connect-error");
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}
