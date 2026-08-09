# Planning

Measured 31 July 2026 with `node backend/tools/plan-devset.js`, against the live
capability graph (33 capabilities: 3 builtins and 30 installed skills) and the
resident engine model, `granite-4.1-8b-4bit`.

## What is being scored

Twelve requests, each stating what the planner is supposed to conclude and
nothing about how. Three properties, because they fail independently:

| | |
|---|---|
| **outcome** | plans it, or reports a gap |
| **shape** | the plan contains the capabilities the job needs, and none it does not |
| **hygiene** | no step whose result goes nowhere, no invented paths |

Outcome is the expensive one in both directions. A gap reported as a plan does
the wrong thing confidently; a plan reported as a gap sends the generator off to
write a skill for something the system can already do.

## Result

| | |
|---|---|
| outcome | **12/12** |
| shape | **8/8** (the cases that specify one) |
| hygiene | **12/12** |
| median latency | **10.95 s** (min 8.6, max 27.0) |
| attempts | 14 for 12 plans |
| silent repairs | 0 |

Fourteen model calls for twelve plans: ten plans were right first time, two
needed one retry each. The retries are the validator's error messages doing
their job — they name the step and what it should have referenced, so the
second attempt has something to act on.

## What the first run found

The first run scored **10/12 outcome, 6/8 shape**. Every one of the failures was
a defect in the system rather than noise, and each is now covered by a test.

**A plan can do work that serves nobody.** Asked to convert HEIC photos to JPEG
with no converter installed, the planner correctly reported the missing
converter — and planned to find every photo and open it anyway. Reading the
user's files to no purpose is worse than doing nothing. The planner now rejects
any step whose result no later step reads, which does not change anything, and
which is not the final step producing an answer.

**Closing that hole moved the problem rather than fixing it.** The next run
satisfied the new rule by appending an `answer` step that explained *how the
user might convert the files by hand*. Every step would succeed, the trace would
read as a clean run, and no photo would be converted. This is the same instinct
each time: asked to do something it lacks the means for, the model would rather
describe the thing than admit it cannot do it. The rule that catches it is worth
stating plainly — **if the plan says the operation is missing and no step
changes anything, the plan has not done the job.** Reading and talking is not
doing. The condition is on effects rather than on step count, so "mute the sound
and post it to Slack" still runs the mute and then reports what it could not do.

**A plan can succeed at every step and produce a confidently wrong answer.** A
search matched no files, the read opened nothing, and the answer step — handed
no passages — fell back to the model's own knowledge and told the user it had no
access to their files. Three steps reported success. The executor now stops when
a step is handed an empty value, and says which step came back empty. Its status
is `empty`, kept distinct from `failed`: nothing broke, and filing it as a
failure would put working capabilities in the repair queue.

**Guessed paths look purposeful and match nothing.** Three variants appeared:
`/Users/$(whoami)/Documents`, `/Users/<username>/Desktop`, `/path/to/project`,
and a bare relative `Documents`. None reaches a shell — no plan input ever does
— so none is dangerous in the injection sense. As a folder filter each one
silently narrows a search to zero results. An optional one is now dropped and
the step runs; a required one is an error.

**Models write `//` comments into JSON.** One case failed twice and cost 29
seconds to produce nothing, because the envelope was perfect apart from two
trailing comments. The retry was told only `json_parse_error` and, having no
idea which detail had offended, made the identical mistake again. `jsonRepair`
now strips line comments, string-aware so a URL survives, and tries its repairs
in combination because a response can carry both faults at once.

**A gap can be lost to an unrelated defect.** A plan can be malformed *and*
correct about what is absent. The gap fallback originally collected only
capabilities the model named that the graph lacked, so a plan rejected for a bad
step reported `failed` and threw away a perfectly good sentence describing what
was missing. Both sources are now collected.

## Over-planning is the characteristic failure of this model

Given a 33-entry catalogue and a request one skill already covers, the 8B
planner reaches for five steps. The worst observed:

> "list the biggest files in my downloads folder"
> → `list-large-files`, then `file-organize-into-subfolders` "to ensure accurate
> size reporting", then `generate-directory-summary` "to verify the list", then
> `extract-contents`, then `answer`.

Two of those capability names do not exist, and the two verification steps are
pure confabulated ceremony — one of which would have *moved the user's files
around* as a side effect of being asked to list them. Validation rejected the
plan, which is the safe direction, but the request then failed outright.

Three prompt rules fixed it, and they are worth recording because they are
specific rather than general exhortations to be careful:

1. If one operation does the whole job, the plan is that one step. Never add a
   step to prepare, verify or tidy up first.
2. A skill reports its own result: a skill that does the whole job needs no
   `files.search` before it and no `answer` after it.
3. Open as little as possible. `files.search` already knows every file's name,
   folder, size and date, so *where is it*, *when did it change* and *how big is
   it* need no `files.read` at all.

The third is a privacy rule as much as an efficiency one, and it is what fixed
the "where did I save the tenancy agreement" case — which the planner had been
answering by opening the tenancy agreement.

## Where planning sits in the request path

Planning is not on the fast path. The guard triages every request, and a request
that resolves to a single installed skill is executed directly, exactly as
before. The planner runs only where the guard concluded that no single skill
covers the request — the branch that previously went straight to skill
generation.

That ordering is the argument of the system rather than an optimisation.
Capability accumulates, so the first question about a new request is whether the
accumulation already reaches it. Composition is ~11 s on the resident engine;
generation is minutes on the 14B coder. Asking first costs almost nothing even
when the answer is no — and when it is no, the planner has said in a sentence
*what* is missing, which is a better brief for the generator than the user's
original words, because it names the gap rather than the goal.

## Regression

Nothing on the existing paths moved.

| | before | after |
|---|---|---|
| unit tests | 208 | **256** |
| router dev set | 28/28 | **28/28** |
| ClawBench intent accuracy | 42/42 | **42/42** |
| ClawBench mean latency | 5.45 s | **5.18 s** |

One intermediate ClawBench run reported 6.38 s, uniformly slower across every
case including single-stage ones whose code path had not changed. It returned to
baseline on re-measurement with no further code change, so it was machine state
rather than the work.

## Caveats

**Twelve cases.** Enough to catch the six defects above, which is what it was
for, and not enough to put a confidence interval on 12/12. It should grow as the
capability graph does.

**Two cases test the planner outside its production path.** "How many lines are
in the python files" and "list the biggest files" both resolve to a single
installed skill, so the guard would execute them directly and the planner would
never see them. They are kept because the planner should not be *worse* than the
router on requests it might one day be handed.

**The scoring is structural, not semantic.** It checks that a plan contains the
right capabilities and no dead steps. It does not check that the arguments are
right — that `text: "boiler service"` is a better search than `text: "boiler"`.
Those judgements need execution against a fixture corpus, which is what the
trace store now makes possible and what a later phase should use.

**Latency is the honest cost.** A composed request pays ~11 s of planning before
any work starts. That is acceptable against generation's minutes and poor
against the 6 s the guard takes to route a single skill. The trace records the
tier every step ran at, which is what a later phase needs in order to promote a
repeatedly-planned composition into a recorded procedure and stop paying for it.
