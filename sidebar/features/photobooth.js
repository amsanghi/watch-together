// WatchTogether — the photobooth: synced countdown captures (single / 3-shot
// strip / short looping clip), filters + stickers + captions, "just me" or a
// stitched "us" layout (both sides exchange HD frames so each half is crisp),
// doodle-on-photo, and the shared gallery of everything you've shot. All state
// is feature-local; net.js drives the remote side through the receive*/apply*
// exports so it never pokes internals.
//
// Exports (main.js wiring): openPhotobooth, closePhotobooth, pbStart, pbSend,
//   pbSave, pbDownload, pbRetake, pbDrawInit, pbClearDraw, pbOnControl,
//   renderGallery, clearGallery, loadGallery.
// Exports (net.js handlers): addToGallery, receivePbOpen, applyPbSettings,
//   pbApplyIncomingShots, receivePbGo.

import { $ } from "../core/dom.js";
import { S } from "../core/state.js";
import { netSend } from "../core/net.js";
import { toggleCam } from "../core/media.js";
import { addMsg, addSys } from "./chat.js";
import { spawnPanelHearts, burst } from "./reactions.js";
import { todayStr } from "./stats.js";
import { renderScrapbook } from "./couple.js";

const PB_FILTERS = {
  none: "none",
  bw: "grayscale(1) contrast(1.08)",
  sepia: "sepia(0.85)",
  vintage: "sepia(0.4) contrast(1.2) saturate(1.5) hue-rotate(-12deg)",
  dreamy: "brightness(1.12) saturate(1.35) contrast(0.95) blur(0.4px)",
  blush: "saturate(1.5) brightness(1.06) contrast(1.04)",
  neon: "saturate(2.2) contrast(1.35) hue-rotate(18deg)",
  invert: "invert(1)",
};
let pbFilter = "none", pbMode = "single", pbLayout = "me", pbSticker = "💕", pbBusy = false, pbTimer = 3;
let pbResult = null, pbClip = null, pbResultType = "img", pbDrawCtx = null;
let pbSession = null, pbIncomingShots = null, pbStitchTimer = null;
let gallery = [];
const pbWait = (ms) => new Promise((r) => setTimeout(r, ms));
const blobToDataURL = (blob) => new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });

