# Distillation: tier 2 to tier 1

Measured 1 August 2026 with `node backend/tools/distil-devset.js`, against the
local fixture site and the resident engine model, `granite-4.1-8b-4bit`.

## What this phase claims

Every capability the system had before this was put there by someone. A skill
exists because it was written; browsing runs at tier 2 because a web page is
opaque and will stay opaque. Distillation is the system doing the descent
itself: it reads its own execution history, finds a sequence of actions that
achieved a goal, and writes it down as a procedure that replays with no model
in the loop at all.

Nothing is trained and no weights move. What happens is closer to what a person
does on the third visit to a council website — stop reading the page, and go
straight to the two links that worked last time.

| | |
|---|---|
| tier 2 | observe, ask the model, act. Handles a site it has never seen. One model call per action. |
| tier 1 | replay recorded actions against named elements. Handles nothing it was not shown. No model. |

## Result

Two procedure families. Each is taught from two runs, then the **same third
task** is run both ways — not compared against the training runs, which were
slower for reasons that have nothing to do with tiers, since they were finding
the route rather than following it.

| | |
|---|---|
| distilled | **2/2** |
| replayed successfully | **2/2** |
| landed on the page that answers the question | **2/2** |
| mean speedup on the identical task | **63.8x** |
| model calls removed | **5 across 2 tasks** |

| family | tier 2 | tier 1 | |
|---|---|---|---|
| catalogue search | 12782 ms, 3 model calls | **174 ms, 0** | 73.5x |
| opening hours | 8615 ms, 2 model calls | **159 ms, 0** | 54.2x |

End to end through the planner and executor, `procedure.bookshop-about ->
answer` returned in **2653 ms**, of which 160 ms was the web work and 2492 ms
was the single `answer` call. The same request through `web.browse` costs about
12.7 s before `answer` runs at all.

The multiplier is flattered by the fixture and should not be quoted on its own.
Replay time on a loopback server is almost entirely browser overhead; against a
real site it would be page-load time, which is the same page-load time tier 2
pays. **The honest figure is the one that does not depend on the network: every
model call in the loop is removed, and what is left is the cost of loading the
pages.**

## The three questions distillation has to answer

### What makes two runs the same procedure?

Not the goal — the goals differ, that is the point. Not the raw trace either. A
run in which the model fumbled a ref and retried has more steps than one where
it did not, and they are the same procedure.

What is compared is the sequence of actions that actually changed the page,
each identified by what it acted on rather than by the ref it used at the time.
A run's mistakes are not part of the procedure it discovered, so **the distilled
recipe is routinely shorter than any of the runs it came from**: the catalogue
search distils to two steps from runs of three model calls, and the opening
hours to one step from runs of two.

### Which arguments are constants of the site, and which came from the request?

This cannot be answered from one run. Given a single trace in which the agent
typed "The Long Field" into a search box, there is no way to tell whether that
is what this procedure always types or what it typed that time.

Given two runs that typed different things, the answer is immediate and it comes
with its own evidence. Align the two requests word by word; what differs between
them is a span, and if what was typed is found inside that span, the typed value
came from the request and the procedure has a parameter. If the requests are
identical and so is the typed text, it is a constant, and the procedure takes no
arguments — which is a perfectly good procedure, and is what the opening-hours
family distils to.

**Variation is what identifies a parameter.** That is a considerably better
reason for requiring two examples than "one might have been luck", and it means
the threshold is not a tunable guess: below two, the question is not hard, it is
unanswerable.

The parameter is then named after the field it fills, read off the page. The
fixture's search box is labelled "Title or author", so the learned capability is
`procedure.bookshop-about(title: string!)` — a word the site chose, which is the
word the user is most likely to use as well.

### When is a procedure wrong to promote?

Six rejections, each a case where something replayable could have been produced
and should not be. All of them refuse rather than guess, because a fast path
that does the wrong thing confidently is worse than no fast path: the tier-2
loop it replaced would at least have looked at the page.

| | |
|---|---|
| an action in the run was refused | a route that walked into the policy layer once was chosen without regard to it, and a cleaned-up version of it running unsupervised is the wrong direction |
| a typed value did not come from the user | it came off a page, and the characters were deliberately not recorded |
| the requests differ in a way the actions do not account for | one asked about the cafe and one about the shop; a procedure ignoring the difference answers the wrong one at speed |
| a typed value varied without varying with the request | there is no rule that would reproduce it on a third request |
| the requests have almost nothing in common | two unrelated jobs that happen to be a search on the same site |
| the run did not end in a completed goal | not a procedure for reaching a goal it did not reach |

