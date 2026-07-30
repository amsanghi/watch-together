// WatchTogether — the two-player games in the Fun panel: tic-tac-toe, Connect 4,
// rock-paper-scissors, shared doodle canvas, and guess-the-emoji (movie + spicy
// decks). Each side's role/first-move is derived from S.amInitiator so the two
// panels stay consistent without a server. Board state is feature-local.
//
// Exports (net.js handlers + main.js wiring): tttBuild, tttReset, tttApply,
//   doodleInit, doodleClear, doodleRemote, rpsPick, rpsReset, receiveRps,
//   c4Build, c4Reset, c4Apply, setEmojiPuzzle, emojiNew, renderEmojiGuess,
//   emojiSendGuess, emojiReveal.

import { $ } from "../core/dom.js";
import { S } from "../core/state.js";
import { netSend } from "../core/net.js";

// ---- Tic-tac-toe (each side owns one mark; you can only play your own turns) ---
let tttBoard, tttTurn, tttMyMark = "X";
function myMark() { return S.amInitiator ? "X" : "O"; } // initiator is X and moves first
export function tttBuild() {
  const b = $("ttt-board"); b.innerHTML = "";
  for (let i = 0; i < 9; i++) {
    const c = document.createElement("div"); c.className = "cell"; c.dataset.i = i;
    c.addEventListener("click", () => tttClick(i));
    b.appendChild(c);
  }
}
function tttStatus() {
  tttMyMark = myMark();
  const w = tttWinner();
  if (w) { $("ttt-status").textContent = w === "draw" ? "A draw." : `${w === tttMyMark ? "You" : S.settings.partner} win${w === tttMyMark ? "" : "s"}.`; return; }
  $("ttt-status").textContent = tttTurn === tttMyMark ? `Your turn (${tttMyMark})` : `${S.settings.partner}'s turn`;
}
export function tttReset(broadcast) {
  tttBoard = Array(9).fill("");
  tttTurn = "X";
  tttMyMark = myMark();
  document.querySelectorAll("#ttt-board .cell").forEach((c) => { c.textContent = ""; c.className = "cell"; });
  tttStatus();
  if (broadcast) netSend({ t: "ttt", reset: true });
}
function tttClick(i) {
  if (!tttBoard) tttReset(false);
  if (tttBoard[i] || tttWinner()) return;
  tttMyMark = myMark();
  if (tttTurn !== tttMyMark) { $("ttt-status").textContent = `Wait for ${S.settings.partner} ⏳`; return; }
  tttApply(i, tttMyMark);
  netSend({ t: "ttt", cell: i, mark: tttMyMark });
}
export function tttApply(i, mark) {
  if (!tttBoard) tttReset(false);
  if (tttBoard[i]) return;
  tttBoard[i] = mark;
  const cell = document.querySelector(`#ttt-board .cell[data-i="${i}"]`);
  // Colour by whose mark it is on THIS panel, not by X/O — the amber/their-colour
  // split has to mean the same thing everywhere.
  if (cell) { cell.textContent = mark === "X" ? "✕" : "◯"; cell.classList.add(mark === myMark() ? "mine" : "theirs"); }
  tttTurn = mark === "X" ? "O" : "X";
  tttStatus();
}
function tttWinner() {
  const L = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  for (const [a,b,c] of L) if (tttBoard[a] && tttBoard[a] === tttBoard[b] && tttBoard[a] === tttBoard[c]) return tttBoard[a];
  return tttBoard.every(Boolean) ? "draw" : null;
}

// ---- Doodle together ----------------------------------------------------
let dctx, drawing = false, lastX = 0, lastY = 0;
export function doodleInit() {
  const c = $("doodle"); if (!c) return;
  dctx = c.getContext("2d");
  const pos = (e) => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) * c.width / r.width, (e.clientY - r.top) * c.height / r.height]; };
  c.addEventListener("pointerdown", (e) => { drawing = true; [lastX, lastY] = pos(e); });
  c.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const [x, y] = pos(e);
    const color = $("doodle-color").value;
    doodleLine(lastX, lastY, x, y, color);
    netSend({ t: "doodle", x0: lastX, y0: lastY, x1: x, y1: y, color });
    [lastX, lastY] = [x, y];
  });
  window.addEventListener("pointerup", () => { drawing = false; });
}
function doodleLine(x0, y0, x1, y1, color) {
  if (!dctx) return;
  dctx.strokeStyle = color; dctx.lineWidth = 3; dctx.lineCap = "round";
  dctx.beginPath(); dctx.moveTo(x0, y0); dctx.lineTo(x1, y1); dctx.stroke();
}
export function doodleRemote(d) { doodleLine(d.x0, d.y0, d.x1, d.y1, d.color); }
export function doodleClear(broadcast) {
  if (dctx) dctx.clearRect(0, 0, $("doodle").width, $("doodle").height);
  if (broadcast) netSend({ t: "doodle", clear: true });
}

