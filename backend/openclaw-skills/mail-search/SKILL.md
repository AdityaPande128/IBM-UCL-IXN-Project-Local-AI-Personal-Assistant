---
name: mail-search
description: "Search the user's own mailbox (Apple Mail, already signed in) for messages from or about a person, address or topic. Use for any question about the user's email — whether someone replied, what someone asked, or when and where something is happening."
---

# mail-search

Reads the user's mail through the mail client they are already signed into. No
credentials, no browser, no login.

Run it with `exec`:

```bash
python3 ~/.openclaw/workspace/skills/mail-search/run.py --query "sandhya"
```

Options:

- `--query` — a first name, an email address, or words from a subject. Required.
- `--mailbox inbox` (default) for mail the user received; `--mailbox sent` for
  mail the user sent.
- `--limit 8` (default) — how many messages, newest first.

Each result carries the real date, sender address, recipient, subject and the
start of the body.

## Answering from it

Quote what comes back. The date, the address and the wording are all in the
output — use those rather than describing the message from memory. If nothing
matches, say so; do not answer about the newest message in the mailbox when you
were asked about a particular person.

## Whether someone replied

Two searches, in this order:

```bash
python3 ~/.openclaw/workspace/skills/mail-search/run.py --query "sandhya" --mailbox sent --limit 3
python3 ~/.openclaw/workspace/skills/mail-search/run.py --query "sandhya" --limit 5
```

The first shows what the user sent them and when; the second shows what came
back. A reply is a message from them dated later than the one the user sent.

## Speed

The mailbox holds about ninety thousand messages, so one search takes roughly a
minute. That is expected — wait for it. Do not run the same search twice.