export async function openPhotobooth(remote) {
  $("pb-overlay").classList.remove("hidden");
  $("pb-result").classList.add("hidden");
  $("pb-live").classList.remove("hidden");
  if (!remote) netSend({ t: "pb-open" });
  pbSyncStatus();
  if (!S.camOn) { try { await toggleCam(); } catch (_) {} }
  $("pb-local").srcObject = S.localStream;
  pbUpdatePreview();
}
export function closePhotobooth() { $("pb-overlay").classList.add("hidden"); }
function pbSyncStatus() {
  $("pb-sync").textContent = S.connectedOnce
    ? `In step with ${S.settings.partner} — the timer runs on both sides.`
    : "On your own for now. Connect to snap together.";
}
// Apply settings pushed by the partner (no rebroadcast).
export function applyPbSettings(d) {
  if (d.filter != null) { pbFilter = d.filter; pbSelect("pb-filters", "filter", pbFilter); }
  if (d.mode != null) { pbMode = d.mode; pbSelect("pb-mode", "mode", pbMode); }
  if (d.layout != null) { pbLayout = d.layout; pbSelect("pb-layout", "layout", pbLayout); }
  if (d.sticker != null) { pbSticker = d.sticker; pbSelect("pb-stickers", "sticker", pbSticker); }
  if (d.timer != null) { pbTimer = d.timer; pbSelect("pb-timer", "timer", String(pbTimer)); }
  pbUpdatePreview();
}
function broadcastPbSet() {
  netSend({ t: "pb-set", filter: pbFilter, mode: pbMode, layout: pbLayout, sticker: pbSticker, timer: pbTimer });
}
// A control chip was clicked in our panel: update the setting, reflect it, and
// push it to the partner. Wired from main.js so listener setup stays there.
export function pbOnControl(kind, value) {
  if (kind === "filter") { pbFilter = value; pbSelect("pb-filters", "filter", pbFilter); pbUpdatePreview(); }
  else if (kind === "sticker") { pbSticker = value; pbSelect("pb-stickers", "sticker", pbSticker); pbUpdatePreview(); }
  else if (kind === "mode") { pbMode = value; pbSelect("pb-mode", "mode", pbMode); }
  else if (kind === "layout") { pbLayout = value; pbSelect("pb-layout", "layout", pbLayout); pbUpdatePreview(); }
  else if (kind === "timer") { pbTimer = Number(value); pbSelect("pb-timer", "timer", String(pbTimer)); }
  broadcastPbSet();
}
// Start a synced capture: both panels run the same timer and snap together.
export function pbStart() {
  if (pbBusy) return;
  netSend({ t: "pb-go", mode: pbMode, layout: pbLayout, filter: pbFilter, sticker: pbSticker, timer: pbTimer });
  pbRun();
}
function pbRun() { if (pbBusy) return; return pbMode === "boom" ? pbRunClip() : pbRunPhoto(); }
function pbUpdatePreview() {
  const rv = $("pb-remote");
  const useUs = pbLayout === "us" && $("remote-video").srcObject;
  if (useUs) { rv.srcObject = $("remote-video").srcObject; rv.classList.remove("hidden"); }
  else rv.classList.add("hidden");
  const f = PB_FILTERS[pbFilter] || "none";
  $("pb-local").style.filter = f;
  rv.style.filter = f;
  document.querySelectorAll("#pb-stage .pb-stk").forEach((s) => { s.textContent = pbSticker; });
}
function pbSelect(container, attr, val) {
  document.querySelectorAll(`#${container} [data-${attr}]`).forEach((b) => b.classList.toggle("sel", b.dataset[attr] === val));
}
function pbCountdown(seconds) {
  return new Promise((res) => {
    let n = seconds || pbTimer || 3;
    const el = $("pb-count");
    el.textContent = n; el.classList.remove("hidden");
    const iv = setInterval(() => {
      n--;
      if (n <= 0) { clearInterval(iv); el.textContent = "📸"; setTimeout(() => { el.classList.add("hidden"); res(); }, 240); }
      else el.textContent = n;
    }, 1000);
  });
}
function pbFlash() { const f = $("pb-flash"); f.classList.remove("go"); void f.offsetWidth; f.classList.add("go"); }
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function drawCover(ctx, video, x, y, w, h, mirror, filter) {
  ctx.save();
  roundRect(ctx, x, y, w, h, 2); ctx.clip();
  const vw = video && video.videoWidth, vh = video && video.videoHeight;
  if (!vw || !vh) { ctx.fillStyle = "#2c1f38"; ctx.fillRect(x, y, w, h); ctx.restore(); return; }
  const scale = Math.max(w / vw, h / vh);
  const dw = vw * scale, dh = vh * scale;
  const dx = x + (w - dw) / 2, dy = y + (h - dh) / 2;
  ctx.filter = filter || "none";
  if (mirror) { ctx.translate(2 * (x + w / 2), 0); ctx.scale(-1, 1); }
  ctx.drawImage(video, dx, dy, dw, dh);
  ctx.restore();
}
// Grab one full-res frame of the LOCAL camera (mirrored, filter baked in).
// We capture each side locally in HD and exchange the frames, so both halves
// of an "Us" shot are crisp instead of the low-res streamed video.
function pbGrabLocal(filterKey) {
  const v = $("local-video");
  let w = v.videoWidth || 1280, h = v.videoHeight || 720;
  const cap = 1280;
  if (Math.max(w, h) > cap) { const sc = cap / Math.max(w, h); w = Math.round(w * sc); h = Math.round(h * sc); }
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const cx = c.getContext("2d");
  cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = "high";
  cx.filter = PB_FILTERS[filterKey] || "none";
  // Capture in true orientation (NOT mirrored). The live preview is mirrored
  // for a natural selfie feel, but the saved photo should read correctly.
  cx.drawImage(v, 0, 0, w, h);
  return c.toDataURL("image/jpeg", 0.92);
}
function loadImg(src) { return new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; }); }
function drawImgCover(ctx, img, x, y, w, h, mirror) {
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  if (!img || !img.naturalWidth) { ctx.fillStyle = "#2c1f38"; ctx.fillRect(x, y, w, h); ctx.restore(); return; }
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  const vw = img.naturalWidth, vh = img.naturalHeight;
  const scale = Math.max(w / vw, h / vh);
  const dw = vw * scale, dh = vh * scale;
  const dx = x + (w - dw) / 2, dy = y + (h - dh) / 2;
  if (mirror) { ctx.translate(2 * (x + w / 2), 0); ctx.scale(-1, 1); } // match the mirrored selfie preview
  ctx.drawImage(img, dx, dy, dw, dh);
  ctx.restore();
}
// Stitch HD frames into the final framed photo / strip — laid out EXACTLY like
// the preview: a 4:3 cell, and in "Us" mode two tall (2:3) halves with my cam
// (mirrored, like my preview) on the left and my partner (un-mirrored) right.
async function pbStitch(myShots, partnerShots, p) {
  const useUs = !!partnerShots;
  const shots = p.shots;
  const cellH = 960, cellW = Math.round(cellH * 4 / 3); // 4:3, same as the preview stage
  const halfW = Math.round(cellW / 2);
  const pad = Math.round(cellW * 0.035), gap = Math.round(cellH * 0.05), footer = Math.round(cellH * 0.17);
  const W = cellW + pad * 2, H = pad * 2 + shots * cellH + (shots - 1) * gap + footer;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  // A paper mount, like a real booth strip — this is the thing people keep.
  const bg = ctx.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, "#FAF6ED"); bg.addColorStop(1, "#EDE4D3");
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  for (let s = 0; s < shots; s++) {
    const y = pad + s * (cellH + gap);
    ctx.save(); roundRect(ctx, pad, y, cellW, cellH, 22); ctx.clip();
    ctx.fillStyle = "#141019"; ctx.fillRect(pad, y, cellW, cellH);
    if (useUs) {
      drawImgCover(ctx, await loadImg(myShots[s]), pad, y, halfW, cellH, true);          // me — mirrored, left
      drawImgCover(ctx, await loadImg(partnerShots[s]), pad + halfW, y, cellW - halfW, cellH, false); // partner — right
    } else {
      drawImgCover(ctx, await loadImg(myShots[s]), pad, y, cellW, cellH, true);           // just me — mirrored
    }
    ctx.restore();
    if (p.sticker) {
      ctx.fillStyle = "#fff"; ctx.font = Math.round(cellH * 0.1) + "px serif";
      ctx.textBaseline = "top"; ctx.textAlign = "left"; ctx.fillText(p.sticker, pad + 16, y + 14);
      ctx.textBaseline = "bottom"; ctx.textAlign = "right"; ctx.fillText(p.sticker, pad + cellW - 16, y + cellH - 14);
      ctx.textBaseline = "alphabetic";
    }
  }
  ctx.textAlign = "center";
  const capY = H - footer * 0.5;
  ctx.fillStyle = "#33271E";
  ctx.font = Math.round(footer * 0.4) + 'px Superclarendon, Rockwell, Georgia, serif';
  ctx.fillText(p.caption, W / 2, capY);
  const dateStr = new Date().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }).toUpperCase();
  ctx.fillStyle = "#9A8A76";
  ctx.font = "600 " + Math.round(footer * 0.18) + 'px "SF Mono", ui-monospace, Menlo, monospace';
  const track = Math.round(footer * 0.05);
  ctx.save();
  ctx.translate(W / 2, H - footer * 0.16);
  // Canvas has no letter-spacing, so track the date by hand — it's the one bit
  // of type here that has to read as a caption rather than a sentence.
  const chars = [...dateStr];
  const widths = chars.map((ch) => ctx.measureText(ch).width + track);
  let x = -(widths.reduce((a, b) => a + b, 0) - track) / 2;
  ctx.textAlign = "left";
  chars.forEach((ch, i) => { ctx.fillText(ch, x, 0); x += widths[i]; });
  ctx.restore();
  return c.toDataURL("image/jpeg", 0.92);
}
function pbFinish(dataUrl) {
  pbResult = dataUrl;
  showImageResult(dataUrl);
  addToGallery("img", dataUrl);
  $("pb-capture").disabled = false;
  $("pb-sync").textContent = "";
  pbBusy = false; pbSession = null;
  clearTimeout(pbStitchTimer);
  spawnPanelHearts(pbSticker === "🔥" ? "fire" : "heart", 14);
  pbSyncStatus();
}
async function pbMaybeStitch() {
  if (!pbSession || pbSession.done || !pbSession.myShots || !pbSession.partnerShots) return;
  pbSession.done = true;
  // Each side builds its own photo to match its own preview: me on the left
  // (mirrored), partner on the right (un-mirrored).
  pbFinish(await pbStitch(pbSession.myShots, pbSession.partnerShots, pbSession));
}
async function pbRunPhoto() {
  if (pbBusy) return;
  pbBusy = true;
  $("pb-capture").disabled = true;
  const shots = pbMode === "strip" ? 3 : 1;
  const useUs = pbLayout === "us" && $("remote-video").srcObject;
  const filterKey = pbFilter;
  const caption = ($("pb-caption").value.trim()) || `${S.settings.me} 💕 ${S.settings.partner}`;
  const myShots = [];
  for (let s = 0; s < shots; s++) {
    await pbCountdown(s === 0 ? pbTimer : Math.min(3, pbTimer));
    myShots.push(pbGrabLocal(filterKey));
    pbFlash();
    await pbWait(450);
  }
  if (!useUs) {
    pbFinish(await pbStitch(myShots, null, { shots, sticker: pbSticker, caption }));
    return;
  }
  // "Us": exchange HD frames so both panels stitch the same crisp photo.
  pbSession = { shots, sticker: pbSticker, caption, myShots, partnerShots: pbIncomingShots, done: false };
  pbIncomingShots = null;
  netSend({ t: "pb-photo", shots: myShots, total: shots, sticker: pbSticker, caption });
  $("pb-sync").textContent = `Putting the two halves together with ${S.settings.partner}…`;
  pbMaybeStitch();
  clearTimeout(pbStitchTimer);
  pbStitchTimer = setTimeout(async () => {
    if (pbSession && !pbSession.done) { pbSession.done = true; pbFinish(await pbStitch(pbSession.myShots, null, pbSession)); }
  }, 12000);
}
// Partner's HD frames arrived (net.js `pb-photo` case).
export function pbApplyIncomingShots(shots) {
  if (Array.isArray(shots)) {
    if (pbSession && !pbSession.done) { pbSession.partnerShots = shots; pbMaybeStitch(); }
    else pbIncomingShots = shots; // arrived before our own capture finished
  }
}

