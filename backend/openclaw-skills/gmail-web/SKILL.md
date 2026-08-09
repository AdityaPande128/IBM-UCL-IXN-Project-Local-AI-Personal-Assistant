---
name: gmail-web
description: "Read and write the user's email in the browser, which is already signed in. Use for every question or instruction about the user's mail — whether someone replied, what someone asked, when and where something is happening, and sending or drafting a reply. Prefer this over any other mail tool: it answers in seconds where the others take a minute."
---

# gmail-web

The browser is already signed into the user's mailbox. Use the `browser` tool.

## Search

Searching is a URL, so it needs no clicking and no typing:

```
action: open
url: https://mail.google.com/mail/u/0/#search/QUERY
```

Then read the page:

```
action: snapshot
```

Each result is one `row` whose text already contains the sender, the subject,
the date and the first line of the message. Very often that is the whole answer
and nothing further needs opening.

`QUERY` accepts the mail service's own operators, and they are worth using:

- `sandhya` — anything mentioning her
- `from:sandhya` — mail she sent
- `to:sandhya` — mail the user sent her
- `from:sandhya after:2026/07/01` — narrow by date
- `august 15` — mail mentioning a date in the text

To see what the user themselves sent, `to:NAME` is the search — not the inbox.

## Reading one message

Click the row's ref from the snapshot, then snapshot again:

```
action: act  → click the row ref
action: snapshot
```

The open message shows the full body and the sender's address.

## Answering the user

Quote what is on the page — the real date, the real address, the real wording.
If the search returns nothing, say nothing matched. Never answer about the
newest message in the mailbox when the question was about a particular person.

## Replying and sending

1. Open the message being replied to (above), so the address and subject come
   from the message rather than from memory.
2. Click the **Reply** control.
3. Type into the message body — the large empty box, not the To field and not
   the search box.
4. Click **Send**.

When the user said *draft*, *prepare* or *write*, stop after typing and do not
click Send. When the user said *tell*, *reply*, *send* or *answer*, click Send.

When the user dictated words, type their words exactly.

## Whether someone replied

Two searches:

```
https://mail.google.com/mail/u/0/#search/to:NAME     → what the user sent, and when
https://mail.google.com/mail/u/0/#search/from:NAME   → what came back, and when
```

A reply is a message from them dated later than the one the user sent.

## If the page is not the mailbox

If a snapshot shows a sign-in page or something unrelated, say so and stop.
Do not type credentials and do not attempt to sign in — that is the user's to do.
