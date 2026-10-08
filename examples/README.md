# Rule examples

One file per use case, each self-contained, with a title that says what it does.

**How to use them:** copy the file you need into `config/rules.d/` (or on the server,
into `/data/stacks/wafflow/config/rules.d/`), open it and set `enabled: true`.
The program loads them all together in alphabetical order — there is nothing to paste
into `rules.yaml`.

Every example ships **disabled**, so copying them cannot make anything fire.

```bash
mkdir -p config/rules.d
cp examples/01-every-message-from-a-person.yaml config/rules.d/
# then in the file: enabled: true
npm run check
```

| File | What it does |
|---|---|
| [01-every-message-from-a-person](01-every-message-from-a-person.yaml) | every **text** from one contact, no content filtering |
| [02-every-voice-note-from-a-person](02-every-voice-note-from-a-person.yaml) | every **voice note** from one contact, transcribed |
| [03-voice-notes-filtered-by-keywords](03-voice-notes-filtered-by-keywords.yaml) | voice notes, but only if they say certain things |
| [04-voice-notes-in-a-group](04-voice-notes-in-a-group.yaml) | voice notes in a group chosen by name, filtered |
| [05-classify-work-or-other](05-classify-work-or-other.yaml) | the LLM decides: work / chatter / spam |
| [06-home-assistant-commands](06-home-assistant-commands.yaml) | "turn on the bedroom light" → `light.turn_on` |
| [07-received-documents](07-received-documents.yaml) | PDFs and attachments, with the file name |
| [08-moderate-links-in-groups](08-moderate-links-in-groups.yaml) | links in groups → webhook |
| [09-notes-to-myself](09-notes-to-myself.yaml) | what you write yourself, to Telegram or a file |
| [10-orders-text](10-orders-text.yaml) | orders chat: written messages with a quantity |
| [11-orders-voice](11-orders-voice.yaml) | orders chat: voice notes, same keywords |
| [12-assist-chat](12-assist-chat.yaml) | talk to Home Assistant Assist and get the answer somewhere |
| [13-mirror-chat-to-telegram](13-mirror-chat-to-telegram.yaml) | copy a whole chat — text **and** media — into Telegram |

To understand **why** a rule did not fire, use the web panel's test bench, or:

```bash
node tools/try-transcript.mjs "the transcript" "Chat name" "Sender"
```

Full reference for every field: [docs/rules.md](../docs/rules.md).
