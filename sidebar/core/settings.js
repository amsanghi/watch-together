// WatchTogether — settings: load/save the persisted `wt_settings`, the
// first-run name gate, the shared theme color, and applying the partner's
// name/theme when they arrive over the wire.
//
// Exports: loadSettings, saveName, saveSettings, applyTheme, applyNames,
//   markSwatch, shade, applyPartnerName, applyPartnerTheme.

import { $ } from "./dom.js";
import { S, DEFAULT_GIPHY_KEY, DEFAULT_THEME } from "./state.js";
import { showPanel, setStatus, initials } from "./ui.js";
import { netSend } from "./net.js";
import { applyRemoteVolume, resumeMedia } from "./media.js";
import { refreshStats, refreshDates } from "../features/stats.js";
import { showPairStatus, connect, restoreChat } from "./connection.js";

export function loadSettings() {
  chrome.storage.local.get(["wt_settings", "wt_media"], (r) => {
    if (r.wt_settings) S.settings = { ...S.settings, ...r.wt_settings };
    if (r.wt_media) { S.wantMic = !!r.wt_media.mic; S.wantCam = !!r.wt_media.cam; }
    if (!S.settings.giphyKey) S.settings.giphyKey = DEFAULT_GIPHY_KEY; // fall back to built-in key
    // Restore the partner's remembered name so it shows immediately on reopen,
    // before they reconnect and re-send it.
    if (S.settings.partnerName) S.partnerReal = S.settings.partnerName;
    S.settings.partner = S.settings.petName || S.partnerReal || "Partner";
    $("set-me").value = S.settings.me;
    $("set-giphy").value = S.settings.giphyKey;
    $("set-autocam").checked = S.settings.autocam;
    $("set-petname").value = S.settings.petName || "";
    $("set-theme").value = S.settings.themeColor || DEFAULT_THEME;
    $("set-anniversary").value = S.settings.anniversary || "";
    $("set-bday-me").value = S.settings.bdayMe || "";
    $("set-bday-partner").value = S.settings.bdayPartner || "";
    applyNames();
    applyRemoteVolume();
    applyTheme(S.settings.themeColor || DEFAULT_THEME);
    refreshStats();
    refreshDates();
    if ($("pair-code")) $("pair-code").value = S.settings.pairCode || "";
    if ($("relay-url")) $("relay-url").value = S.settings.relayUrl || "";
    if ($("turn-url")) $("turn-url").value = S.settings.turnUrl || "";
    if ($("turn-user")) $("turn-user").value = S.settings.turnUser || "";
    if ($("turn-pass")) $("turn-pass").value = S.settings.turnPass || "";
    // First open: ask for a name before anything else, then remember it.
    if (!S.settings.named) {
      $("set-me-first").value = S.settings.me === "You" ? "" : S.settings.me;
      showPanel("name");
      setTimeout(() => $("set-me-first").focus(), 50);
    } else {
      showPanel("connect");
      // Already paired → connect automatically, no codes or buttons.
      // (settings.paired is false only after an explicit Unpair; legacy settings
      // without the flag are treated as paired so existing users still auto-connect.)
      if (S.settings.paired !== false && (S.settings.pairCode || S.settings.relayUrl)) {
        let reconnecting = false;
        try { reconnecting = sessionStorage.getItem("wt_reconnecting") === "1"; } catch (_) {}
        if (reconnecting) {
          // Auto-reload reconnect: keep the conversation, skip the pairing
          // screen, and go straight back to the live view while we re-link.
          try { sessionStorage.removeItem("wt_reconnecting"); } catch (_) {}
          S.everConnected = true;
          S.pendingPartnerReload = true; // heal the partner's media once we relink
          restoreChat();
          showPanel("live");
          setStatus("connecting");
        } else {
          showPairStatus();
        }
        connect();
      }
      // Restore mic/cam to their last state (if permission's already granted).
      if (S.wantMic || S.wantCam) resumeMedia();
    }
  });
}

