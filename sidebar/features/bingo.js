// WatchTogether — movie bingo. A shared 4×4 card of movie tropes: tap a cell when
// one happens, marks sync to both sides, first completed line = BINGO. The person
// who taps "New card" generates it and sends it so you both play the same board.
//
// Exports: newBingo, setBingoCard, toggleCell, applyCell, renderBingo.

import { $ } from "../core/dom.js";
import { netSend } from "../core/net.js";
import { addSys } from "./chat.js";
import { burst } from "./reactions.js";

const TROPES = [
  "Jump scare", "Kiss in the rain", "Villain monologue", "Says the title",
  "Slow clap", "Dramatic rain", "Trips while running", "Big explosion",
  '"We need to talk"', "Last-second rescue", "Fake-out death", "Training montage",
  "Awkward dinner", "Phone dies", "Car won't start", "Meaningful stare",
  "Record scratch", "Breakup → makeup", "The dog survives", "Plot twist",
  "Flashback", "Voiceover", "City skyline", "Someone cries",
];

let card = [], marks = [], wasWon = false;

function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export function newBingo() {
  card = shuffle(TROPES).slice(0, 16);
  marks = new Array(16).fill(false); wasWon = false;
  netSend({ t: "bingo", reset: card });
  renderBingo();
}
export function setBingoCard(c) {
  if (Array.isArray(c) && c.length === 16) { card = c.slice(); marks = new Array(16).fill(false); wasWon = false; renderBingo(); }
}
export function toggleCell(i) {
  if (!card.length) return;
  marks[i] = !marks[i];
  netSend({ t: "bingo", cell: i });
  renderBingo(); checkBingo();
}
export function applyCell(i) {
  if (!card.length || typeof i !== "number") return;
  marks[i] = !marks[i];
  renderBingo(); checkBingo();
}
function checkBingo() {
  const L = [[0,1,2,3],[4,5,6,7],[8,9,10,11],[12,13,14,15],[0,4,8,12],[1,5,9,13],[2,6,10,14],[3,7,11,15],[0,5,10,15],[3,6,9,12]];
  const won = L.some((l) => l.every((i) => marks[i]));
  if (won && !wasWon) { burst("wow"); addSys("🎉 BINGO! 🎉"); }
  wasWon = won;
}
export function renderBingo() {
  const g = $("bingo-grid"); if (!g) return;
  if (!card.length) { g.innerHTML = '<div class="muted small">Tap "New card" to start 🎬</div>'; return; }
  g.innerHTML = "";
  card.forEach((t, i) => {
    const c = document.createElement("button");
    c.className = "bingo-cell" + (marks[i] ? " on" : "");
    c.textContent = t;
    c.addEventListener("click", () => toggleCell(i));
    g.appendChild(c);
  });
}