// ---- Rock paper scissors ------------------------------------------------
let rpsMy = null, rpsPartner = null;
const RPS_E = { rock: "🪨", paper: "📄", scissors: "✂️" };
export function rpsPick(p) {
  rpsMy = p;
  document.querySelectorAll(".rps-opt").forEach((b) => b.classList.toggle("sel", b.dataset.rps === p));
  netSend({ t: "rps", pick: p });
  rpsEval();
}
function rpsEval() {
  if (rpsMy && rpsPartner) {
    const beats = { rock: "scissors", paper: "rock", scissors: "paper" };
    const res = rpsMy === rpsPartner ? "it's a tie 🤝" : beats[rpsMy] === rpsPartner ? "you win! 🎉" : `${S.settings.partner} wins 😘`;
    $("rps-status").textContent = `${RPS_E[rpsMy]} vs ${RPS_E[rpsPartner]} — ${res}`;
  } else if (rpsMy) {
    $("rps-status").textContent = `Locked in ${RPS_E[rpsMy]} — waiting for ${S.settings.partner}…`;
  }
}
export function rpsReset(broadcast) {
  rpsMy = null; rpsPartner = null;
  document.querySelectorAll(".rps-opt").forEach((b) => b.classList.remove("sel"));
  $("rps-status").textContent = "Pick one — revealed when you both have.";
  if (broadcast) netSend({ t: "rps", reset: true });
}
// Partner made their pick / reset (net.js `rps` case).
export function receiveRps(d) {
  if (d.reset) rpsReset(false);
  else { rpsPartner = d.pick; rpsEval(); }
}

// ---- Connect 4 (7 cols x 6 rows; each side owns a color, turn-based) -----
let c4Board, c4Turn;
function c4Color() { return S.amInitiator ? "r" : "y"; } // initiator is red and moves first
export function c4Build() {
  const b = $("c4-board"); b.innerHTML = "";
  for (let i = 0; i < 42; i++) {
    const c = document.createElement("div"); c.className = "c4-cell"; c.dataset.i = i;
    c.addEventListener("click", () => c4Click(i % 7));
    b.appendChild(c);
  }
}
function c4Status() {
  const mine = c4Color();
  const w = c4Winner();
  if (w) { $("c4-status").textContent = w === "draw" ? "Draw 🤝" : `${w === mine ? "You" : S.settings.partner} win${w === mine ? "" : "s"}! 🎉`; return; }
  $("c4-status").textContent = c4Turn === mine ? "Your turn" : `${S.settings.partner}'s turn`;
}
export function c4Reset(broadcast) {
  c4Board = Array(42).fill(""); c4Turn = "r";
  document.querySelectorAll("#c4-board .c4-cell").forEach((c) => { c.className = "c4-cell"; });
  c4Status();
  if (broadcast) netSend({ t: "c4", reset: true });
}
function c4DropRow(col) { for (let row = 5; row >= 0; row--) if (!c4Board[row * 7 + col]) return row; return -1; }
function c4Click(col) {
  if (!c4Board) c4Reset(false);
  if (c4Winner()) return;
  const mine = c4Color();
  if (c4Turn !== mine) { $("c4-status").textContent = `Wait for ${S.settings.partner} ⏳`; return; }
  if (c4DropRow(col) < 0) return;
  c4Apply(col, mine);
  netSend({ t: "c4", col, color: mine });
}
export function c4Apply(col, color) {
  if (!c4Board) c4Reset(false);
  const row = c4DropRow(col); if (row < 0) return;
  const idx = row * 7 + col; c4Board[idx] = color;
  const cell = document.querySelector(`#c4-board .c4-cell[data-i="${idx}"]`);
  if (cell) cell.classList.add(color === c4Color() ? "mine" : "theirs");
  c4Turn = color === "r" ? "y" : "r";
  c4Status();
}
function c4Winner() {
  if (!c4Board) return null;
  const at = (r, c) => (r < 0 || r > 5 || c < 0 || c > 6) ? "" : c4Board[r * 7 + c];
  for (let r = 0; r < 6; r++) for (let c = 0; c < 7; c++) {
    const v = at(r, c); if (!v) continue;
    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]])
      if (at(r + dr, c + dc) === v && at(r + 2 * dr, c + 2 * dc) === v && at(r + 3 * dr, c + 3 * dc) === v) return v;
  }
  return c4Board.every(Boolean) ? "draw" : null;
}

