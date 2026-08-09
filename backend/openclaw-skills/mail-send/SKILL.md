---
name: mail-send
description: "Write an email in the user's mail client (Apple Mail, already signed in), either sending it or leaving it as a draft. Use to tell someone something, to reply to a message, or to draft a reply for the user to check."
---

# mail-send

Composes through the mail client the user is already signed into.

Run it with `exec`:

```bash
python3 ~/.openclaw/workspace/skills/mail-send/run.py \
  --to "someone@example.com" --subject "Re: Dinner" --body "Sounds good to me" --send true
```

Options:

- `--to` — the recipient's **email address**, not their name. Required. A bare
  name is refused, because a message addressed to a name reaches nobody while
  looking like it worked. Get the address from `mail-search` first.
- `--subject` — when replying, reuse the original subject prefixed with `Re:`.
- `--body` — when the user dictated words, use their words exactly.
- `--send true` to send now; `--send false` (the default) to leave a visible
  draft.

## Which one to use

`--send true` when the user said tell, reply, send or answer.
`--send false` when the user said draft, prepare or write.

A draft can be undone and a sent message cannot, so when the request is
ambiguous, draft it and say that is what you did.

## Replying to a real message

Search first, so the address and subject come from the message rather than from
memory:

```bash
python3 ~/.openclaw/workspace/skills/mail-search/run.py --query "sandhya" --limit 3
```

Take the `from:` address and the `subject:` from the message you are answering,
then send to that address with `Re: ` in front of that subject.