export function saveName() {
  const n = $("set-me-first").value.trim();
  if (!n) { $("set-me-first").focus(); return; }
  S.settings.me = n;
  S.settings.named = true;
  chrome.storage.local.set({ wt_settings: S.settings });
  $("set-me").value = n;
  applyNames();
  showPanel("connect");
}

// Every place a name is shown: the greeting, both camera tiles (label + the
// monogram that stands in for a dark tile), the Fun-panel clocks, the header.
export function applyNames() {
  const me = S.settings.me, them = S.settings.partner;
  const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
  set("me-name", me);
  set("local-label", me);
  set("remote-label", them);
  set("local-mono", initials(me));
  set("remote-mono", initials(them));
  set("fun-local-mono", initials(me));
  set("fun-remote-mono", initials(them));
  set("clock-me-label", me);
  set("clock-them-label", them);
  set("fun-local-label", me);
  set("fun-remote-label", them);
  if (S.connectedOnce) set("header-status", them);
}

export function saveSettings() {
  S.settings.me = $("set-me").value.trim() || "You";
  S.settings.named = true;
  S.settings.giphyKey = $("set-giphy").value.trim();
  S.settings.autocam = $("set-autocam").checked;
  S.settings.petName = $("set-petname").value.trim();
  const newColor = $("set-theme").value;
  const colorChanged = newColor !== S.settings.themeColor;
  S.settings.themeColor = newColor;
  S.settings.anniversary = $("set-anniversary").value || "";
  S.settings.bdayMe = $("set-bday-me").value || "";
  S.settings.bdayPartner = $("set-bday-partner").value || "";
  if (S.partnerReal && S.partnerReal !== "Partner") S.settings.partnerName = S.partnerReal;
  S.settings.partner = S.settings.petName || S.partnerReal || "Partner";
  chrome.storage.local.set({ wt_settings: S.settings });
  applyTheme(S.settings.themeColor);
  if (colorChanged) netSend({ t: "theme", color: S.settings.themeColor });
  applyNames();
  refreshDates();
  showPanel(S.connectedOnce ? "live" : "connect");
}

// ---- Theme color (shared accent) ----------------------------------------
export function shade(hex, pct) {
  hex = (hex || DEFAULT_THEME).replace("#", "");
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  const num = parseInt(hex, 16);
  let r = (num >> 16) & 255, g = (num >> 8) & 255, b = num & 255;
  const t = pct < 0 ? 0 : 255, p = Math.abs(pct);
  r = Math.round((t - r) * p) + r; g = Math.round((t - g) * p) + g; b = Math.round((t - b) * p) + b;
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}
// Only "their" side is themed. `--them` in the stylesheet aliases `--accent`,
// so setting these three cascades to every partner-coloured element and to the
// two-tone `--us` gradient.
export function applyTheme(color) {
  if (!color) return;
  const r = document.documentElement.style;
  r.setProperty("--accent", color);
  r.setProperty("--accent2", shade(color, 0.34));
  r.setProperty("--accent-d", shade(color, -0.22));
  markSwatch(color);
}

// Light the preset that matches the current colour (custom picks light none).
export function markSwatch(color) {
  const wrap = $("theme-swatches");
  if (!wrap) return;
  const want = (color || "").toLowerCase();
  wrap.querySelectorAll(".swatch[data-color]").forEach((b) => {
    b.classList.toggle("is-on", b.dataset.color.toLowerCase() === want);
  });
  const custom = wrap.querySelector(".swatch.custom");
  if (custom) custom.style.setProperty("--sw", color);
}

// ---- Applied when the partner sends theirs over the wire ----------------
export function applyPartnerName(name) {
  S.partnerReal = name || S.partnerReal;
  S.settings.partnerName = S.partnerReal;                 // remember across restarts
  S.settings.partner = S.settings.petName || S.partnerReal;
  chrome.storage.local.set({ wt_settings: S.settings });
  applyNames();
}

export function applyPartnerTheme(color) {
  if (color) {
    S.settings.themeColor = color;
    applyTheme(color);
    chrome.storage.local.set({ wt_settings: S.settings });
    if ($("set-theme")) $("set-theme").value = color;
  }
}
