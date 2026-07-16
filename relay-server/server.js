#!/usr/bin/env node
'use strict';

/*
 * WatchTogether relay server.
 *
 * A dead-simple, protocol-agnostic WebSocket relay for exactly two people (a few
 * more are tolerated for reconnection overlap). It replaces the flaky public
 * Trystero rendezvous relays the extension uses by default:
 *
 *   - Discovery:   whoever connects with the same ?room= lands together. No STUN,
 *                  no torrent/MQTT swarm, no "find each other" — same link = paired.
 *   - Data:        every message a client sends is forwarded verbatim to the other
 *                  client(s) in the room. This carries the ENTIRE app protocol —
 *                  play/pause/seek sync, chat, reactions, typing, media-state, etc.
 *   - Call setup:  the extension's WebRTC offer/answer/ICE for voice+video ride the
 *                  same relay as ordinary messages (type "__rtc"), so calls are set
 *                  up over a link you control instead of public brokers.
 *
 * The server never inspects payloads (except its own "__relay" roster events). It's
 * a blind pipe, so new extension features work with no server change.
 *
 * Run:  PORT=8787 node server.js     (usually launched by ./start.command via ngrok)
 */

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8787;
const RESERVED = '__relay'; // our own control-message type; clients never send this

// Optional Cloudflare Realtime TURN. If configured, the relay mints short-lived TURN
// credentials and hands them to both clients in the roster, so the call has a media
// relay when a direct P2P path can't be found (hard NAT / CGNAT). The token lives
// ONLY here (env, e.g. ~/.watchtogether-relay.env) — never in the public extension.
// Blank = STUN-only (unchanged behavior).
const CF_TURN_KEY_ID = process.env.CF_TURN_KEY_ID || '';
const CF_TURN_API_TOKEN = process.env.CF_TURN_API_TOKEN || '';
let turnIceServers = null; // last minted [{ urls, username, credential }, …]

async function mintTurn() {
  if (!CF_TURN_KEY_ID || !CF_TURN_API_TOKEN) return;
  try {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${CF_TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + CF_TURN_API_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 86400 }),
    });
    const j = await res.json();
    if (j && Array.isArray(j.iceServers)) {
      turnIceServers = j.iceServers;
      console.log(`[relay] minted Cloudflare TURN creds (${turnIceServers.length} entries)`);
    } else {
      console.log('[relay] Cloudflare TURN: unexpected response', JSON.stringify(j).slice(0, 200));
    }
  } catch (e) {
    console.log('[relay] Cloudflare TURN mint failed:', e && e.message);
  }
}

// room id -> Map<socketId, ws>
const rooms = new Map();

function membersOf(room) {
  return rooms.get(room) || new Map();
}

function send(ws, obj) {
  try {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  } catch (_) {}
}

// Tell everyone in a room who's currently present. The extension uses this to
// know its own id, whether the partner is here, and who initiates the call.
function broadcastRoster(room) {
  const members = membersOf(room);
  const ids = [...members.keys()];
  for (const [id, ws] of members) {
    send(ws, {
      t: RESERVED,
      event: 'roster',
      self: id,
      peers: ids.filter((x) => x !== id),
      count: ids.length,
      ...(turnIceServers ? { iceServers: turnIceServers } : {}),
    });
  }
}

// ---- HTTP: health check + a friendly landing page (also satisfies ngrok) ----
const server = http.createServer((req, res) => {
  // Be permissive: an extension page has a chrome-extension:// origin and may
  // probe /health. WebSocket upgrades below aren't subject to CORS anyway.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    let people = 0;
    for (const m of rooms.values()) people += m.size;
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size, people, uptime: process.uptime() }));
  }

  const host = req.headers.host || `localhost:${PORT}`;
  const wss = host.includes('localhost') || host.startsWith('127.') ? 'ws' : 'wss';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WatchTogether relay</title></head>
  <body style="font-family:system-ui,-apple-system,sans-serif;background:#12121a;color:#eee;padding:8vw 6vw;line-height:1.6;max-width:720px;margin:auto">
    <h1 style="color:#ff7ec0">💞 WatchTogether relay is running</h1>
    <p>This is your private relay for the WatchTogether extension. Paste the link below into the
       extension's <b>Relay server</b> box on <b>both</b> computers, then pair as usual.</p>
    <pre style="background:#000;padding:14px 16px;border-radius:10px;font-size:16px;overflow:auto">${wss}://${host}</pre>
    <p style="color:#9aa">Active rooms: ${rooms.size} · uptime ${Math.round(process.uptime())}s</p>
  </body></html>`);
});

// ---- WebSocket relay ----
const wss = new WebSocketServer({ server, maxPayload: 4 * 1024 * 1024 });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const room = (url.searchParams.get('room') || 'main').slice(0, 200);
  const id = crypto.randomUUID();
  ws.roomId = room;
  ws.peerId = id;
  ws.isAlive = true;

  if (!rooms.has(room)) rooms.set(room, new Map());
  rooms.get(room).set(id, ws);
  console.log(`[relay] + ${id.slice(0, 8)}  room="${room}"  (${rooms.get(room).size} present)`);
  broadcastRoster(room);

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data, isBinary) => {
    // Blind relay: forward to every OTHER member of the same room, untouched.
    const members = rooms.get(room);
    if (!members) return;
    for (const [mid, peer] of members) {
      if (mid === id) continue;
      try {
        if (peer.readyState === peer.OPEN) peer.send(data, { binary: isBinary });
      } catch (_) {}
    }
  });

  const drop = () => {
    const members = rooms.get(room);
    if (!members) return;
    members.delete(id);
    if (members.size === 0) rooms.delete(room);
    else broadcastRoster(room);
    console.log(`[relay] - ${id.slice(0, 8)}  room="${room}"`);
  };
  ws.on('close', drop);
  ws.on('error', () => {});
});

// Keepalive: ping every 30s and terminate sockets that stopped answering. This
// is what lets the partner's side notice a silent Wi-Fi drop within ~1 minute.
const keepalive = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch (_) {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  }
}, 30000);
wss.on('close', () => clearInterval(keepalive));

server.listen(PORT, () => {
  console.log(`[relay] WatchTogether relay listening on :${PORT}`);
  console.log(`[relay] local health check: http://localhost:${PORT}/health`);
  if (CF_TURN_KEY_ID && CF_TURN_API_TOKEN) {
    mintTurn();                                  // mint now…
    setInterval(mintTurn, 12 * 60 * 60 * 1000);  // …and refresh well before the 24h TTL
  } else {
    console.log('[relay] no CF_TURN_* env set — calls use STUN only (set them in ~/.watchtogether-relay.env for a TURN relay)');
  }
});
