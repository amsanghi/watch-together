// WatchTogether — chat: the message log, typing indicator, the composer's
// emoji picker, and Giphy search. `addSys()` (a system/status line in the log)
// is the app's general-purpose notice and is imported widely.
//
// Exports: addMsg, addSys, addSysReady, showTyping, sendChat, buildEmoji,
//   searchGifs, searchGifsDebounced.

import { $ } from "../core/dom.js";
import { S } from "../core/state.js";
import { netSend } from "../core/net.js";

// ---- Chat log -----------------------------------------------------------
export function addMsg({ mine, who, text, gif, clip }) {
  const el = document.createElement("div");
  el.className = "msg " + (mine ? "me" : "them");
  if (!mine) {
    const w = document.createElement("div");
    w.className = "who"; w.textContent = who;
    el.appendChild(w);
  }
  if (text) {
    const t = document.createElement("div");
    t.textContent = text;
    el.appendChild(t);
  }
  if (gif) {
    const img = document.createElement("img");
    img.src = gif; img.alt = "gif";
    el.appendChild(img);
  }
  if (clip) {
    const v = document.createElement("video");
    v.src = clip; v.loop = true; v.autoplay = true; v.muted = true; v.playsInline = true;
    v.style.maxWidth = "100%"; v.style.borderRadius = "14px"; v.style.display = "block";
    el.appendChild(v);
  }
  const chat = $("chat");
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
}

export function addSys(text) {
  const el = document.createElement("div");
  el.className = "msg sys";
  el.textContent = text;
  $("chat").appendChild(el);
  $("chat").scrollTop = $("chat").scrollHeight;
}
export function addSysReady() { /* placeholder for future "room ready" hint */ }

// ---- Typing indicator ---------------------------------------------------
let typingTimer = null;
export function showTyping(on) {
  const el = $("typing-ind");
  el.classList.toggle("hidden", !on);
  const label = el.querySelector("span");
  if (label) label.textContent = on ? `${S.settings.partner} is typing` : "";
  clearTimeout(typingTimer);
  if (on) typingTimer = setTimeout(() => el.classList.add("hidden"), 4000);
}

export function sendChat() {
  const input = $("msg-input");
  const text = input.value.trim();
  if (!text) return;
  addMsg({ mine: true, text });
  netSend({ t: "chat", text });
  input.value = "";
  netSend({ t: "typing", on: false });
}

// ---- Emoji picker -------------------------------------------------------
const EMOJIS = ("😀 😂 🥰 😍 😘 😅 😊 😎 🤩 🥳 😜 🤗 🤔 🙄 😴 😭 😡 👍 👎 👏 🙌 🙏 💪 👀 "
  + "❤️ 🧡 💛 💚 💙 💜 🖤 💖 💕 💞 💓 💗 💘 💝 💋 🌹 🔥 ✨ 🎉 🍿 🎬 🥂 🍕 🌙 ⭐ ☕ 🐻 🐱 🐶 🦦").trim().split(/\s+/);
export function buildEmoji() {
  const p = $("emoji-panel");
  EMOJIS.forEach((e) => {
    const b = document.createElement("button");
    b.textContent = e;
    b.addEventListener("click", () => {
      $("msg-input").value += e;
      $("msg-input").focus();
    });
    p.appendChild(b);
  });
}

// ---- GIFs (Giphy) -------------------------------------------------------
let gifTimer = null;
export async function searchGifs(q) {
  if (!S.settings.giphyKey) {
    $("gif-needkey").classList.remove("hidden");
    $("gif-results").innerHTML = "";
    return;
  }
  $("gif-needkey").classList.add("hidden");
  const base = "https://api.giphy.com/v1/gifs/";
  const url = q
    ? `${base}search?api_key=${S.settings.giphyKey}&q=${encodeURIComponent(q)}&limit=24&rating=pg-13&bundle=messaging_non_clips`
    : `${base}trending?api_key=${S.settings.giphyKey}&limit=24&rating=pg-13&bundle=messaging_non_clips`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.meta && data.meta.status >= 400) throw new Error(data.meta.msg || "Giphy error");
    const grid = $("gif-results");
    grid.innerHTML = "";
    (data.data || []).forEach((g) => {
      const imgs = g.images || {};
      const thumb = imgs.fixed_width_small?.url || imgs.preview_gif?.url || imgs.fixed_height_small?.url;
      if (!thumb) return;
      const full = imgs.downsized_medium?.url || imgs.fixed_height?.url || imgs.original?.url || thumb;
      const img = document.createElement("img");
      img.src = thumb;
      img.addEventListener("click", () => {
        addMsg({ mine: true, gif: full });
        netSend({ t: "gif", url: full });
        $("gif-panel").classList.add("hidden");
      });
      grid.appendChild(img);
    });
    if (!grid.children.length) grid.innerHTML = '<div class="copy">Nothing matched. Try another word.</div>';
  } catch (e) {
    $("gif-results").innerHTML = '<div class="copy">Couldn\'t reach Giphy. Check the key in settings.</div>';
  }
}

// Debounced variant used by the search box's input handler.
export function searchGifsDebounced(q) {
  clearTimeout(gifTimer);
  gifTimer = setTimeout(() => searchGifs(q), 350);
}