// ---- Guess the emoji (multiple decks, incl. explicit ones) --------------
const EMOJI_DECKS = {
  movie: [
    { e: "🦁👑", a: "The Lion King" }, { e: "🚢🧊💔", a: "Titanic" }, { e: "👻🚫", a: "Ghostbusters" },
    { e: "🧙‍♂️💍🌋", a: "The Lord of the Rings" }, { e: "🤡🎈🚸", a: "It" }, { e: "🦖🏝️", a: "Jurassic Park" },
    { e: "🔍🐠", a: "Finding Nemo" }, { e: "❄️👭👸", a: "Frozen" }, { e: "🕷️🧑", a: "Spider-Man" },
    { e: "💊🔴🔵🕶️", a: "The Matrix" }, { e: "🚗⚡🏁", a: "Cars" }, { e: "🤖❤️🌱", a: "WALL-E" },
    { e: "🎈🏠👴", a: "Up" }, { e: "🦇🃏", a: "The Dark Knight" }, { e: "👽📞🏠🌕", a: "E.T." },
    { e: "🐀👨‍🍳🍝", a: "Ratatouille" }, { e: "👧🐉🏯", a: "Spirited Away" }, { e: "🐠🔍👨‍👦", a: "Finding Nemo" },
    { e: "🧸🤠🚀", a: "Toy Story" }, { e: "🦈🌊🩸", a: "Jaws" },
  ],
  spicy: [
    { e: "👅🍆", a: "Blowjob" }, { e: "👅🌮", a: "Eating out / oral" }, { e: "👅🍑", a: "Rimming" },
    { e: "✊🍆💦", a: "Handjob" }, { e: "🍆🍑", a: "Anal" }, { e: "6️⃣9️⃣", a: "Sixty-nine" },
    { e: "🍆👄💦", a: "Deepthroat" }, { e: "💦😮", a: "Facial" }, { e: "⛓️🙇", a: "Bondage" },
    { e: "✋🍑👏", a: "Spanking" }, { e: "🔥💬", a: "Dirty talk" }, { e: "📱🍆💦", a: "Sexting" },
    { e: "🎥🛏️", a: "Sex tape" }, { e: "👀🪟", a: "Voyeurism" }, { e: "3️⃣🛏️", a: "Threesome" },
    { e: "🧊🛏️", a: "Ice play" }, { e: "🕯️🔥💧", a: "Wax play" }, { e: "👠🦶👅", a: "Foot fetish" },
    { e: "🪶😏", a: "Teasing" }, { e: "🙈⛓️", a: "Blindfold & restraints" }, { e: "💍🔓💞", a: "Open relationship" },
    { e: "🐆🛏️🔥", a: "Rough sex" }, { e: "🚿💦🛁", a: "Shower sex" }, { e: "🚗🌙🔥", a: "Car sex" },
    { e: "🎭👫", a: "Role play" }, { e: "👑🙇‍♂️", a: "Dom / sub" }, { e: "🤏🍒🤏", a: "Nipple play" },
    { e: "😈🔒🔑", a: "Chastity / control" }, { e: "🥵💦😮‍💨", a: "Orgasm" }, { e: "💋⬇️⬇️⬇️", a: "Kissing down the body" },
    { e: "🛌🌅🍆", a: "Morning sex" }, { e: "👅🔋", a: "Edging" },
  ],
  position: [
    { e: "🐶💨", a: "Doggy style" }, { e: "🤠🐎", a: "Cowgirl" }, { e: "🤠↩️", a: "Reverse cowgirl" },
    { e: "🥄👤👤", a: "Spooning" }, { e: "😇🛏️", a: "Missionary" }, { e: "6️⃣9️⃣", a: "Sixty-nine" },
    { e: "🪑🍆", a: "Lap sit" }, { e: "🧎‍♀️🧎", a: "Kneeling" }, { e: "🙆‍♀️⬆️🦵", a: "Legs up" },
    { e: "🌉", a: "The bridge" }, { e: "🧍🧍🔥", a: "Standing" }, { e: "🐍🤸", a: "The pretzel" },
    { e: "🚪🧍🍑", a: "Against the wall" }, { e: "🛋️🍑⬆️", a: "Bent over" }, { e: "🌮👇🪑", a: "Face-sitting" },
    { e: "🦋🛏️", a: "The butterfly" }, { e: "🦵✂️🦵", a: "Scissoring" },
  ],
  phrase: [
    { e: "🛏️🌙🔥", a: "Sex tonight" }, { e: "👅⬇️⬇️", a: "Go down on me" }, { e: "🍑👏👏", a: "Spank me" },
    { e: "🙏🍆", a: "Beg for it" }, { e: "💦🛏️", a: "Make a mess" }, { e: "🔒💋", a: "Locked-door quickie" },
    { e: "📞🍆💦", a: "Phone sex" }, { e: "👀📹🔥", a: "Watch me" }, { e: "⛓️🛏️😈", a: "Tie me up" },
    { e: "🍑📸", a: "Send nudes" }, { e: "🥵👅", a: "Turn me on" }, { e: "🔝🍆", a: "Get on top" },
    { e: "👅🍑👅", a: "Eat me out" }, { e: "🤲🍒", a: "Touch me" }, { e: "💋🔁🌙", a: "All night long" },
    { e: "😈🗣️👂", a: "Talk dirty to me" }, { e: "🙇‍♀️🍆💦", a: "On your knees" }, { e: "🛏️🆓❓", a: "You free tonight?" },
  ],
  sext: [
    { e: "🍆➡️🍑", a: "I want you inside me" }, { e: "😩💭🫵🔁", a: "I can't stop thinking about you" },
    { e: "🙏🛏️🌙", a: "Come to bed" }, { e: "👅👉🫵", a: "I want to taste you" },
    { e: "🥵🫵🔥", a: "You make me so hot" }, { e: "📸🍑🙏", a: "Send me a pic" },
    { e: "🤲🫵🔛🙋", a: "I need your hands on me" }, { e: "💦👀🫵", a: "Look what you do to me" },
    { e: "⏳🚫🙅", a: "I can't wait any longer" }, { e: "🛌🫵🔜", a: "Get over here" },
    { e: "👀👅🫵", a: "I want to watch you" }, { e: "🔥💬👂", a: "Talk dirty to me" },
    { e: "🙈⛓️🙏", a: "Tie me up" }, { e: "💋🔝➡️⬇️", a: "Kiss me everywhere" },
    { e: "🫵🔛🙏", a: "I want you on top" }, { e: "🌙🆓🛏️❓", a: "Are you free tonight?" },
  ],
};
const EMOJI_DECK_LABELS = { movie: "🎬 Movie", spicy: "🔥 Sexy act", position: "🛏️ Position", phrase: "🗯️ Dirty phrase", sext: "💌 Sext" };
let emojiDeck = "movie", emojiIdx = -1;
export function setEmojiPuzzle(deck, i, broadcast) {
  if (!EMOJI_DECKS[deck]) deck = "movie";
  emojiDeck = deck; emojiIdx = i;
  $("emoji-puzzle").textContent = EMOJI_DECKS[deck][i].e;
  $("emoji-answer").textContent = ""; $("emoji-answer").classList.add("hidden");
  $("emoji-guesses").innerHTML = ""; $("emoji-guess").value = "";
  if (broadcast) netSend({ t: "emoji-q", deck, i });
}
export function emojiNew(deck) {
  if (deck === "random" || !deck) { const ks = Object.keys(EMOJI_DECKS); deck = ks[Math.floor(Math.random() * ks.length)]; }
  setEmojiPuzzle(deck, Math.floor(Math.random() * EMOJI_DECKS[deck].length), true);
}
export function renderEmojiGuess(who, text) {
  const el = document.createElement("div");
  el.className = "ans" + (who === S.settings.me ? " mine" : "");
  el.innerHTML = "<b></b><span></span>";
  el.querySelector("b").textContent = who; el.querySelector("span").textContent = text;
  $("emoji-guesses").appendChild(el);
}
export function emojiSendGuess() {
  if (emojiIdx < 0) emojiNew("random");
  const t = $("emoji-guess").value.trim(); if (!t) return;
  renderEmojiGuess(S.settings.me, t);
  netSend({ t: "emoji-a", text: t });
  $("emoji-guess").value = "";
}
export function emojiReveal(broadcast) {
  if (emojiIdx < 0) return;
  const el = $("emoji-answer");
  el.textContent = (EMOJI_DECK_LABELS[emojiDeck] || "🎬") + ": " + EMOJI_DECKS[emojiDeck][emojiIdx].a;
  el.classList.remove("hidden");
  if (broadcast) netSend({ t: "emoji-r" });
}