function showImageResult(dataUrl) {
  pbResultType = "img";
  const img = $("pb-img");
  $("pb-img-wrap").classList.remove("hidden");
  $("pb-clip").classList.add("hidden");
  $("pb-draw-row").classList.remove("hidden");
  img.onload = () => {
    const dc = $("pb-draw");
    dc.width = img.naturalWidth; dc.height = img.naturalHeight;
    pbDrawCtx = dc.getContext("2d");
  };
  img.src = dataUrl;
  $("pb-live").classList.add("hidden");
  $("pb-result").classList.remove("hidden");
}

// Boomerang / short looping clip via MediaRecorder on a filtered canvas.
async function pbRunClip() {
  if (!window.MediaRecorder) { addSys("This browser can't record clips. Try a strip instead."); return; }
  pbBusy = true; $("pb-capture").disabled = true;
  const lv = $("local-video"), rv = $("remote-video");
  const useUs = pbLayout === "us" && rv.srcObject;
  const filter = PB_FILTERS[pbFilter] || "none";
  const W = 320, H = 240;
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const cx = cv.getContext("2d");
  await pbCountdown(pbTimer);
  const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) || "video/webm";
  const stream = cv.captureStream(15);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 1200000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const done = new Promise((res) => { rec.onstop = res; });
  rec.start();
  pbFlash();
  const start = performance.now(), dur = 2200; let raf;
  const draw = () => {
    cx.fillStyle = "#1d1424"; cx.fillRect(0, 0, W, H);
    if (useUs) { drawCover(cx, lv, 0, 0, W / 2, H, true, filter); drawCover(cx, rv, W / 2, 0, W / 2, H, false, filter); }
    else drawCover(cx, lv, 0, 0, W, H, true, filter);
    if (pbSticker) { cx.filter = "none"; cx.font = "22px serif"; cx.textAlign = "left"; cx.fillText(pbSticker, 6, 26); cx.textAlign = "right"; cx.fillText(pbSticker, W - 6, H - 10); }
    if (performance.now() - start < dur) raf = requestAnimationFrame(draw);
    else rec.stop();
  };
  draw();
  await done;
  if (raf) cancelAnimationFrame(raf);
  const url = await blobToDataURL(new Blob(chunks, { type: mime }));
  showClipResult(url);
  addToGallery("clip", url);
  pbBusy = false; $("pb-capture").disabled = false;
  spawnPanelHearts("heart", 14);
}

