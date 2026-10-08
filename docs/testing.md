# Testing

Nothing here touches WhatsApp or your secrets, so you can iterate freely.

## Validate and inspect

```bash
npm run check        # validates config and environment
npm run contacts     # jids, LIDs and names it knows
```

`check` verifies the rules, the placeholders, the actions, and — if reachable — your
Telegram bot and your Home Assistant. It is the first thing to run after editing anything.

## Simulate a message

```bash
node src/index.js --simulate fixtures/sample-text.json          # dry run, no action executed
node src/index.js --simulate fixtures/sample-text.json --live   # really runs the actions
node src/index.js --simulate fixtures/sample-audio.json         # the voice-note path
```

The fixture is just a JSON message:

```json
{
  "chatJid": "390000000000@s.whatsapp.net",
  "chatName": "Orders",
  "senderJid": "390000000001@s.whatsapp.net",
  "senderName": "Mario",
  "type": "text",
  "text": "send 3 boxes of red"
}
```

Add `"mediaFile": "data/samples/note.ogg"` with `"type": "audio"` to exercise transcription.

Other flags: `--config FILE` (alternative rules), `--dry` (connected, but no action runs),
`--help`.

## Try a rule against a written transcript

No audio needed:

```bash
node tools/try-transcript.mjs "we need three cartons of red" "Orders" "Mario"
```

It runs the given transcript through the real rule engine and prints which rules fired and
which actions would run. It is the fastest way to answer "why didn't it fire?" from a
terminal.

## Without a real voice note

```bash
powershell -ExecutionPolicy Bypass -File tools/make-sample-audio.ps1
```

It generates `data/samples/note.ogg` using a Windows voice, converted to opus like real
WhatsApp voice notes.

## Fake servers

```bash
node tools/mock-ha.mjs 8199      # fake Home Assistant, logs every call
node tools/web-dev.mjs           # web panel only, no WhatsApp connection
```

The fake Home Assistant is how the Home Assistant actions are tested: they print the exact
services and bodies that would be sent.

## What runs in CI

Every push builds and validates:

| step | what it checks |
|---|---|
| syntax | every source file parses |
| example rules | they load and the engine responds |
| Home Assistant actions | all of them, against the fake server |
| home commands | that "turn on the bedroom light" really calls `light.turn_on` on `light.bedroom` |
| web panel | endpoints, auth, and that broken YAML is refused without touching the file |
| editor | highlighting, indentation and auto-indent, unit-tested |
| rule engine | matching, `\b` traps, capture groups, placeholder rendering |
| telegram mirror | every kind of message becomes the right Telegram call, media included |
| Docker image | it builds, and it is published to GHCR |

The unit tests are plain Node scripts with no test framework, so you can run any of them
directly:

```bash
node tools/rules-test.mjs
node tools/telegram-test.mjs
node tools/editor-test.mjs
node tools/web-smoke.mjs
```
