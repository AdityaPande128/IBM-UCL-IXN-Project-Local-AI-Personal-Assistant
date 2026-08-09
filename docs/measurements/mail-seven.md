# Seven mail requests, end to end

Measured 8 August 2026 against a real Gmail account in a real browser, planning
on `granite-4.1-8b-4bit` and browsing on `Qwen3-4B-Instruct-2507-4bit`.
Correspondent: a real person, addressed here as `sandhyapandey31@gmail.com`.

Each case is one English sentence handed to `executeIntent`. Nothing tells the
system which site, which capability, or which steps. Two answers were checked
against the mailbox directly rather than against the run's own report, by
reading the message list out of the signed-in profile headlessly.

## Result

**5/7 on the run, 568 s (9.5 min) wall clock. Case 7 fixed and re-run to success
the same day: 6/7.**

| # | request | route | time | outcome |
|---|---|---|---|---|
| 1 | check my email to see if Sandhya has responded to my last email | web.browse + answer | 109.7 s | ✅ correct, verified |
| 2 | what did Sandhya ask me about in her latest email? | procedure.mail → declined → web.browse | 65.7 s | ✅ correct |
| 3 | find out what time and where I have to go on August 15th | procedure.google-calendar-day + answer | 44.1 s | ✅ correct |
| 4 | has my order from Riverside Books shipped yet? | web.browse + answer | 143.9 s | ✅ correct, verified |
| 5 | draft a reply to Sandhya saying "Sounds good to me" | web.browse | 95.6 s | ❌ refused, nothing written |
| 6 | tell sandhyapandey31@gmail.com to meet me at Primrose Hill at 9 PM | web.browse | 69.5 s | ✅ sent, verified in the mailbox |
| 7 | reply to sandhyapandey31@gmail.com saying "Hello, thank you…" | procedure.mail | 34.2 s | ❌ blocked at its own recorded step → ✅ 37.7 s after two fixes, verified |

## The two answers that were checked

Ground truth was read out of the mailbox before the run, so the answers could be
judged rather than believed.

**Case 1 — "has Sandhya responded to my last email?"** The last message from that
address is dated 23 October 2025. The last message to it was sent the same day
as the run. The true answer is *no*, and it is not close.

    REPLY    Based on the retrieved Gmail search results, nothing from Sandhya
             is newer than the last message you sent them, indicating that they
             have not replied to it yet.

This is the case that justifies keeping "has X replied" away from search. A plan
that opens her latest message reads an October 2025 forward about tuition fees
and answers a question about August 2026 out of it. The comparison — what she
sent against what the user sent — is the only thing that answers it, and only
the browse loop does that comparison.

**Case 4 — "has my order from Riverside Books shipped yet?"** There is no such
order in the mailbox. Searching the phrase returns university newsletters and
one unrelated book mailing, matched on the word *Book*.

    REPLY    Based on the provided context, there is no mention of a "Riverside
             Books" order or any shipping status related to it.

The correct answer is a negative, which makes this the only case in the set that
tests whether the system will invent one. It did not. It is also the slowest at
143.9 s, and that is the shape of a negative result: with nothing to find, the
loop spends its budget looking.

## The two failures

Unrelated causes, and only one of them is a defect.

**Case 5 is the request meeting a mailbox that cannot resolve it.** "Sandhya"
matches three different people in this account, one of which is a notification
robot. The loop reached a compose box without having established which of them
the message belonged to, and refused to type:

> these words are meant for the person the request named, and no address on this
> page is theirs — writing them into "Message Body" would put them in somebody
> else's message. Find their message first.

That guard exists because a reply meant for this correspondent was once sent to
a LinkedIn newsletter. It fired correctly. No draft was produced, so the case
fails, and the honest reading is that a bare first name is not enough
information — not that the guard is too strict.

**Case 7 is a defect, and the fix is in this commit.** `mail-reply-to-person`
records a click on "Reply" as its third step. The policy classifies that control
as beginning a message to another person, which the assistant may not do unasked;
the loop weighs that against a *mandate* derived from the user's own sentence,
and the replay computed no mandate at all. So the recipe was refused at the one
step it exists to perform, on a request — "reply to sandhyapandey31@gmail.com
saying …" — about as explicitly a request to press Reply as a sentence can be.

    REPLY    I couldn't do that. "Reply" starts a message to other people, so I
             have not pressed it.

Nothing was sent. The failure was a refusal, not a misfire, which is the right
direction to fail in.

A replay now derives its mandate from the user's own words, carrying the
executor's label, and hands it to the same `checkClick` the loop uses. The policy
is untouched: a request that has been near page content still mandates nothing, a
question still authorises no writing, and a mandate is still about somewhere — a
recipe that strayed off the mailbox cannot press Reply on what it finds there.

**And behind it, a second failure the first had been hiding.** With the click
allowed, the replay reached its final step and reported `no button called "Send"`
on a page displaying one. Read out of the live tree, Gmail's control is called:

    "Send ‪(⌘Enter)‬"

— the keyboard hint and the bidi marks that lay it out are inside the accessible
name. `find` matches a recorded name exactly, so `"Send"` could never match it,
and the recipe was unreplayable from the day it was written.

The fix is in `normaliseName`, not in the recipe. Case and whitespace were
already normalised there because they change without the control changing, and a
keyboard hint is the same kind of thing — it belongs to the page's presentation
of a control, and it moves with the user's platform and locale. This is
canonicalisation rather than loosening: a name is still matched whole, so
`"Search"` still refuses to match `"Search all archived orders"`, `"More send
options"` still resolves to the dropdown and not the send button, and `"Inbox
(24)"` keeps its brackets because a number in brackets is part of a name.

    RERUN    success, 37.7 s end to end, of which 11.8 s was the replay
    VERIFIED a reply on the most recent thread from that address, 4:03 PM,
             in the thread rather than as a new message

Two unrelated defects, one masking the other, both only reachable by routing a
mutating case through a recipe for the first time.

## What the recipes bought, and cost

Prompt size, not speed, is what forced the change. Five mail recipes offered to
the planner as five capabilities produced **three empty plans out of four** — the
same coupling `skillRetriever` was built to break, arriving through a door
retrieval did not cover, because procedures were not subject to it.

Retrieval alone does not fix it. Measured over the seven requests, cosine
similarity does not separate five recipes that differ by verb rather than topic:

    "tell X to meet me at Primrose Hill"   draft 0.513  reply 0.503  send 0.491
    "what did Sandhya ask me about"        draft 0.554  reply 0.539  read  ....
    "what time is it" (negative)           calendar 0.590

The correct recipe ranks third on the first, the wrong one ranks first on the
second, and no floor admits the real calendar case at 0.539 while rejecting
"what time is it" at 0.590. Embeddings see the shared topic; the differing verb
is what matters.

Folding them into one `procedure.mail(action: read|search|reply|draft|send)`
entry took the catalogue back to two procedure entries and routing to **7 plans
out of 7**. The verb choice moves from cosine similarity to an 8B model picking
from a labelled enum, which is a decision it is reliable at.

Against the previous measurement of **6/7 in 9.2 min** with no mail recipes at
all, this run is 5/7 in 9.5 min. The regression is entirely case 7 — the first
mutating case ever routed through a recipe, and the case that exposed the missing
mandate.

## Timings by tier

    procedure.google-calendar-day   44.1 s  end to end, of which ~20 s planning
    procedure.mail (declined)        <1 s   refused before opening anything
    web.browse (read-only)          65–144 s
    web.browse (writing)            69–96 s

A recipe replay is 2–8 s of browser work. Everything else in a recipe case is
routing and planning, which no recipe shortens.
