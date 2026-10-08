# Actions

Actions run in order, each with a timeout. **Errors are isolated**: one failing action does
not stop the others, and every result is reported in the log.

Actions can also **leave a value for the ones that follow**: `ha.assist` puts Assist's
answer in `{{assist}}` (see [Assist](home-assistant.md#assist-talking-to-it)), and the next
action of the same rule can use it.

| `type` | parameters | what it does |
|---|---|---|
| `log` | `level`, `message` | writes to the log |
| `notify.console` | `message` | prints to the terminal, highlighted |
| `notify.telegram` | `message`, `chatId?`, `parseMode?` | Telegram message |
| `mirror.telegram` | `chatId?`, `prefix?`, `parseMode?`, `asDocument?`, `silent?`, `threadId?`, `token?`, `timeoutMs?` | mirrors **all** of a message — text and media — to a Telegram chat |
| `webhook` | `url`, `method?`, `headers?`, `body?` | JSON POST (full payload if `body` is absent) |
| `ha.notify` | `service`, `message`, `title?`, `data?` | phone notification (shortcut for `notify.*`) |
| `ha.button` | `button` | presses a `button.*` entity |
| `ha.script` | `script`, `variables?`, `wait?` | runs a script, with variables |
| `ha.automation` | `automation` | triggers an automation |
| `ha.action` | `entityId`, `action`, `data?` | generic action: `light.living_room` + `turn_on` |
| `ha.service` | `domain`, `service`, `data?`, `entityId?` | raw Home Assistant service call |
| `ha.webhook` | `webhookId?`, `body?` | calls a Home Assistant webhook |
| `ha.assist` | `text`, `language?`, `agentId?` | asks **Assist**, leaves the answer in `{{assist}}` |
| `appendJsonl` | `file`, `fields?` | appends one JSON line to a file |
| `reply` | `text` | writes into the chat — **off** unless `ALLOW_REPLY=true` in `.env` |
| `shell` | `command`, `cwd?`, `timeoutMs?` | runs a local command (requires `settings.allowShell: true`) |

Home Assistant specifics are in [home-assistant.md](home-assistant.md).

> The `reply` action is the one thing here that can break in a way you cannot repair from the
> server: read the warning in the README before turning it on
> ([the exception](../README.md#the-one-exception-allow_reply)).

## Mirroring a chat to Telegram

`notify.telegram` sends a **notice** you compose yourself. `mirror.telegram` is the other
way round: it copies the message as it is — text, photo, voice note, video, document,
sticker — into a Telegram chat. One rule that matches the chat is the whole bridge:

```yaml
- id: mirror-orders-to-telegram
  name: "Orders → Telegram"
  priority: 1
  continue: true
  match:
    chatName: Orders        # no "type": every kind of message fires
  actions:
    - type: mirror.telegram
      chatId: "-1001234567890"   # default: TELEGRAM_CHAT_ID from .env
      threadId: 15               # a topic of a forum group (see below)
      parseMode: HTML
      prefix: "<b>{{sender}}</b> - "
```

Each message type goes to its natural Telegram call: `sendMessage`, `sendPhoto`,
`sendVoice` (voice notes, in ogg/opus), `sendAudio`, `sendVideo`, `sendDocument`,
`sendSticker`. A sticker refused by Telegram (animated ones) is resent as a file rather
than lost. Messages with nothing to send — locations, contacts, polls — arrive as a short
line that says what they are.

| parameter | default | what it does |
|---|---|---|
| `chatId` | `TELEGRAM_CHAT_ID` | destination chat (groups start with `-100…`) |
| `prefix` | `{{sender}}` | text prepended to the content; `prefix: false` removes it |
| `parseMode` | — (plain) | `HTML`, `MarkdownV2` or `Markdown`: lets you write markup in `prefix` |
| `asDocument` | `false` | send photos and stickers as files, without Telegram compression |
| `silent` | `false` | deliver without a Telegram notification |
| `threadId` | — | post into one topic of a Telegram **forum** group |
| `token`, `timeoutMs` | from `.env` | override the bot and the network timeout |

With `parseMode` set, the markup written **in the rule** (`<b>`, `*…*`) is sent as-is,
while the **values** — the sender name, the message text, the transcript — are escaped
automatically. Otherwise a contact named `A & B` would break the message, or a text
containing `<` would be rejected by Telegram.

Notes worth knowing:

- The **media is downloaded** when the mirror needs it, not before: a text-only chat
  downloads nothing. It respects `settings.mediaRetentionDays`.
- Telegram caps a text at **4096** characters and a caption at **1024**: longer ones are
  truncated with a `…`, never refused. The media itself still arrives in full.
- `threadId` is a topic's **message thread id** (an **action** parameter, not a match
  criterion — `npm run check` flags unknown keys left inside `match`). Open the topic →
  ⋮ → *Topic Info*: the link shown there looks like `t.me/c/<internal-id>/<thread-id>`.
  The **second** number is the `threadId`; the first is the group's internal id, so the
  destination is `chatId: "-100<internal-id>"`. Without `threadId` (or with `General`
  selected) the copy lands in the group's **General** topic, and the bot needs permission
  to post in topics.
- Messages **you** send are skipped unless `settings.processOwnMessages: true`; replies,
  edits and protocol messages are not mirrored by design (see
  [the read-only mode](../README.md#read-only-mode)).
- The bot must already be able to write in the destination chat: send it `/start` in a
  private chat, or add it to the group.

## Placeholders

Inside any string:

`{{content}}` (the text, or the transcript for a voice note — the most used one),
`{{text}}`, `{{transcript}}`, `{{chat}}`, `{{chatJid}}`, `{{sender}}`, `{{senderJid}}`,
`{{rule}}`, `{{ruleName}}`, `{{type}}`, `{{label}}` / `{{confidence}}` (from
classification), `{{fileName}}`, `{{seconds}}`, `{{date}}`.

One more, and it is a different kind of thing: `{{assist}}` does not come from the message
but from the action before it in the same rule — it is what Home Assistant Assist answered.
See [Assist](home-assistant.md#assist-talking-to-it).

A misspelled placeholder (`{{transcriptt}}`) **stays visible** in the message instead of
vanishing, and `npm run check` reports it.

## Capture groups: words taken from the message

`{{1}}`, `{{2}}`… and `{{name}}` are the **capture groups** of the `textMatch` regex. They
let you reuse a word found in the message inside an action:

```yaml
- id: home-turn-on-light
  match:
    senderJid: "@me"
    type: [text, audio]
    textMatch:
      mode: regex
      flags: iu
      patterns:
        - '(?<![\p{L}\p{N}])turn on the (?<room>[\p{L} ]+?) light(?![\p{L}\p{N}])'
  transcribe: true
  actions:
    - type: ha.action
      entityId: "light.{{room}}"      # "turn on the bedroom light" -> light.bedroom
      action: turn_on
```

`npm run check` also lists the groups it finds: `✓ all {{...}} placeholders are valid
(groups: room)`.

## Webhook payload

With no `body`, the `webhook` action sends the whole context:

```json
{
  "ts": "2026-09-30T07:00:00.000Z",
  "rule": { "id": "orders-voice", "name": "Orders — voice notes" },
  "chat": { "jid": "…@g.us", "name": "Orders", "isGroup": true },
  "sender": { "jid": "…@s.whatsapp.net", "name": "Mario" },
  "message": { "id": "…", "type": "audio", "timestamp": 1790745070020, "text": "", "caption": "", "ptt": true },
  "transcript": "we need three cartons of red",
  "content": "we need three cartons of red",
  "classification": { "label": "order", "confidence": 0.97, "reason": "…" },
  "mediaFile": "data/out/audio/…"
}
```

## Payload shape of `appendJsonl`

Without `fields` you get the same payload as the webhook, one JSON object per line. With
`fields` you choose:

```yaml
- type: appendJsonl
  file: data/orders.jsonl
  fields:
    quando: "{{date}}"
    chi: "{{sender}}"
    cosa: "{{transcript}}"
```

`file` is relative to the project root, so in Docker `data/orders.jsonl` lands in
`/app/data/orders.jsonl` — inside the volume, not in the image layer.
