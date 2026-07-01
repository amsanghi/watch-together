# WatchTogether relay server 💞🔌

A tiny private relay so the two of you connect over **one fixed link you control**
instead of the flaky public relays. Once both extensions point at your relay,
**everything** — play/pause/seek sync, chat, reactions, typing, and voice/video
call setup — flows through it. No "find each other", no rejoining, far fewer drops.

> **What goes through the relay:** all data (sync, chat, reactions, presence) and
> the *setup* of the voice/video call. The call's audio/video then flows
> peer-to-peer by default. To force the call's media through a server too, run a
> TURN server and fill in the optional TURN fields in the extension (see
> [Fully-relayed calls](#optional-fully-relayed-calls-turn) below). For the
> disconnection problem, relaying the data + call setup is the part that matters.

---

## One-time setup

You need two free tools: **Node.js** and **ngrok**.

1. **Node.js** — install the LTS build from <https://nodejs.org>.
2. **ngrok** — this is what gives your local server a public link.
   ```bash
   brew install ngrok            # or download from https://ngrok.com/download
   ```
   Make a free account, copy your authtoken from the ngrok dashboard, then:
   ```bash
   ngrok config add-authtoken <YOUR_TOKEN>
   ```
3. **(Recommended) a fixed link that never changes.** Every free ngrok account
   gets one static domain. Claim it at <https://dashboard.ngrok.com/domains>,
   then:
   ```bash
   cp .env.example .env
   ```
   and set `NGROK_DOMAIN=your-domain.ngrok-free.app` in `.env`. Without this you
   still get a working link — it just changes each time you restart the server.

## Run it

Double-click **`start.command`** (macOS), or from a terminal:

```bash
cd relay-server
./start.command
```

It installs dependencies on first run, starts the server, opens the tunnel, and
prints something like:

```
======================================================================
✅  Relay is LIVE.

    Paste this into the extension's  "Relay server"  box
    on BOTH computers:

        wss://your-domain.ngrok-free.app

    Keep this window open while you watch. Press Ctrl+C to stop.
======================================================================
```

Copy that `wss://…` line.

> Not on macOS? Run `npm install` then `npm start`, and in another terminal run
> `ngrok http 8787` yourself. Use the `https://…` URL ngrok shows, but change
> `https` to `wss` when you paste it into the extension.

## Use it in the extension

On **both** computers:

1. Open the WatchTogether side panel.
2. Paste the `wss://…` link into the **Relay server** box.
3. Type the **same secret word** (optional — it just lets multiple couples share
   one relay; if you both leave it blank you still land together).
4. Click **Pair & connect**. That's it — you're on your own relay.

To go back to the default public relays, clear the Relay server box and unpair.

---

## Optional: fully-relayed calls (TURN)

By default the **video/audio** of the call flows peer-to-peer (only its setup goes
through the relay). If either of you is behind a strict/symmetric NAT and the call
media itself won't connect, run a TURN server and it will relay the media too.

Easiest is [coturn](https://github.com/coturn/coturn):

```bash
brew install coturn
turnserver -a -v -n --no-dtls --no-tls \
  --user=watch:together --realm=watchtogether \
  --listening-port=3478
```

Then in the extension, expand **"Relay: force calls through it too (TURN)"** and enter:

- **turn:** `turn:YOUR_PUBLIC_IP:3478`
- **username:** `watch`
- **password:** `together`

(TURN needs UDP/TCP on its own port reachable from the internet, which is why it's
separate from the ngrok tunnel. For a home setup, port-forward 3478 or run coturn
on a small VPS.)

---

## How it works

```
  Person A extension ──┐
                       ├──►  wss://your-domain  ──►  server.js (this relay)
  Person B extension ──┘         (ngrok)

  server.js groups sockets by ?room=<hash of your secret word> and forwards every
  message from one to the other, verbatim. It also emits a "roster" so each side
  knows the partner is present and who starts the call. It never reads your
  messages — it's a blind pipe.
```

## Files

| File            | What it is                                                  |
|-----------------|-------------------------------------------------------------|
| `server.js`     | The WebSocket relay + a health page. Zero config to run.    |
| `start.command` | One-click: installs deps, starts server, opens ngrok tunnel.|
| `.env.example`  | Copy to `.env` to set `PORT` / your fixed `NGROK_DOMAIN`.   |
| `package.json`  | One dependency (`ws`).                                       |

## Notes

- **Privacy:** the relay only sees encrypted-in-transit (TLS via ngrok) blobs it
  forwards; it doesn't store anything. Still, it's *your* server — anyone with the
  link and your secret word could join, so don't post the link publicly.
- **Cost:** free. ngrok's free tier and this server are enough for two people.
- **Keep the window open** while watching; closing it stops the relay.
