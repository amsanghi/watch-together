// WatchTogether — top-level UI chrome: which panel is visible, the connection
// status dot / presence heart, and the pairing error line.
//
// Exports: showPanel, setStatus, showError.

import { $ } from "./dom.js";
import { S } from "./state.js";

// Show exactly one of the top-level panels; hide the rest.
export function showPanel(name) {
  ["name", "connect", "live", "settings", "history", "fun"].forEach((p) => {
    $(p + "-panel").classList.toggle("hidden", p !== name);
  });
}

// Reflect the connection state in the header dot, the presence heart, and the
// header label. `s` is one of: "off" | "connecting" | "on".
export function setStatus(s) {
  const dot = $("status-dot");
  dot.className = "dot " + s;
  dot.title = s === "on" ? "Connected" : s === "connecting" ? "Connecting…" : "Disconnected";
  $("presence-heart").className = s === "on" ? "heart-beat" : "heart-idle";
  const label = $("header-status");
  if (label) {
    label.textContent = s === "on"
      ? (S.settings.partner && S.settings.partner !== "Partner" ? S.settings.partner : "Connected")
      : s === "connecting" ? "Connecting…" : "Not connected";
  }
}

export function showError(msg) {
  const el = $("connect-error");
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}
