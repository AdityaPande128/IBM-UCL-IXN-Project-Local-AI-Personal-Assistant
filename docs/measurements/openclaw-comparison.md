# The same seven requests, given to a general agent runtime

Measured 8 August 2026. Both systems on the same machine, the same mailbox, the
same seven English sentences, and the **same model doing the browsing** —
`Qwen3-4B-Instruct-2507-4bit`, served locally to both.

Both were entered through the same door. `executeIntent(text)` routes and plans;
`executeIntent(text, {executor: 'openclaw'})` hands the sentence to the OpenClaw
agent instead. One option is the only difference in the harness.

OpenClaw ran on its own signed-in browser profile, with `browser-automation` and
`gmail-web` enabled, `--thinking off`, and the gateway path rather than the
slower embedded runner. No skills were trimmed: the user's position was that the
full skill set is the product, so the full skill set is what was measured.

## Result

**Jarvis 6/7 in 9.5 min. OpenClaw 1/7 in 45.2 min.**

| # | Jarvis | | OpenClaw | |
|---|---|---|---|---|
| 1 | correct, verified | 109.7 s | silent — no answer produced | 605.4 s |
| 2 | correct | 65.7 s | correct | 127.0 s |
| 3 | correct | 44.1 s | confidently wrong | 326.3 s |
| 4 | correctly found nothing | 143.9 s | declined the task | 54.3 s |
| 5 | refused to write | 95.6 s | timed out | 604.6 s |
| 6 | sent, verified | 69.5 s | nothing sent | 604.4 s |
| 7 | sent, verified | 37.7 s | claimed sent, sent nothing | 387.0 s |

Jarvis's 6/7 counts case 7 after two defects were fixed the same day; its single
unbroken pass was 5/7. Case 5 fails in both systems. Every claim of having sent
or drafted anything was checked by reading the mailbox directly, not by
believing the run's own report — and OpenClaw wrote nothing at all, across all
three cases that were supposed to.

## Why "success" in the raw log means nothing

The harness records `success` when the OpenClaw CLI exits 0, which it did seven
times out of seven. Six of those seven produced no correct outcome. Any
comparison that trusts an agent's own status field will report 7/7 here.

Worse for latency: **case 4 is OpenClaw's fastest case at 54.3 s, and it made
zero tool calls.** It answered "I don't have access to order tracking" from the
model's own assumptions, without opening anything. A mean-latency comparison
across cases flatters whichever system gives up quickest. Time has to be
reported conditioned on a correct outcome or it inverts the ranking.

## What the failures were

Read from the session transcripts — every tool call OpenClaw made is recorded.

| failure | cases | tool pattern |
|---|---|---|
| never perceived the page | 1, 6 | `open` × 11, `open` × 10 — **zero** `snapshot` |
| perceived, never acted, reported success | 7 | `open` × 2, `snapshot` × 3, zero `type`/`click` |
| never attempted | 4 | no tool calls at all |
| context exhausted by its own observations | 5 | `open` × 3, `snapshot` × 4, then timeout |
| wrong surface | 3 | searched mail for a calendar question |
| success | 2 | `open` × 2 → `snapshot` × 2 |

The `browser` tool offers `read`, `snapshot`, `content`, `text`, `click`, `type`,
`find`. In cases 1 and 6 the model used exactly one of them, `open`, repeatedly,
against the same URL — opening eleven and ten tabs respectively. What it gets
back from `open` is a **handle**: `targetId`, `title`, `wsUrl`. Not the page. To
see anything it must separately choose to snapshot, and it did not. Having
nothing to answer from, it reissued the only call it had seen succeed until the
600-second agent timeout.

Case 2 shows the same model doing it correctly — `open → snapshot` — on the same
site, minutes apart. **Whether it remembers to look at the page is not
determined by the prompt.** Of the four cases where it touched the browser at
all, it failed to perceive in two.

## The per-turn floor

A one-word reply — "reply with the single word: ready" — took **51 s of model
time**. The request was 33 characters. The preamble was 7,566 tokens:

| section | chars |
|---|---|
| tool JSON schemas (34 tools) | 31,830 |
| system prompt | 25,059 |
| skills (14 entries) | 5,601 |
| the request | 33 |

That is paid on **every turn**, so a task needing ten browser actions pays it ten
times. It is the same coupling that retrieval was built to break in this system —
prompt size growing with installed capability until routing degrades — arriving
through a door retrieval did not cover. Encountering it independently in a mature
framework is the strongest available evidence that the problem is general and not
an artefact of one implementation.

It also bounds what is left for the work: with a 32k window and a 20k reserve,
**~5.2k tokens of prompt budget remain** after the preamble. A Gmail snapshot
does not fit in that. Case 5 was perceiving correctly and drowned in its own
observations — which is why this system caps an observation at 60 elements and
4,000 characters. Bounding perception is not a performance tweak; it is what
makes multi-step work fit at all.

## Tuning versus architecture

The obvious objection: Jarvis was tuned against these seven sentences over days —
planner rules 7b/7c/7d were written for them, all six recipes were written from
verified runs of them, and a dozen predicates in `webAgent` each exist because of
a specific failure on a specific one. OpenClaw got them cold. A raw score
comparison is not a fair fight.

The failure taxonomy answers the objection, because it separates what prose can
fix from what it cannot:

- **Case 3 is knowledge.** The calendar day URL written into a markdown file
  would very likely fix it.
- **Cases 1, 4, 5, 6 and 7 are structural.** Perception being an optional tool
  call, nothing requiring a look before answering, perception being unbounded,
  and nothing checking a claimed outcome against the page. Written guidance can
  make the model *more likely* to snapshot. It cannot make perception
  unconditional, and with a 4B the difference between a probability and a
  guarantee is most of the outcome.

Five of six failures survive any amount of prompt engineering. That is a claim
about mechanisms rather than a scoreboard, and it is the one worth defending.

## What this does not establish

Both systems were measured on one mailbox, on a site one of them was tuned
against. The structural claims above are arguments for why the advantage should
generalise; they are not yet evidence that it does. The deciding experiment is
the same task set on sites neither system has seen, where this system's
Gmail-shaped recipes and mail-and-calendar planner rules are dead weight and only
the structural properties remain.
