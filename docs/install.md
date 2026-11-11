# Install

## Requirements

- **Node.js 20+** (tested on Node 26)
- `ffmpeg` in the PATH — only if you transcribe with the `command` backend and need to
  convert the audio
- A transcription engine (see [transcription](transcription.md)) — or none

## Install

```bash
npm install
cp .env.example .env
```

Then open `.env` and fill in at least the transcription block.

## First run / QR

```bash
npm start
```

On the first run a **QR code appears in the terminal** (and in the web panel, if
`WEB_ENABLED=true`): WhatsApp → *Settings* → *Linked devices* → *Link a device* → scan it.

Credentials go into `auth/`; from the second run on you don't need the QR again.

If WhatsApp closes the session (*logout*), use **Delete the session and re-pair (QR)** in
the [web panel](web-panel.md#when-the-session-expires-loggedout), or delete `auth/` and
restart, to re-pair.

## Auto-start on Windows

The simplest way is **Task Scheduler**: *Create task* → *Run at logon* → action *Start a
program* pointing at `start.bat`, with *"Run whether user is logged on or not"* checked.

For a real service you need a wrapper (`nssm`, `winsw`) pointing at `node src/index.js`
with the project as working directory.

On Linux, the container is the better answer.

## Docker

```bash
cp .env.example .env
# fill in .env and config/rules.yaml, then
docker compose up -d --build
docker compose logs -f
```

On the first run the QR appears **in the logs** (`docker compose logs -f wafflow`) or in
the web panel, to be scanned from WhatsApp → *Linked devices*.

What the generic stack does:

| choice | why |
|---|---|
| `DATA_DIR=/app/data` | relative paths in your rules (`data/orders.jsonl`) land in the volume, not in the image layer |
| volume `wa-data:/app/data` | session, logs, media and contacts survive rebuilds |
| bind `./config:/app/config` | rules stay outside the image: edit them without rebuilding |
| `stop_grace_period: 20s` | on `stop` the app saves contacts, state and rules before exiting |
| user `node`, not root | nothing here needs root |
| `tini` as entrypoint | signals reach node instead of being swallowed by PID 1 |

**No port is published**, deliberately: the app only talks outbound, and Docker bypasses
UFW, so exposing nothing is the simplest defence. The only exception is the
[web panel](web-panel.md), which is optional.

If you use the `command` transcription backend (local whisper) `ffmpeg` is already in the
image; with `openai`/Groq you can drop that line from the `Dockerfile` and save ~80 MB.

To update:

```bash
docker compose pull && docker compose up -d
```

### Is it healthy?

The image carries a `HEALTHCHECK`, so `docker ps` shows `healthy` / `unhealthy` without
anyone reading a log. The same judgement is one command away:

```bash
docker compose exec wafflow node src/index.js --health
# wafflow: healthy — connected=true paired=true messages=42 undecryptable(10m)=0
```

It reads `data/health.json`, which the running process keeps up to date, and it says unhealthy
when the instance is paired but not connected, when the snapshot has stopped being updated,
or when messages are arriving that it cannot decrypt — see
[troubleshooting](troubleshooting.md#messages-that-cannot-be-decrypted).

With `HEALTH_NOTIFY=true` (the default, and it needs the Telegram settings) the same condition
sends a Telegram message instead of waiting for somebody to look: **at most one an hour**, so
a bad night does not fill your phone.

The data volume stays, so **there is no QR to scan again**.

### Public image

GitHub Actions builds the image on every push to `main` and publishes it to
`ghcr.io/cchrkk/wafflow` (public: it pulls without credentials). On a server you can
therefore skip cloning entirely: a `compose.yaml` with `image:` and your `.env` is enough.

A real case of deploying to a host that **cannot build**: the agent running Docker commands
there has `ProtectHome=true`, so `/root` is read-only and `docker compose build` fails with
`mkdir /root/.docker: read-only file system`. `pull` works fine, so the build happens
elsewhere (CI) and the server just downloads.