## What the runs found

**The trace was one field short.** Phase 7 recorded browse iterations as child
plans specifically so this phase could consume them, and every action was
recorded with the ref it used — `e3`, an attribute stamped during one
observation and cleared at the start of the next. Nothing in the recorded
sequence could be carried out again. What survives a page being re-rendered is
what a person would use to point at a control: its role and its accessible name.
Both are now recorded, along with an ordinal when a page has more than one
control with the same name — a page with three "Add to basket" buttons is
ordinary, and the ref resolved that ambiguity during the run without surviving
it.

**The typed text is recorded only when doing so discloses nothing new.**
Distillation needs the actual characters, and the trace's standing rule is that
it records what happened, not the material. Both hold at once for exactly the
text that passed the provenance test: every word of it is already in the
request, and the request is stored in full one table over. Anything else is
redacted, and a run containing a redaction is not distillable — which is the
right outcome rather than a limitation.

**The system named a capability the model could not type.** The first version of
the naming put the surface in front of the words, which for the fixture produced
`procedure.127-0-0-1-bookshop-about`. Asked to use it, the planner emitted
`procedure.127-0-0-1-127-0-0-1-127-0-0-1-…` until it ran out of tokens, twice,
and the request failed after a minute. A run of digits and hyphens has no word
structure to hold on to, and repeating it is what a small model does with those.

The general point is about self-extension rather than about naming: **when a
system invents its own capabilities, it also invents the identifiers a model
will have to reproduce.** An identifier chosen by a machine has to be one a
machine can copy. Procedures are now named in words taken from what they do,
with a host label only when the host has letters in it; the surface is still
stated, in the description, where it is prose to be read rather than a token to
be transcribed.

**A rule about learned procedures cost a case, so it is only in the prompt when
there are learned procedures.** Telling the planner to prefer a distilled
procedure took six lines. Adding them turned "convert all the heic photos on my
desktop to jpeg" from a correct gap into a plan that searched, read, launched
Preview, and declared in `missing` that it could not convert anything. Nothing in
the added rule is about HEIC or about gaps — it is longer prompt, and what it
crowded out was rule 9, *do not plan the first half of a job you cannot finish*.

This is the effect the router measured in Phase 2 with a verbose catalogue, and
it has the same fix: say less to a small model. Making the rule conditional is
better than making it shorter. A system with nothing distilled yet now gets a
prompt byte-for-byte identical to the one that was measured without it — checked
by diffing the two — so the cost of the rule is paid only where the rule can pay
for itself.

**Learning from a run required not caring who its parent was.** The feedstock
query asked for successful child plans, meaning browses that ran inside a plan.
A browse run from the bridge or from a bench discovered a route just as well, and
there was no reason to be able to learn from one and not the other. The test is
now `surface`, which is set only by something that operated a website. Replays
set it too and are excluded for a better reason: a replay does not end in a
model declaring the goal met, so it fails the first thing the distiller checks.

## Security

A recipe is not more trusted than the loop that produced it. Every replayed
action goes through the same policy checks, in the same order, with no exemption
for being recorded — asserted by two tests that hold a hand-written procedure to
the rules distillation would never have let it past.

- **A recipe cannot fill a password field.** The procedure is written by hand
  because distillation refuses to produce it; even arriving on disk by another
  route, the structural refusal is unchanged. It is blocked, and the refusal is
  not counted against the recipe's health — otherwise the safety layer would
  quietly retire the system's own capabilities.
- **A recipe cannot be pointed at this machine.** Being a stored procedure earns
  no exemption from the rule that keeps the browser off loopback and RFC1918.

This has a consequence worth stating plainly: **a procedure learned against the
loopback fixture cannot be replayed through the normal execution path at all.**
Running the full planner-and-executor chain on the fixture produced exactly
that — *"127.0.0.1 is on this machine or this network; the browser stays on the
public web"* — and the executor's own handling of a procedure step was confirmed
separately with a catalogue override that permits the fixture, as the tests do.

