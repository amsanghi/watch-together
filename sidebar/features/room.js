// WatchTogether — "our couch": a tiny shared 2D scene. You each drag your own
// avatar along the sofa (positions sync), pull a shared blanket over, and reach into
// one popcorn bowl — reach at the same moment and your hands touch. Scoot your
// avatars together and hearts spawn.
//
// Exports: initRoom, renderRoom, receiveRoom.

import { $ } from "../core/dom.js";
import { netSend } from "../core/net.js";
import { addSys } from "./chat.js";
import { burst } from "./reactions.js";

let myX = 0.38, theirX = 0.62, blanketOn = false;
let myReachAt = 0, theirReachAt = 0, lastCuddle = 0;

export function renderRoom() {
  const me = $("room-me"), them = $("room-them");
  if (me) me.style.left = myX * 100 + "%";
  if (them) them.style.left = theirX * 100 + "%";
  const bl = $("room-blanket"); if (bl) bl.classList.toggle("on", blanketOn);
}
function reachFx(id) { const el = $(id); if (el) { el.classList.add("reach"); setTimeout(() => el.classList.remove("reach"), 450); } }
function checkCuddle() {
  const now = Date.now();
  if (Math.abs(myX - theirX) < 0.13 && now - lastCuddle > 4000) { lastCuddle = now; burst("heart"); }
  if (myReachAt && theirReachAt && Math.abs(myReachAt - theirReachAt) < 1200) {
    myReachAt = theirReachAt = 0; burst("heart"); addSys("🤝 Your hands touched over the popcorn 🍿💞");
  }
}
export function initRoom() {
  const me = $("room-me"), stage = $("room-stage"); if (!me || !stage) return;
  let dragging = false;
  me.addEventListener("pointerdown", (e) => { dragging = true; try { me.setPointerCapture(e.pointerId); } catch (_) {} e.preventDefault(); });
  me.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const r = stage.getBoundingClientRect();
    myX = Math.max(0.06, Math.min(0.94, (e.clientX - r.left) / r.width));
    renderRoom(); netSend({ t: "room", kind: "pos", x: myX }); checkCuddle();
  });
  me.addEventListener("pointerup", () => { dragging = false; });
  const bb = $("room-blanket-btn"); if (bb) bb.addEventListener("click", () => { blanketOn = !blanketOn; renderRoom(); netSend({ t: "room", kind: "blanket", on: blanketOn }); });
  const bowl = $("room-bowl"); if (bowl) bowl.addEventListener("click", () => { myReachAt = Date.now(); reachFx("room-me"); netSend({ t: "room", kind: "reach" }); checkCuddle(); });
  renderRoom();
}
export function receiveRoom(d) {
  if (d.kind === "pos" && typeof d.x === "number") { theirX = d.x; renderRoom(); checkCuddle(); }
  else if (d.kind === "blanket") { blanketOn = !!d.on; renderRoom(); }
  else if (d.kind === "reach") { theirReachAt = Date.now(); reachFx("room-them"); checkCuddle(); }
}