function showClipResult(url) {
  pbResultType = "clip"; pbClip = url;
  $("pb-clip").src = url;
  $("pb-clip").classList.remove("hidden");
  $("pb-img-wrap").classList.add("hidden");
  $("pb-draw-row").classList.add("hidden");
  $("pb-live").classList.add("hidden");
  $("pb-result").classList.remove("hidden");
}
function pbComposite() {
  const img = $("pb-img");
  if (!img.naturalWidth) return pbResult;
  const base = document.createElement("canvas");
  base.width = img.naturalWidth; base.height = img.naturalHeight;
  const bx = base.getContext("2d");
  bx.drawImage(img, 0, 0);
  const dc = $("pb-draw");
  if (dc.width) bx.drawImage(dc, 0, 0, base.width, base.height);
  return base.toDataURL("image/jpeg", 0.85);
}
export function pbSend() {
  if (pbResultType === "clip") {
    if (!pbClip) return;
    addMsg({ mine: true, clip: pbClip });
    netSend({ t: "clip", clip: pbClip });
  } else {
    const out = pbComposite();
    addMsg({ mine: true, gif: out });
    netSend({ t: "snap", img: out });
  }
  addSys("Photo sent.");
  closePhotobooth();
}
export function pbSave() {
  if (pbResultType === "clip") { addSys("Already in your gallery, under Keep."); return; }
  addPhotoToScrapbook(pbComposite());
  addSys("Kept in your scrapbook.");
}
export function pbDownload() {
  const a = document.createElement("a");
  if (pbResultType === "clip") { if (!pbClip) return; a.href = pbClip; a.download = "watchtogether-clip.webm"; }
  else { a.href = pbComposite(); a.download = "watchtogether-photobooth.jpg"; }
  a.click();
}
export function pbRetake() {
  pbClearDraw();
  $("pb-result").classList.add("hidden");
  $("pb-live").classList.remove("hidden");
}
function addPhotoToScrapbook(img) {
  S.scrapbook.unshift({ img, date: todayStr() });
  S.scrapbook = S.scrapbook.slice(0, 100);
  chrome.storage.local.set({ wt_scrapbook: S.scrapbook });
  renderScrapbook();
}

