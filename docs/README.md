# Documentation

The short version is in the [README](../README.md). Everything else is here.

| Document | What is in it |
|---|---|
| [install](install.md) | requirements, first run and QR, auto-start on Windows, Docker |
| [rules](rules.md) | every match criterion, field forms, the `\b` trap, the LID address book |
| [actions](actions.md) | available actions, placeholders, capture groups |
| [transcription](transcription.md) | Groq/OpenAI or local whisper |
| [Home Assistant](home-assistant.md) | token, examples for each action, testing without risk |
| [web panel](web-panel.md) | rule editor, test bench and the WhatsApp session with its QR |
| [data and media](data-and-media.md) | where everything goes and when it is deleted |
| [testing](testing.md) | simulations, fake servers, what runs in CI |
| [troubleshooting](troubleshooting.md) | known limits and failures already hit, with the cause |

## Where to start

1. **Get connected** → [`install.md`](install.md).
2. **One rule that works** → open the web panel ([`web-panel.md`](web-panel.md)), copy a
   file from [`../examples/`](../examples/), and send yourself a message.
3. **Understand why it didn't fire** → the panel's test bench tells you which criterion
   blocked the rule. It is by far the fastest route.

## How this documentation is written

Every claim here was **verified in practice**, not deduced. Where something has not been
tested, it says so. Several warnings come from real mistakes made while building this —
the `\b` trap with accented characters, the YAML file that silently fails to reload, the
web panel overwriting `.env` — and they are written the way they would have helped
whoever fell into them.
