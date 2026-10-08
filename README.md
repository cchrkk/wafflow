<p align="center">
  <img src="assets/logo.svg" alt="wafflow" width="512">
</p>

<h1 align="center">wafflow</h1>

Reads WhatsApp messages (through **Baileys**, the WhatsApp Web protocol), **categorises
them with rules**, and runs **actions** based on those rules: voice-note transcription,
Telegram, Home Assistant, webhooks, files, local commands.

**Read-only by design**: no read receipts, no presence. It does not send either — unless you
explicitly turn it on. See [what that guarantees](#read-only-mode).

```yaml
# example: voice notes in an "Orders" chat get transcribed and sent
# to Telegram and to a file
- id: orders-voice
  match:
    chatName: Orders
    type: audio
    textMatch:
      mode: regex
      flags: iu
      patterns: ['(?<![\p{L}\p{N}])(cartons|boxes|kg)(?![\p{L}\p{N}])']
  transcribe: true
  actions:
    - type: notify.telegram
      message: "🎙️ {{sender}}: {{transcript}}"
    - type: appendJsonl
      file: data/orders.jsonl
```

---

## 30-second start

```bash
npm install
cp .env.example .env       # fill in at least the transcription part
npm start                  # a QR code appears on first run: scan it from WhatsApp
```

Requires **Node.js 20+**. Transcription needs either an API key or a local whisper:
two lines in `.env` either way.

- [`docs/install.md`](docs/install.md) — install, QR, Docker, running as a service
- [`docs/transcription.md`](docs/transcription.md) — Groq/OpenAI or local whisper

Then open the **web panel** ([`docs/web-panel.md`](docs/web-panel.md)): write rules, try
them against a text or a voice note, and see **which criterion** blocked each rule. It is
by far the fastest way to understand what you are doing.

---

## What it does

| | |
|---|---|
| **Rules** | match on chat, sender, type, text and transcript; regex with Unicode boundaries; priorities; several rules on the same message |
| **Voice notes** | transcribed before matching, so you can filter on *what was said* |
| **Classification** | an optional LLM decides what a message is about (work, orders, spam) |
| **Actions** | Telegram (notices **and chat mirroring**, media included), Home Assistant (notifications, scripts, lights, automations, Assist), webhooks, JSONL files, local commands |
| **Contacts** | keeps LIDs, phone numbers and names together: WhatsApp is migrating to anonymous IDs and your jids keep working |
| **Web panel** | rule editor that validates before saving, plus a test bench |
| **Docker** | public image on GHCR, deploy without building |
| **Health** | the container reports `unhealthy` when it stops reading, with a Telegram alert |

---

## How this was built

**Vibecoded.** The code and most of this documentation were written by prompting an AI; a
human decided what to build, tried it, and reported what did not work.

That has consequences worth knowing before you trust it:

- **Everything claimed here was tried for real** — but only in the ways described. Where
  something has not been verified, the text says so.
- **AI-written code has specific failure modes**, and this project keeps the receipts:
  `\b` that never matches an accented word, the editor selection that drifted while
  scrolling, a rules file that silently failed to reload, a dashboard that overwrote
  `.env` on every deploy. They are all written up in
  [troubleshooting](docs/troubleshooting.md), with the cause.
- **Read the code before pointing this at a number you care about.** It is plain Node, no
  build step, a few thousand lines, and every log message tells you what it just did.

The upside is real too: code, tests, documentation, CI and a container image, in a couple
of days. The test suites in `tools/` run on every push, so a change that breaks the rule
engine or the editor is caught before it reaches the server.

---

| Document | What is in it |
|---|---|
| [install](docs/install.md) | requirements, QR, auto-start on Windows, Docker |
| [rules](docs/rules.md) | every match criterion, the traps, the LID address book |
| [actions](docs/actions.md) | the actions, the placeholders, capture groups |
| [transcription](docs/transcription.md) | Groq, OpenAI, local whisper |
| [Home Assistant](docs/home-assistant.md) | token, examples, how to test without touching your house |
| [web panel](docs/web-panel.md) | editor and test bench, security |
| [data and media](docs/data-and-media.md) | where everything ends up, automatic cleanup |
| [testing](docs/testing.md) | simulations, fake servers, what runs in CI |
| [troubleshooting](docs/troubleshooting.md) | known limits and failures already hit, with the cause |

Ready-made **examples** live in [`examples/`](examples/): one file per use case, with a
title that says what it does. Copy one into `config/rules.d/` and it works — no pasting.

---

## Read-only mode

This project **observes and nothing else**:

- **no read receipts** — there is no call to `readMessages()` anywhere, and the method is
  made unreachable on the client. People who write to you will **never** see blue ticks
- **no presence** — you do not appear online, you do not show "typing"
- **no history download** — only messages that arrive while the process is running
- **no sending** — off unless you turn it on, see the exception below

The first three are not configurable at all: no setting, in `.env` or in the rules, turns
them on. They are the reason this program exists.

### The one exception: `ALLOW_REPLY`

Sending is the only guarantee you can drop, and you drop it **in `.env`** — never in
`rules.yaml`:

```ini
ALLOW_REPLY=true
```

With it on, rules that use the `reply` action really write into the chat, with your number,
at whatever hour the rule fires. That is also what lets the
[Assist chat](docs/home-assistant.md#assist-talking-to-it) answer you inside WhatsApp.

It is deliberately **not** possible from the rules file: the web panel can rewrite your
rules, and a stolen panel token should not be able to start sending messages. Read receipts
and presence stay off even then, and both `npm run check` and the startup banner remind you
that sending is on.

> ### ⚠️ If you turn it on, know what you are getting into
>
> This program is a reader with a writer bolted on, and the writer is where an unofficial
> client is weakest. From a real deployment:
>
> - The Signal session that carries your account's traffic — **your own messages, and the
>   group keys for chats where you are the only member** — is the session between this
>   instance and your other devices, your phone first. It is also the one that breaks.
> - When it breaks it breaks **both ways**: the instance stops reading what your phone sends
>   (`Bad MAC` in the logs), and your phone shows **"Waiting for this message"** for what the
>   instance sends. The reply is delivered; it just cannot be opened.
> - **Repairing is a reset, not a cure.** Deleting the session or re-linking restores it, and
>   neither removes the cause; each re-link also leaves one more linked device behind on your
>   account.
> - **It is not about the age of the session.** A session can be minutes old and already out
>   of step, because it was rebuilt from a key the server handed over while the other side
>   had moved on.
>
> So: if you need the answers **inside WhatsApp**, expect this, and use a dedicated number for
> it. If you need the categorisation — which is what this program is for — leave `ALLOW_REPLY`
> alone and send the answers somewhere else (Telegram, a phone notification, a file).
>
> Reading tolerates a broken session: WhatsApp just resends. Writing does not: your phone sits
> there showing "waiting". The healthcheck reports the first, because that one you can see.

One thing **is not up to us**, honestly: the grey double tick of **delivery**. WhatsApp's
server generates it when the message reaches the linked device. Blue ticks are ours to
control, and those will never arrive.

In practice: messages stay unread on your phone until *you* open WhatsApp.

> ⚠️ Baileys is **not official**: it speaks the WhatsApp Web protocol. That is against
> WhatsApp's ToS and the linked number can be banned (rare if you don't spam, but
> possible). **Use a dedicated number, not your personal one.** The session lives in
> `auth/`: whoever copies it has your WhatsApp.

---

## Project layout

```
wafflow/
├─ src/                the program
├─ config/
│  ├─ rules.yaml       ← your rules (not in the repo)
│  ├─ rules.d/         extra rules: one file per topic, merged into rules.yaml
│  └─ rules.example.yaml
├─ examples/           ready-made rules per use case, to copy into rules.d/
├─ docs/               this documentation
├─ fixtures/           fake messages for --simulate
├─ tools/              fake Home Assistant, sample audio generator, tests
├─ data/               logs, state, media, contacts (not in the repo)
├─ docker/             container entrypoint
├─ Dockerfile · compose.yaml
└─ .env                configuration (not in the repo)
```

---

## ⚠️ What must never reach the repository

| file | why |
|---|---|
| `.env` | API keys and bot tokens |
| `auth/` | **it is the WhatsApp account**: anyone who copies it can read and write as you |
| `data/` | messages, transcripts, contacts with real names and numbers |
| `config/rules.yaml` and `config/rules.d/*.yaml` | names of your chats and contacts |

All of them are in `.gitignore`. Before publishing anything:

```bash
git ls-files | grep -Ei "env|auth|rules"
```

It must print nothing (except `.env.example` and the `README.md` files). If you committed
a secret by accident, **rotate the key**: it is faster than rewriting git history, and the
one you pushed should be considered burned.

---

## License

MIT — see [LICENSE](LICENSE). Not affiliated with WhatsApp or Meta; using Baileys may
violate their Terms of Service, and you are responsible for how you use it and for your
contacts' data.