The justification for gating a recorded sequence as tightly as a live one is
that "it was approved once" is not a property that survives what happens next: a
procedure is a file in a directory the user can edit, its steps were induced
from traces, and a site can change what a control does without changing what it
is called. What a recipe does earn is reviewability, which the loop never had.
Its actions can be read before it runs — `node tools/distil.js --list` prints
them — and that is strictly more checkable than a model's next token.

## Staleness

A procedure is a bet that a website will keep looking the way it looked. Two
choices exist to control how that bet is lost.

**It fails rather than improvises.** If the recorded element is not on the page,
the replay stops and says which control it wanted. It does not click the nearest
thing and it does not fall back to something similar. Measured against a
procedure naming a button that never existed: `stale`, *no button called "Find it
now"*, and the fixture's request log shows nothing was pressed in its place.

**Two consecutive failures retire it.** One is the network or a slow page;
retiring on one would mean forgetting things the system knows every time the wifi
drops. Two in a row is the page having changed. A retired procedure leaves the
catalogue and stays on disk with the error that retired it — what used to work
and stopped is the most informative thing in the store, and diagnosing it is
Phase 9's job, which will need to see the corpse.

Health is written through to disk on every replay and survives a restart, since
the failure mode being guarded against is replaying a broken recipe repeatedly.

## Storage

One JSON file per procedure under `backend/data/procedures/`, not a table in the
trace database, which would have been less code. The reason is that a user
should be able to look at what their assistant has decided it knows how to do,
and disagree with it. `cat` is the interface for that and deleting the file is
the interface for withdrawing consent; neither is available for a row among ten
thousand rows of execution history.

## Regression

| | before | after |
|---|---|---|
| unit tests | 281 | **312** |
| router dev set | 28/28 | **28/28** |
| plan dev set | 16/16 | **16/16** outcome, 11/11 shape, 16/16 hygiene |
| web dev set | 12/12 | **12/12** outcome, 8/8 grounding, 12/12 restraint |
| distillation dev set | — | **2/2** distilled, replayed and correct |
| ClawBench intent accuracy | 42/42 | **42/42** |
| ClawBench mean latency | 5.18 s | 5.18 s |
| capabilities in graph | 35 | **35**, plus one per procedure learned |

Plan dev set median 13.3 s, within the 13.6–16.9 s range this machine produced
across three runs in Phase 7 with no relevant change between them.

The fixture gained one thing that is a change in what it measures rather than a
change in scale: its search results page now depends on what was typed. Without
that, two searches return the same page and a value that came from the request
is indistinguishable from a constant of the site — the induction has nothing to
work with. It also removed some flattery. One web dev set case had been passing
because any search at all reached the answer.

## Caveats

**Two families is a small dev set.** It exercises the parameterised case and the
zero-argument case, which are the two shapes the induction distinguishes, and it
does not begin to cover a site with a login wall, pagination, or a form that
posts. The unit tests carry the rejection cases, which is where the interesting
behaviour is; the dev set carries the end-to-end claim.

**Nothing has been distilled from a real site.** Every procedure measured here
was learned against seven pages of clean markup on loopback, with no advertising,
no cookie banner and no client-side rendering. A real site is where the staleness
machinery earns its place, and it has not been tested there.

**Distillation is a command, not a schedule.** `node tools/distil.js` is run by
hand. A pass that silently grants the assistant new capabilities is exactly the
kind of thing that should wait for the approval surface Phase 10 needs anyway.

**A slot is bound by the planner, and the planner can bind it from anywhere.**
Nothing stops a plan passing the output of a file read into a procedure's search
box. That is not a hole — the executor's disclosure gate sees the joined label
and applies the same origin rule the rest of the web surface uses — but it does
mean the provenance argument at replay time rests on the executor's label rather
than on the words being typed, which is a weaker instrument than the one the
loop uses.

**The planner needs two attempts to use a procedure.** Its first plan is
routinely a single procedure step with nothing consuming the passages, which the
validator rejects with the right complaint and the second attempt fixes. Same
behaviour as `web.read`, same cost: roughly double the planning latency for
requests that reach a learned procedure.

**One procedure per goal shape, and no generalisation across sites.** A recipe
learned on one bookshop says nothing about another, and a recipe for finding a
price says nothing about finding an author even on the same page. That is the
correct conservative reading — but it means the store grows one entry at a time
and only for jobs done at least twice.