// Doodle on the captured photo
export function pbDrawInit() {
  const c = $("pb-draw"); if (!c) return;
  let drawing = false, lx = 0, ly = 0;
  const pos = (e) => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) * c.width / r.width, (e.clientY - r.top) * c.height / r.height]; };
  c.addEventListener("pointerdown", (e) => { if (!pbDrawCtx) return; drawing = true; [lx, ly] = pos(e); e.preventDefault(); });
  c.addEventListener("pointermove", (e) => {
    if (!drawing || !pbDrawCtx) return;
    const [x, y] = pos(e);
    pbDrawCtx.strokeStyle = $("pb-draw-color").value;
    pbDrawCtx.lineWidth = Math.max(3, c.width / 90); pbDrawCtx.lineCap = "round"; pbDrawCtx.lineJoin = "round";
    pbDrawCtx.beginPath(); pbDrawCtx.moveTo(lx, ly); pbDrawCtx.lineTo(x, y); pbDrawCtx.stroke();
    [lx, ly] = [x, y];
  });
  window.addEventListener("pointerup", () => { drawing = false; });
}
export function pbClearDraw() { if (pbDrawCtx) pbDrawCtx.clearRect(0, 0, $("pb-draw").width, $("pb-draw").height); }

// ---- Shared photobooth gallery ------------------------------------------
export function addToGallery(type, data) {
  if (!data) return;
  gallery.unshift({ type, data, date: todayStr() });
  gallery = gallery.slice(0, 60);
  chrome.storage.local.set({ wt_gallery: gallery });
  renderGallery();
}
export function renderGallery() {
  const grid = $("gallery-grid"); if (!grid) return;
  grid.innerHTML = "";
  if (!gallery.length) { grid.innerHTML = '<div class="copy gallery-empty">Empty for now. Open the photobooth to start it off.</div>'; return; }
  gallery.forEach((g) => {
    let el;
    if (g.type === "clip") { el = document.createElement("video"); el.src = g.data; el.muted = true; el.loop = true; el.autoplay = true; el.playsInline = true; }
    else { el = document.createElement("img"); el.src = g.data; el.alt = "photo"; }
    el.title = "Tap to send again";
    el.addEventListener("click", () => resendGalleryItem(g));
    grid.appendChild(el);
  });
}
function resendGalleryItem(g) {
  if (g.type === "clip") { addMsg({ mine: true, clip: g.data }); netSend({ t: "clip", clip: g.data }); }
  else { addMsg({ mine: true, gif: g.data }); netSend({ t: "snap", img: g.data }); }
  addSys("Sent again from your gallery.");
  burst("heart");
}
export function clearGallery() { gallery = []; chrome.storage.local.set({ wt_gallery: gallery }); renderGallery(); }
export function loadGallery(arr) { gallery = Array.isArray(arr) ? arr : []; renderGallery(); }

// ---- Remote-driven entry points (net.js pb-* handlers) ------------------
export function receivePbOpen() {
  if ($("pb-overlay").classList.contains("hidden")) { addSys(`${S.settings.partner} opened the photobooth.`); openPhotobooth(true); }
}
export function receivePbGo(d) {
  (async () => {
    if ($("pb-overlay").classList.contains("hidden")) await openPhotobooth(true);
    applyPbSettings(d);
    pbRun();
  })();
}
