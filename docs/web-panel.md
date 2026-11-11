# Web panel

A rule editor and a test bench, in a single page. It is off by default.

```ini
WEB_ENABLED=true
WEB_PORT=8099
WEB_BIND=127.0.0.1     # 127.0.0.1 = this machine only | 0.0.0.0 = visible on the LAN
WEB_TOKEN=             # empty = it generates one and tells you in the logs
```

Then open `http://<host>:<port>`. If `WEB_TOKEN` is empty, the generated token goes to
`data/web-token.txt` and is printed at startup:

```bash
docker compose logs wafflow | grep -i token
```

## What it does

**Editor.** The YAML on the left, with *Validate* and *Save*. Saving **validates the file
before writing it**: if the YAML is broken nothing on disk is touched and you get line and
column. This is the defence against the most insidious mistake — a duplicated key on disk
that the app ignores, silently carrying on with the previous rules. A copy of the previous
version is kept in `rules.yaml.bak`, and the file is written atomically.

*Validate only* checks without writing anything.

**Test bench.** Pick a chat and a sender, then paste a text **or drop a voice note**. The
voice note is transcribed with the same engine real voice notes use, and the message is
then run through the rule engine in `dryRun`.

*Chat* and *Sender* are the **names**: they fill `chatName` and `senderName`. A rule that
matches on `chatJid` or `senderJid` looks at the jid instead, and the two optional fields
below take it. There you can write **`@me`** for your own account, exactly as in the rules:
the panel resolves it to your real jid, so a `senderJid: "@me"` rule — notes to yourself,
[home commands](home-assistant.md) — is testable like any other. If the app has never paired
with WhatsApp it does not know which account is yours, and it says so rather than quietly
reporting a match failure that does not exist in real life.

What you get is **why** each rule matched or not:

```
rule                      why
─────────────────────────────────────────────────────────────
orders-text               fails: type
orders-voice              all criteria satisfied · actions: appendJsonl, notify.telegram
home-turn-on-light        all criteria satisfied · actions: ha.action
notes-to-myself           fails: senderJid, chatName
```

The `failed` field was already computed by `ruleMatches()` and used to end up in a debug
log line: the panel just shows it to you.

## When the session expires (loggedOut)

WhatsApp sometimes closes the session on its own: you revoke it from the phone, the
phone is reset, or it simply goes unused for long enough. Until now that meant stopping
the program, deleting `auth/` and starting again — and with Docker, hunting the QR in
`docker compose logs`.

The panel now has a **WhatsApp session** box at the top of the editor column:

- the state — *connected*, *scan the QR*, *reconnecting*, **session expired**;
- the QR itself, the same one the terminal prints: scan it from *Linked devices*;
- **Delete the session and re-pair (QR)**, the button to press when the state says
  *session expired*. It deletes `auth/` — and only that: rules, contacts, logs and media
  stay — then asks WhatsApp for a new QR and shows it in the panel a couple of seconds
  later. The process keeps running: no restart, no terminal.

The QR changes every ~20 seconds and the panel refreshes the state every 4 seconds, so
it follows along by itself. The button asks for a confirmation first, because until a
new QR is scanned no message is read.

## Security

- **The test is always a dry run**: the panel has no code path that sends WhatsApp
  messages — not even with `ALLOW_REPLY=true`. A bug in the panel cannot make it send.
- **Deleting the session** only deletes `auth/`, and only with the panel token: the same
  token that can rewrite the rules. It cannot send anything either.
- With `WEB_BIND=0.0.0.0` anyone who reaches the port can **rewrite your rules**: always
  set a `WEB_TOKEN`. If you leave it empty it is generated, not left open.
- In Docker the host binding is a separate choice, because inside the container the app
  must listen on `0.0.0.0`. In the compose file, edit the **`ports:`** line (`0.0.0.0` vs
  `127.0.0.1`).
- Docker **bypasses UFW**: a published port is filtered by nothing. If you expose it on the
  LAN and want more than a token, put it behind Cloudflare Access or an SSH tunnel.

## Testing without exposing anything

```bash
node tools/web-smoke.mjs
```

It starts the panel on a test port working on a **copy** of the rules, exercises every
endpoint, and checks that saving broken YAML is refused without touching the file. It is a
CI step.

```bash
node tools/web-dev.mjs            # panel only, no WhatsApp connection
node tools/editor-test.mjs        # the editor logic, unit-tested
```

## A caveat if you run it with Docker

If your stack is managed by a dashboard that stores the compose file itself, that dashboard
probably **owns the env file too**: it rewrites it on every deploy, so changes you make to
`.env` over SSH get wiped. Put the settings you want to change often in the compose
(`environment:` and `ports:`), not in `.env`.
