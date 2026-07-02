// WatchTogether — text prompts you send each other: Question of the Day, the
// "how well do you know me?" quiz, the compliment/love jar, and the spicy card
// decks (would-you-rather / truth / dare / never-have-I-ever / confess /
// fantasy / finish-it). Built for long distance — every card works over video,
// voice, photos or text. 🔞
//
// Exports: renderQotd, renderQotdAnswer, sendQotd, pullJar, setQuizQuestion,
//   newQuiz, renderQuizAnswer, sendQuiz, drawCard, cardLabel, showPartnerCard.

import { $ } from "../core/dom.js";
import { S } from "../core/state.js";
import { netSend } from "../core/net.js";
import { addSys } from "./chat.js";

// ---- Question of the day (deterministic by date, same for both) ---------
const QOTD = [
  "What's a tiny thing I do that you love?",
  "Where would you teleport us right now?",
  "What's your favorite memory of us?",
  "What song reminds you of me?",
  "What's something new you want us to try together?",
  "What made you smile today?",
  "If we had a free day tomorrow, how would we spend it?",
  "What's a dream you haven't told me yet?",
  "What's your comfort food and would you share it with me?",
  "What's the most attractive thing about me (besides looks)?",
  "What would our perfect lazy Sunday look like?",
  "What's a little adventure you want to go on with me?",
];
function todaysQuestion() {
  const epochDay = Math.floor((Date.now() + new Date().getTimezoneOffset() * -60000) / 86400000);
  return QOTD[epochDay % QOTD.length];
}
export function renderQotd() { $("qotd-q").textContent = todaysQuestion(); }
export function renderQotdAnswer(who, text) {
  const el = document.createElement("div");
  el.className = "ans";
  el.innerHTML = "<b></b> <span></span>";
  el.querySelector("b").textContent = who + ":";
  el.querySelector("span").textContent = text;
  $("qotd-answers").appendChild(el);
}
export function sendQotd() {
  const t = $("qotd-input").value.trim();
  if (!t) return;
  renderQotdAnswer(S.settings.me, t);
  netSend({ t: "qotd", text: t });
  $("qotd-input").value = "";
}

// ---- Love jar -----------------------------------------------------------
const JAR = [
  "You make ordinary days feel special. 💕",
  "I'd choose you again, every time.",
  "Your laugh is my favorite sound.",
  "Home is wherever you are. 🏡",
  "I'm so proud of you.",
  "You're my favorite hello and hardest goodbye.",
  "Thanks for being exactly you.",
  "I fall for you a little more every day.",
  "You + me = my favorite team. 🫶",
  "Even my boring moments are better with you.",
];
export function pullJar() {
  const note = JAR[Math.floor(Math.random() * JAR.length)];
  const el = $("jar-note");
  el.textContent = note;
  el.classList.remove("hidden");
}

// ---- How well do you know me? quiz --------------------------------------
const QUIZ_Q = [
  "What's my favorite food?",
  "What's my dream vacation spot?",
  "What song do I have on repeat?",
  "What's my biggest fear?",
  "What's my go-to comfort movie?",
  "What's my favorite way to relax?",
  "What's my coffee/tea order?",
  "What would my perfect date be?",
  "What's my favorite thing about you?",
  "What's a hidden talent of mine?",
  "What's my favorite season?",
  "What makes me laugh the hardest?",
];
export function setQuizQuestion(q, broadcast) {
  $("quiz-q").textContent = q ? "💘 " + q : "";
  $("quiz-answers").innerHTML = "";
  $("quiz-input").value = "";
  if (broadcast) netSend({ t: "quiz-q", q });
}
export function newQuiz() { setQuizQuestion(QUIZ_Q[Math.floor(Math.random() * QUIZ_Q.length)], true); }
export function renderQuizAnswer(who, text) {
  const el = document.createElement("div");
  el.className = "ans";
  el.innerHTML = "<b></b> <span></span>";
  el.querySelector("b").textContent = who + ":";
  el.querySelector("span").textContent = text;
  $("quiz-answers").appendChild(el);
}
export function sendQuiz() {
  const t = $("quiz-input").value.trim();
  if (!t) return;
  if (!$("quiz-q").textContent) newQuiz();
  renderQuizAnswer(S.settings.me, t);
  netSend({ t: "quiz-a", text: t });
  $("quiz-input").value = "";
}

