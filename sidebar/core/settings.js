// WatchTogether — settings: load/save the persisted `wt_settings`, the
// first-run name gate, the shared theme color, and applying the partner's
// name/theme when they arrive over the wire.
//
// Exports: loadSettings, saveName, saveSettings, applyTheme, shade,
//   applyPartnerName, applyPartnerTheme.

import { $ } from "./dom.js";
import { S, DEFAULT_GIPHY_KEY } from "./state.js";
import { showPanel, setStatus } from "./ui.js";
import { netSend } from "./net.js";
import { applyRemoteVolume, resumeMedia } from "./media.js";
import { refreshAudioSettings } from "./audioproc.js";
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
    $("me-name").textContent = S.settings.me;
    $("set-me").value = S.settings.me;
    $("set-giphy").value = S.settings.giphyKey;
    $("set-autocam").checked = S.settings.autocam;
    if ($("set-micgate")) $("set-micgate").checked = S.settings.micGate !== false;
    if ($("set-autoduck")) $("set-autoduck").checked = S.settings.autoDuck !== false;
    if ($("set-autolevel")) $("set-autolevel").checked = S.settings.autoLevel !== false;
    if ($("set-clapreact")) $("set-clapreact").checked = S.settings.clapReact !== false;
    if ($("set-scarecam")) $("set-scarecam").checked = !!S.settings.scareCam;
    document.querySelectorAll(".audio-tune").forEach((el) => {
      const v = S.settings[el.dataset.key];
      if (typeof v === "number") el.value = v;
      const out = document.getElementById(el.id + "-val"); if (out) out.textContent = el.value;
    });
    $("set-petname").value = S.settings.petName || "";
    $("set-theme").value = S.settings.themeColor || "#ff7ec0";
    $("set-anniversary").value = S.settings.anniversary || "";
    $("set-bday-me").value = S.settings.bdayMe || "";
    $("set-bday-partner").value = S.settings.bdayPartner || "";
    $("local-label").textContent = S.settings.me;
    $("remote-label").textContent = S.settings.partner;
    applyRemoteVolume();
    if (S.settings.themeColor) applyTheme(S.settings.themeColor);
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
  $("me-name").textContent = n;
  $("set-me").value = n;
  $("local-label").textContent = n;
  showPanel("connect");
}

export function saveSettings() {
  S.settings.me = $("set-me").value.trim() || "You";
  S.settings.named = true;
  S.settings.giphyKey = $("set-giphy").value.trim();
  S.settings.autocam = $("set-autocam").checked;
  if ($("set-micgate")) S.settings.micGate = $("set-micgate").checked;
  if ($("set-autoduck")) S.settings.autoDuck = $("set-autoduck").checked;
  if ($("set-autolevel")) S.settings.autoLevel = $("set-autolevel").checked;
  if ($("set-clapreact")) S.settings.clapReact = $("set-clapreact").checked;
  if ($("set-scarecam")) S.settings.scareCam = $("set-scarecam").checked;
  document.querySelectorAll(".audio-tune").forEach((el) => { S.settings[el.dataset.key] = Number(el.value); });
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
  refreshAudioSettings(); // apply mic-gate / auto-duck / auto-level changes live
  $("me-name").textContent = S.settings.me;
  $("local-label").textContent = S.settings.me;
  $("remote-label").textContent = S.settings.partner;
  if (S.connectedOnce && $("header-status")) $("header-status").textContent = S.settings.partner;
  refreshDates();
  showPanel(S.connectedOnce ? "live" : "connect");
}

// ---- Theme color (shared accent) ----------------------------------------
export function shade(hex, pct) {
  hex = (hex || "#ff7ec0").replace("#", "");
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  const num = parseInt(hex, 16);
  let r = (num >> 16) & 255, g = (num >> 8) & 255, b = num & 255;
  const t = pct < 0 ? 0 : 255, p = Math.abs(pct);
  r = Math.round((t - r) * p) + r; g = Math.round((t - g) * p) + g; b = Math.round((t - b) * p) + b;
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}
export function applyTheme(color) {
  if (!color) return;
  const light = shade(color, 0.32), deep = shade(color, -0.18);
  const r = document.documentElement.style;
  r.setProperty("--accent", color);
  r.setProperty("--accent-d", deep);
  r.setProperty("--accent2", light);
  r.setProperty("--grad", `linear-gradient(135deg, ${light} 0%, ${color} 100%)`);
  r.setProperty("--grad-purple", `linear-gradient(135deg, ${shade(color, 0.1)} 0%, ${color} 100%)`);
  r.setProperty("--glow", `0 0 16px ${color}80`);
}

// ---- Applied when the partner sends theirs over the wire ----------------
export function applyPartnerName(name) {
  S.partnerReal = name || S.partnerReal;
  S.settings.partnerName = S.partnerReal;                 // remember across restarts
  S.settings.partner = S.settings.petName || S.partnerReal;
  chrome.storage.local.set({ wt_settings: S.settings });
  $("remote-label").textContent = S.settings.partner;
  if (S.connectedOnce && $("header-status")) $("header-status").textContent = S.settings.partner;
}

export function applyPartnerTheme(color) {
  if (color) {
    S.settings.themeColor = color;
    applyTheme(color);
    chrome.storage.local.set({ wt_settings: S.settings });
    if ($("set-theme")) $("set-theme").value = color;
  }
}
