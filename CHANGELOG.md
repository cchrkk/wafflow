# Changelog

## Unreleased

### Added

- **`mirror.telegram`: a whole WhatsApp chat, mirrored onto Telegram.** One rule that
  matches the chat (`match.chatName` or `chatJid`, no `type`) copies every message as it
  is: text, photos, voice notes (as Telegram voice messages), audio, video, documents,
  stickers. The media is downloaded only when the mirror needs it, and respects
  `mediaRetentionDays`. Captions are prefixed with the sender (`prefix`, default
  `{{sender}}`); `asDocument`, `silent`, `threadId` and a per-action `chatId` are
  supported. Long texts and captions are truncated at Telegram's limits instead of being
  refused, and animated stickers fall back to being sent as files.
  See [examples/13](examples/13-mirror-chat-to-telegram.yaml) and
  [docs/actions.md](docs/actions.md#mirroring-a-chat-to-telegram).

### Fixed

- **`npm run check` now flags unknown keys left inside `match`.** The engine ignores them
  silently, so a `threadId` written under `match` (it is an action parameter) made every
  copy land in the group's General topic with no error anywhere.

### Added (mirror.telegram)

- **`parseMode`** (`HTML`, `MarkdownV2`, `Markdown`): markup written in `prefix` is sent
  as-is, while the sender name and message text are escaped automatically.

## 2.0.0 — 2026-09-30

### Renamed

- **wa-categorizer is now wafflow.** New identity, new logo, same engine. The
  repository is now `cchrkk/wafflow` (the old URL redirects), the image is
  `ghcr.io/cchrkk/wafflow` (tags `2.0`, `2.0.0`, `latest`), and everything that
  prints its name — banner, health, the panel — says `wafflow`.
- The version jumps to 2.0.0 because the image path changed: anything pulling
  `ghcr.io/cchrkk/wa-categorizer` must switch to the new name. The JSON logs and
  the rules files are unchanged: a >1.0 config works as-is.

### Changed

- **New logo** (assets/logo.svg): the green speech bubble, kept from the
  original artwork (metadata stripped, ~85 KB lighter).

## 1.0.1 — 2026-09-30

### Fixed

- **A restart no longer re-reports a session it has already reported.** WhatsApp hands back
  the messages it already failed on when the instance reconnects, so ten failures pile up in
  the first minute of every start and the per-session alert fired again: one Telegram message
  per deploy, about a session reported minutes earlier. The session state now survives the
  restart through `data/health.json`. A session that had been quiet for half an hour is not
  restored, so a genuinely new break is still heard.

### Changed

- **The logs are readable now.** One line per event, without `pid` and `hostname`, coloured
  only when the output is a terminal — in a container ANSI escapes are just noise. The message
  carries the context that used to sit in separate fields:

  ```
  [16:34:42] INFO: rule fired: Orders — text with a quantity — "Orders" from Mario text
  ```

  The image ships with `LOG_PRETTY=true`; `LOG_PRETTY=false` gives the JSON back for a log
  collector.
- `GET /api/log` is `GET /api/messages` now — it returns the messages the program read, not
  its log, and the name said otherwise.

### Added

- **The log, in the panel.** The last 500 lines are kept in memory and shown in the page, live
  if you want it. And every test in the test bench carries **the log it produced**, so the
  `[dry-run] action ...` lines appear next to the result instead of having to be hunted in the
  terminal.

## 1.0.0 — 2026-09-30

First release worth a number.

A read-only WhatsApp client that **categorises incoming messages with YAML rules** and runs
**actions** based on them — voice-note transcription, Telegram, Home Assistant, webhooks,
files — with a web panel for the rules.

### Rules

- Match on chat, sender, type, text and transcript, with plain `contains`, exact values or
  regexes (and Unicode boundaries for accented words).
- Priorities, `continue`, optional LLM classification, and `config/rules.d/` so one file is one
  case, copied from `examples/` without pasting anything.
- Capture groups become placeholders: `entityId: "light.{{room}}"`.
- Twelve examples, one per use case, disabled by default.

### Actions

Telegram, webhooks, JSONL files, local commands, and Home Assistant: notifications, services,
buttons, scripts, automations, webhooks — plus **Assist**. `ha.assist` asks the conversation
agent and leaves the answer in `{{assist}}` for the next action of the same rule.

### Web panel

Editor with highlighting and **validation before saving** — a broken file never reaches the
disk — plus a test bench that says, for every rule, which criterion failed, including the ones
that did not fire. It can test rules that match on the jid, with `@me` resolved the way the
rules resolve it.

### Read-only, unless you say otherwise

- No read receipts, no presence, no history download. Not configurable, by design.
- Sending is the one exception, and it lives only in `.env` (`ALLOW_REPLY`) — never in a rules
  file, because the panel can rewrite those. Read the warning in the README first: an
  unofficial client is weakest exactly there.

### Health

- `data/health.json` holds what the running process is doing and `--health` judges it; the image
  carries a `HEALTHCHECK`, so `docker ps` says `healthy` / `unhealthy` on its own.
- It reports messages arriving that cannot be decrypted — **one alert per session, not a
  barrage** — which is how session problems stop being invisible.
- libsignal prints its failures, and its session dumps (private keys included), straight to
  `console`, ignoring `LOG_LEVEL`. The program intercepts them: the failures are counted, the
  dumps are dropped.

### Fixed along the way

- **`Tab` duplicated the whole file** in the panel instead of indenting it: the operation
  carried the wrong range, so the document doubled on every press until the browser tab died.
  There is a single application point now, and the tests simulate what the textarea does.
- **A tab used as indentation** is converted to spaces instead of being refused with a message
  about a line you cannot see.
- **A `textMatch` pattern that is empty** — `- !word` is a YAML tag, not a string, and YAML
  turns it into `""` — made a rule match every message. It is refused at load time now; one of
  these opened a gate on every message, for real.
- `markRead` is refused rather than ignored.

### Docker

Public image on GHCR, built by GitHub Actions on every push to `main` and on tags; the server
only pulls. Releases are published as `1.0.0` and `1.0`.

---

Built by prompting an AI and testing everything for real — including the mistakes, which are
in [troubleshooting](docs/troubleshooting.md) with their cause. See
[How this was built](README.md#how-this-was-built).
