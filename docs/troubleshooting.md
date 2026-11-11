# Troubleshooting

## Known limits

- **One number per process.** Two instances sharing `auth/` fight over the connection.
- **Voice notes are downloaded on first use** and reused for every rule on that message.
- **`continue: false` is the default**: the first matching rule wins. Give specific rules
  low `priority` numbers.
- **Read-only**: no blue ticks and no presence, but the grey double delivery tick comes from
  the server and cannot be disabled from the client.
- **LLM classification costs** one API call per message that reaches such a rule. Keep it
  for rules that really need it.
- If Baileys changes protocol, update it: `npm i @whiskeysockets/baileys@latest`.
- **A transcription is never cached across messages.** Every voice note costs one call.

## Error 440 / "connection replaced" in a loop

It means **two sessions are using the same credentials**: WhatsApp replaces one, then the
other, forever. Typical causes, most frequent first:

1. **Two wafflow instances running.** The program now refuses to start if it finds
   another live instance (lock in `data/instance.lock`). If one is stuck:
   `taskkill /F /IM node.exe` and restart.
2. **Another process reading the same `auth/` folder** — an old copy of the project, or a
   different Baileys client.
3. The session was opened elsewhere: re-pair with a QR — **Delete the session and
   re-pair** in the [web panel](web-panel.md#when-the-session-expires-loggedout), or
   delete `auth/` and restart.

After 4 attempts the program stops by itself instead of continuing the fight, and says so.
The client now **always closes the previous socket** before opening a new one — the absence
of that close was what generated the loop in the first place.

## Messages that cannot be decrypted

The logs fill with stack traces like these:

```
Failed to decrypt message with any known session...
Session error:Error: Bad MAC Error: Bad MAC
    at async 198264414552088.0 [as awaitable] (session_cipher.js:171:28)
```

The part that matters is the **address on the last line**: `198264414552088` is an account and
`.0` is one of its devices. The signal session with that device is out of step, so WhatsApp
keeps resending and the check keeps failing. It is not a configuration problem, and those
messages cannot be recovered: they arrive, and they cannot be read.

How to size it up:

- **one address only** → that conversation is affected, everything else keeps working;
- **every message fails** → the instance is effectively deaf;
- `npm run health` says how many in the last ten minutes, and whether the container should be
  considered unhealthy.

The fix for a session out of step, **with the program stopped** — while it runs it rewrites the
file from memory and the delete is pointless:

```bash
docker compose stop
mv data/auth/session-198264414552088.0.json /tmp/     # the address from the error, without ".0" if you prefer
docker compose start
```

It renegotiates from the public key and WhatsApp answers with a fresh prekey message.
`creds.json` is not touched: the device stays linked.

If it comes back, or several sessions fail at once, re-pair instead: stop, move `data/auth/`
aside, start, scan the QR from *Linked devices*. Rules, logs, contacts and media live in
`data/` and stay.

**Why it happens**: your account is linked on more than one device and the same session
advances on both sides. A restart with messages queued, or a client that starts *sending*
after only ever reading, is enough to step them out of order.

> libsignal talks straight to `console`, so it ignores `LOG_LEVEL` and the structured logger.
> The program intercepts it: the failures are counted (one line with a number every thirty
> seconds, counters in `data/health.json`), and its **four session dumps** — `Closing session:`,
> `Opening session:`, `Removing old closed session:`, `Session already closed` — are dropped
> entirely. They print the whole session object **including its private keys**
> (`rootKey`, `chainKey`, `privKey`), always, whether or not debug logging is on, and they
> happen whenever a session is set up. If you read the raw logs of another client, expect key
> material in there.

To go deeper, `LOG_LEVEL=debug` also **un-silences Baileys**, which by default logs nothing at
all. Its retry lines are the only place where you can see which message is being asked for
again, and how many times.

## A rule never fires and the file looks fine

First: is the file **valid YAML**? If you save it broken (a repeated key, wrong indentation)
the app **does not load it** and keeps the previous rules. In the log:

```
rules reload failed, keeping the old ones: rules.yaml: invalid YAML
  → Map keys must be unique at line 128, column 5
```

The classic case is writing the same key twice in one rule:

```yaml
  - id: my-rule
    transcribe: true
    match: { type: audio }
    transcribe: true      # ← duplicate: is that valid YAML? No, and the rule does not exist
```

`npm run check` tells you immediately. And if you forget, the app reminds you **every two
minutes** until you fix it.

## A rule never fires and it is not YAML

Use the [web panel](web-panel.md) test bench: it prints, rule by rule, **which criterion
failed**. In practice it is one of these:

- `type` — a voice note is `audio`, a written message is `text`
- `textMatch` — for voice notes the transcript writes numbers as words ("three boxes", not
  "3 boxes"), so a pattern expecting a digit never matches
- `\b` with an accented word — see [rules](rules.md#-b-and-accented-characters)
- `chatName` — it is "contains", so check you aren't matching more than you think
- `priority` — an earlier rule matched first and `continue` is false

## A rule with a jid never fires

Look at `data/messages.jsonl`: the `chatJid` field tells you which form the message arrived
in. If it is `...@lid` and you wrote a phone number, that is the
[LID](rules.md#lid-why-your-number-alone-is-not-enough) case. Use `"@me"` for your own
account, and `npm run contacts` to see both forms of the others; matching works either way
because the address book bridges them.

## `loggedOut`

WhatsApp closed the session (revoked from the phone, or too long without use).

With the [web panel](web-panel.md#when-the-session-expires-loggedout) on: the state box
says **session expired**, press **Delete the session and re-pair (QR)** and scan the QR
that appears in the page. Only `auth/` is deleted; rules, contacts and media stay.

Without the panel: delete the `auth/` folder and restart to re-pair.

## Telegram: "chat not found"

A bot cannot message you first. Open the bot link (`https://t.me/<bot_name>`) and press
**Start**, then try again. `npm run check` tells you exactly this.

## Home Assistant actions do nothing

If the log says `fetch failed`, the request never reached Home Assistant: check `HA_URL`.
`npm run check` verifies it for real (it calls `/api/config`).

If the API responds but nothing happens, the target entity may be `unavailable` — see the
caveat in [home-assistant.md](home-assistant.md#a-caveat-about-unavailable-entities).

## The web panel does not come up

- `WEB_ENABLED=true` in `.env`, or in the compose
- with Docker, the **`ports:`** line must publish the port, and the host binding decides
  whether it is reachable from the LAN
- the token: if `WEB_TOKEN` is empty it is generated, look in `data/web-token.txt` or in
  the startup log

## Changed `.env` but nothing changed

With Docker, `env_file` is read when the container **is created**. Changing `.env` requires
`docker compose up -d` (not just a restart) so the container is recreated.

And if a dashboard manages your stack, it may own the env file: it rewrites it on every
deploy, so SSH edits disappear. Move what you need to change often into the compose.
