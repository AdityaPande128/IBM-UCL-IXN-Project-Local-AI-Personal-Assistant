# The authenticated web

Measured 1 August 2026 against a real Gmail account in a real browser, with the
resident engine model `granite-4.1-8b-4bit`.

## What was asked for

> "tell me what my last email was"

Nothing else. No URL, no steps, no mention of Gmail or of a browser. The system
had to decide by itself that this was a web task, that the address was
`mail.google.com`, that the browser it needed was the signed-in one, and what to
click when it got there.

    PLAN     planned, 1 attempt, 19.6 s
      s1 web.browse({goal: "Find the most recent email in the user's Gmail
                            account", url: "https://mail.google.com"})
      s2 answer({question: "What was my last email?", passages: "$s1.passages"})

    EXEC     success, 29.1 s
    LABEL    {origins: [generated, user, web], sensitivity: personal}

    REPLY    Your last email in the Gmail inbox is titled "Important please
             help" from Reddit, dated July 31, 2026 …

Asked instead to open it, the loop clicked into the message and read the sender
off the opened thread: *"The email was sent by Morning Brew
&lt;crew@morningbrew.com&gt; and the subject line is 'Forced to play defense'"* —
two actions, 30 s.

Nothing about Gmail, mail, or Google appears anywhere in the source. The
hostname is a row in the consent store that the user typed once; that Gmail lives
at `mail.google.com` is something the planner's model knows, the same way it
knows what a mutex is.

## The security argument, which changed

Phase 7 launched a browser with an empty profile and said so at length: driving
the user's own browser "would hand a model that has just read an adversarial web
page a live, authenticated session for the user's mail, bank and cloud storage."
That argument was not wrong and has not been retracted. It was overruled, by the
person whose sessions they are, after being stated.

What it bought was a boundary, and giving it up means the boundary has to be
rebuilt somewhere else. It moved from the profile to the navigation policy:

**An attached browse may only visit hosts the user granted by name.** Not the
site it started on plus wherever the links go — every navigation, including ones
the model proposes after reading a page. Measured:

| | |
|---|---|
| `mail.google.com/mail/u/0/` | allow |
| `accounts.google.com/signin` | refuse — sign-in page, blocked outright |
| `google.com` | refuse — a parent is not a subdomain |
| `evil.example.com/collect?data=…` | refuse — not granted |
| `mail.google.com.attacker.net` | refuse — suffix, not subdomain |

The case that matters is the third and the fifth. Granting `mail.google.com` does
not grant `google.com`, and the label-boundary comparison means a hostname that
merely *contains* a granted one is not it.

**The attack this is actually for is not a malicious site.** It is an ordinary
link in an ordinary email. Anyone can send the user a message containing a URL;
the model reads the message; following that link inside an authenticated browser
is a request carrying the user's cookies somewhere they never chose. Refusing it
costs a capability that sounds useful and is not — nothing the assistant was
asked to do requires leaving the site it was sent to.

**The lattice rule still composes on top.** A URL on a granted host, assembled
after reading a page, still needs approval: *"data the user did not type would
leave by network (personal (user+web))"*. Being granted makes a host reachable;
it does not make page-derived data free to send there.

**Two browsers, not one.** A browse of an ungranted site runs in the throwaway
browser, as before. So reading the fixture bookshop, or example.com, never
happens inside a context holding mail cookies. The signed-in browser is used only
where the user said so.

### What was not done

The password was never typed and there is no code path that could type it. The
session comes from the user's own browser, and `Login Data` — Chromium's saved
password store — is deliberately not among the files copied, because a session
lives in cookies and no task needs the password store.

The copy is a copy: 2 MB of cookies and local storage, not the 6.1 GB profile,
into a gitignored directory, deleted by `node tools/link-browser.js --forget`. It
is a second copy of a credential and is as sensitive as the original.

Chromium refuses `--remote-debugging-port` on its default profile directory,
which is a deliberate anti-malware measure and a good one. This does not defeat
it — it runs the same browser binary against a different profile, which is
allowed, and leaves the user's own browser untouched and running.

## What the live runs found

Six defects, all of them from pointing the thing at a real application. The
fixture site could not have produced any of them.

**A confident denial while holding the answer.** The worst failure of the
session, and it reported success at every step. The browse read the inbox
correctly and returned one passage of exactly 4000 characters; the answer step's
context budget is also 4000, so with its citation prefix the passage was a few
characters too long, the fitting loop broke on the first one, and nothing was
kept. Ungrounded, the answer fell back to the model's own knowledge and told the
user: *"I do not have access to your email account … I am a local assistant
running on your Mac and do not have internet connectivity."*

Dropping an oversized passage is right whenever something else fits — a citation
cut off mid-sentence is worse than a long one. When there is nothing else, it
means answering from memory with the evidence in hand, which is the one outcome
that must never happen. A test asserted the old behaviour; it has been rewritten,
because it was asserting a bug.

**Chunking assumed prose.** Passages were split on blank lines, which is right
for an article and produces exactly one chunk for an inbox, since a web
application's rendered text has no blank lines in it. That single chunk is what
overflowed the budget above. Oversized chunks are now split again on line breaks
— which is what separates the rows of a list — never mid-line.

**The perception budget was spent entirely on the wrong controls.** 341
candidates for 60 slots, ranked by a score that gives form controls 75 and links
45 on the stated grounds that "a page has two hundred links and three fields, and
the fields are what a task turns on". True of a form; false of an application,
where the content *is* links. Every message row's checkbox was listed and no
message subject was, so the model clicked the only control it could see near each
message — which selected it rather than opening it — and then clicked again and
deselected it. Six actions, no progress.

Selection is now round-robin across roles, so the budget stays representative of
what can be done rather than of what scores highest, and identical controls are
capped at three, because the fortieth "Not starred" button says nothing the first
one did not. Before: 60 elements, no message links. After: 17 buttons, 16 links,
17 checkboxes, 9 tabs, 1 textbox — and the message subjects among them.

**A stranger could decide what the assistant is allowed to read.** The
irreversible-click heuristic matches text like "Sign Up" and "Place order"
against an element's accessible name. In a mail client that name is the sender,
subject and preview of a message — text written by whoever sent it. The most
recent real email could not be opened because its newsletter footer contained the
words "Sign Up", so the policy reported that opening it would create an account.

This is not just a false positive. The matched text is attacker-supplied, so
anyone who can send an email can choose whether the user's assistant may open it.
The rule now applies only to names short enough to be control labels — buttons
that spend money are short and say so — and is unchanged where it has a basis.
Both halves are asserted by a test.

**The idle timer shut the browser during an active browse.** It counts from the
last navigation, and a browse that only clicks never navigates. A run of clicks
on an inbox passed the two-minute timeout, the page was closed underneath the
loop, and it failed with "target page has been closed": the shutdown for an idle
browser firing on a browser that had not stopped working for a moment. Clicking
now counts as activity.

**`domcontentloaded` is a spinner.** On a static page it is the moment the page
becomes readable; on an application it is the moment before anything exists.
Perceiving it produced a faithful description of a loading screen. `networkidle`
is the obvious fix and the wrong one — an application with a live connection open
never reaches it, so the wait always costs the full timeout. What is waited for
now is the DOM settling: element count and readyState, sampled until they hold
still, bounded, and never an error if they never do.

## The prompt has a fixed budget

Four attempts to tell the planner that some sites are signed in, each measured on
the plan dev set. The shape of the answer is more useful than the wording.

| attempt | result |
|---|---|
| five lines, as a numbered rule | 16/16 → **15/16**. "List the biggest files in my downloads folder" failed 3 times out of 3, and passed 3 out of 3 with the rule removed. Nothing about it concerns the web. |
| one line, as a numbered rule | the files case recovered; the case the rule existed for stopped working |
| allow a third planning attempt | files recovered, and **two gap cases became plans** |
| ten tokens on the capability, and rule 7b **rewritten** rather than added to | **16/16** |

Two things came out of this that are worth more than the fix.

**More retries bias towards planning.** A gap is what the model produces when it
gives up; every extra attempt is an invitation not to. Raising `max_attempts`
from 2 to 3 turned "text my sister to say I will be late" and "book me a table"
into plans. Retries are for malformed output, not for unwelcome conclusions.

**Amend, do not add.** This is the third time in two phases that adding correct
guidance to this prompt has broken something unrelated, which stops being a
coincidence and starts being a property of the model: attention is the budget and
the rules already there were earning their place. So a new fact about the world
goes where the model is already looking — being signed in somewhere is a property
of `web.browse`, stated in its catalogue entry, read exactly when the planner is
deciding whether to use it — and a new qualification to a rule replaces the clause
it qualifies instead of following it.

**A latent crash, surfaced by the third attempt and fixed on its merits.** The
plan validator's early return for "no steps array" omitted `declaredMissing`,
which the caller reads from every verdict; a reply carrying `missing` and no
`steps` crashed the planner. Rare enough to sit unnoticed until a third attempt
was permitted and produced one.

## Regression

| | before | after |
|---|---|---|
| unit tests | 312 | **315** |
| router dev set | 28/28 | **28/28** |
| plan dev set | 16/16 | **16/16** outcome, 11/11 shape, 16/16 hygiene |
| web dev set | 12/12 | **12/12** outcome, 8/8 grounding, 12/12 restraint |
| distillation dev set | 2/2 | **2/2** distilled, replayed, correct |
| ClawBench intent accuracy | 42/42 | **42/42** |
| ClawBench mean latency | 5.18 s | 5.19 s |

Replay latency rose from ~160 ms to ~940 ms and the distillation speedup fell
from 63.8x to **13.1x**. That is settling, and it is the correct trade: a replay
that does not wait for the page is fast and wrong on anything that renders
client-side. The claim that does not move is the one that never depended on the
network — every model call in the loop is still removed.

## Caveats

**One site, one account, one session.** Everything here was measured against a
single real Gmail inbox. A bank, a ticketing site or a webmail client with a
different DOM would exercise the perception layer differently, and the honest
expectation is that each one finds defects like the six above.

**Opening an email is at the edge of what tier 2 does reliably.** Gmail
re-renders continuously, and two of the six actions in one run failed with
`locator.click: Timeout 8000ms exceeded` because the element had been re-rendered
between the observation and the click roughly ten seconds later. Reading the
inbox listing is robust; navigating within a message thread is not yet.

**The loop can still oscillate.** Told to open a message, it twice clicked a
control that toggled state and then clicked it back. The refusal-repeat guard
only catches actions the policy refused, not actions that succeed and achieve
nothing. Detecting a no-op is Phase 9's territory.

**The session is a snapshot.** Signing into something new in the real browser
does not reach the assistant's copy until `link-browser.js` is run again. Mildly
inconvenient, slightly safer, and it means the user's own browser is never
disturbed.

**Nothing has been distilled from a real site.** The procedure machinery from
Phase 8 has not been pointed at Gmail. A recipe for "open the newest message"
would be exactly the kind of thing that goes stale when a mail client is
redesigned, which is what the health counters are for and what has not been
tested at that scale.

**The grant is coarse.** A granted host is granted entirely: reading mail and
sending it are the same origin. The irreversible-click heuristic is what stands
between an authenticated browse and a "Send" button, and it is a heuristic,
English, and now deliberately narrowed to short labels.