// ---- Spicy card decks ---------------------------------------------------
const WYR = [
  "have me on top or be on top of me?",
  "a slow tease all night or be taken right now?",
  "feel my mouth or my hands on you first?",
  "be blindfolded or do the blindfolding?",
  "loud and rough or quiet and teasing?",
  "morning sex or middle-of-the-night sex?",
  "be tied up or tie me up?",
  "make out for an hour first or skip straight to it?",
  "shower together or soak in the bath together?",
  "have me whisper filth in your ear or stay silent and just feel it?",
  "wear something tiny for me or nothing at all?",
  "get a striptease or give me one?",
  "be in charge tonight or be told exactly what to do?",
  "have me kiss down your neck or kiss down mine?",
  "do it with the lights on or in the dark?",
  "be teased until you beg or tease me until I beg?",
  "a quickie somewhere risky or hours behind a locked door?",
  "have me bite you or scratch you?",
  "trade nudes all day or get edged over video all night?",
  "be pinned against the wall or pressed into the bed?",
  "bring a toy into it or just our hands?",
  "role-play strangers who just met or lovers reuniting after months?",
  "lace or bare skin?",
  "have me go slow and deep or fast and relentless?",
  "be woken up by my mouth or my hands?",
  "get a hickey somewhere hidden or somewhere you can't cover?",
  "once, intense and quick, or three times, slow all night?",
  "watch me touch myself or be watched while you touch yourself?",
  "have your hair pulled or your wrists held down?",
  "dirty talk over the phone or a no-words video call?",
  "be the dominant one tonight or the submissive one?",
  "a full-body massage that turns into more, or skip the wait?",
  "leave the curtains open or the door unlocked?",
  "be praised the whole time or teased and bossed around?",
  "have me describe every move before I make it or surprise you?",
];
const NHIE = [
  "touched myself thinking about you.",
  "gotten turned on in public because of you.",
  "saved a photo of you for... later.",
  "had a sex dream about you.",
  "wanted to sneak off somewhere risky with you.",
  "fantasized about something with you I've never said out loud.",
  "gotten off during a call with you.",
  "pictured you while alone in the shower.",
  "wanted you so badly I couldn't focus on anything else.",
  "imagined a roleplay or threesome scenario with you.",
  "worn something just hoping you'd take it off me.",
  "lied about being busy because my thoughts about you were filthy.",
  "wanted to get caught fooling around with you.",
  "replayed a hot memory of us to get through a boring day.",
  "sent a risky text and both regretted and loved it.",
  "wanted to try something I saw and instantly thought of us.",
  "gotten jealous and then weirdly turned on by it.",
  "wanted to skip a whole event just to stay in bed with you.",
  "moaned your name when you weren't there.",
  "edged myself waiting to be with you.",
];
const CONFESS = [
  "Confess the filthiest thought you've had about me this week.",
  "Admit the one thing you want me to do but are too shy to ask.",
  "Tell me the fantasy about us you replay the most.",
  "Confess every place you've imagined us doing it.",
  "Admit what you were really thinking last time you looked at me like that.",
  "Tell me the hottest dream you've ever had about us.",
  "Confess a kink you want to explore with me.",
  "Admit the last time you got off thinking about me — and exactly how.",
  "Tell me the dirtiest thing you wish you were brave enough to say out loud.",
  "Confess the part of me you can't stop thinking about.",
  "Admit one rule you'd love me to break with you.",
  "Tell me the naughtiest thing you've ever secretly wanted to try.",
  "Confess what you'd do to me right now if there were zero limits.",
  "Admit the most desperate you've ever been for me.",
  "Tell me a turn-on you've never confessed to anyone.",
  "Confess what you wear (or don't) just for me.",
  "Admit the wildest thing you've done while thinking of me.",
];
const FANTASY = [
  "We're alone in a hotel room with the whole night ahead. What happens first?",
  "I surprise you in the shower. Walk me through it.",
  "You're tied to the bed and I'm in charge. What do I do to you?",
  "We can't make a single sound or we'll get caught. How does it play out?",
  "You find me waiting in your favorite thing to peel off me. Then what?",
  "We're strangers who just locked eyes across a bar. Take it from there.",
  "I'm yours to command for one hour. What's your very first order?",
  "Lights off, blindfold on — describe everything you'd do to me.",
  "One night, a long list of firsts. Pick the three you want most.",
  "You're teasing me under the table at dinner. How far do you take it?",
  "I tell you not to touch yourself until I say so. How long do you last?",
  "We reunite after weeks apart and can't keep our hands off. Describe the first ten minutes.",
  "You get to direct me like your own private show. What do you have me do?",
  "We have the whole house to ourselves for 24 hours. What's the plan?",
];
const FINISH = [
  "Tonight I want you to ___.",
  "I can't stop thinking about your ___.",
  "If you were here right now, I'd ___.",
  "The first thing I'd take off you is ___.",
  "I love it most when you ___.",
  "I've always wanted to try ___ with you.",
  "You drive me wild when you ___.",
  "Right now I'm imagining ___.",
  "Next time I see you, be ready for ___.",
  "I want you to beg me for ___.",
  "My favorite place for your mouth is ___.",
  "I'd let you ___ anytime you wanted.",
  "The dirtiest thing I'd whisper to you is ___.",
  "I get weak whenever you ___.",
];
// Explicit, but built for long distance — everything works over video, voice,
// photos or text. Just the two of you. 🔞
const TRUTH = [
  "What's the dirtiest thought you've had about me today?",
  "Where exactly do you want my hands right now?",
  "What's the wildest place you'd want to have sex with me?",
  "Describe, step by step, what you'd do to me if I were in bed with you right now.",
  "What turns you on the fastest when we're together?",
  "What's a fantasy about me you've touched yourself to?",
  "Tell me the last time you got off thinking about me — and what you imagined.",
  "What's something you've always wanted me to do to you but never asked?",
  "Which part of my body do you crave the most?",
  "Rougher or slower — how do you want me tonight?",
  "What's the naughtiest photo of me you've saved, and what do you do with it?",
  "What do you want me to whisper in your ear while we're at it?",
  "What's a kink of yours I don't know about yet?",
  "Have you ever gotten off during a call with me? Tell me everything.",
  "Which outfit of mine makes you want to tear it off?",
  "Where do you most want my mouth?",
  "What's the loudest I've ever made you — and how?",
  "What's something you want to try in bed that we never have?",
  "Tell me exactly how you like to be touched when you're alone.",
  "What's the hottest thing I've ever done to you?",
  "If I could only use my hands or my mouth tonight, which do you choose?",
  "What's your favorite position with me and why?",
  "How many times have you pictured me naked today?",
  "What's the filthiest text you wish I'd send you right now?",
  "What do you want me to do to you the second we're alone again?",
  "Tell me your most secret fantasy starring us.",
  "What's the most turned on I've ever gotten you in public?",
  "What sound do you make that you hope drives me crazy?",
  "Is there a toy you've imagined using with me?",
  "Where on your body do you most want my lips right now?",
  "What's the dirtiest thing you'd let me do to you on camera?",
  "What were you imagining the last time you bit your lip at me?",
  "Morning, night, or the middle of the day — when do you want me most?",
  "What's the one thing I do that instantly gets you going?",
  "What would you beg me for tonight if I made you?",
  "What's the most desperate you've ever been for me?",
  "Describe the last dream you had about us in detail.",
  "What's a word you want me to call you in bed?",
];
const DARE = [
  "Take off one piece of clothing on camera, slowly.",
  "Send me a photo of the part of you that aches for me most.",
  "Touch yourself the way you want me to — 15 seconds, on camera.",
  "Describe, in filthy detail, what you'd do to me — out loud for 30 seconds.",
  "Send me a voice note moaning my name.",
  "Strip down to whatever's under your clothes and show me.",
  "Run your hands slowly over yourself while I watch.",
  "Text me the dirtiest thing you want to do to me — no filter.",
  "Bite your lip, look at the camera, and tell me you're mine.",
  "Show me your favorite spot to be touched — and touch it.",
  "Take a teasing photo and send it to me right now.",
  "Whisper into the mic exactly how you want tonight to go.",
  "Take something off and tell me what you'd do next.",
  "Send a photo with one button (or layer) fewer than you have now.",
  "Moan for me — loud — on camera.",
  "Pose the way you'd want me to find you in bed.",
  "Tell me, to my face, your dirtiest fantasy about us.",
  "Trace your fingers down your body while holding eye contact.",
  "Record a 10-second clip of your most irresistible move.",
  "Send me the most NSFW selfie you'd only ever send me.",
  "Show me how you'd kiss me if I were there.",
  "Say out loud what you're imagining doing to me right now.",
  "Take off your shirt and tell me you wish I were doing it.",
  "Beg me for something — and mean it.",
  "Give the camera a few seconds of a slow striptease.",
  "Tell me exactly where you want me tonight.",
  "Send a photo of you biting your lip thinking about me.",
  "Touch the spot you most want my mouth on.",
  "Say the filthiest sentence you can think of, looking right at me.",
  "Show me what you do when you can't stop thinking about me.",
  "Send me a teasing video peeling off one layer.",
  "Whisper what you'd do if I walked in right now with nothing on.",
  "Press close to the camera and tell me a secret you want me to act on.",
  "Show me, with your hands, exactly how you want to be held down.",
  "Send me one photo that'll keep me up all night.",
  "Undo one thing and leave it for me to imagine the rest.",
  "Tell me your safe word — then dare me to make you need it.",
  "Look into the camera and tell me what you'd do to me first.",
];
const CARD_DECKS = { wyr: WYR, truth: TRUTH, dare: DARE, nhie: NHIE, confess: CONFESS, fantasy: FANTASY, finish: FINISH };
const CARD_LABELS = {
  wyr: "🤔 Would you rather: ", truth: "💬 Truth: ", dare: "🔥 Dare: ",
  nhie: "🙊 Never have I ever ", confess: "😈 ", fantasy: "🎬 Picture this: ", finish: "✍️ Finish it: ",
};
export function cardLabel(kind) { return CARD_LABELS[kind] || "🎴 "; }
export function drawCard(kind) {
  if (kind === "random") { const ks = Object.keys(CARD_DECKS); kind = ks[Math.floor(Math.random() * ks.length)]; }
  const deck = CARD_DECKS[kind] || TRUTH;
  const text = deck[Math.floor(Math.random() * deck.length)];
  $("card-out").classList.remove("hidden");
  $("card-out").textContent = cardLabel(kind) + text;
  netSend({ t: "card", kind, text });
}

// Partner drew a card (net.js `card` case).
export function showPartnerCard(kind, text) {
  $("card-out").classList.remove("hidden");
  $("card-out").textContent = cardLabel(kind) + text;
  addSys(`${S.settings.partner} drew a card — check ✨`);
}
