# Jarvis — Development Plan

**Standing decision (2026-08-09):** all phases below are committed direction.
Sequencing is fixed by one non-negotiable cut line: **only Phase 1 is in scope
before the MSc submission.** Phases 2–6 are the Future Work chapter, written
here first so the report's future work describes a plan, not a wish.

## Phase 1 — Ship v1 (pre-submission)

### Week 1 — the visible app
- Consent/approval card UI + live activity panel (the two surfaces every other
  feature renders through), wired to the existing proposal and activity-bus
  backends.
- Chat and voice wired into the app shell.
- Hardening items that touch the wire protocol *before* the UI hardens around
  it: socket token handshake (#61), intent queue + abort (#63).
- **A fixed daily writing block starts now** — chapters 1–2 (introduction,
  background/literature) and the future-work chapter depend on no code and
  must not be written during evaluation week.
- Ground-truth predicates for Suites A and D pre-written this week (they
  depend on no week-2 code), so freeze day only adds Suite C's. Time Machine
  backups on from day one; the scoresheet and config snapshots live in the
  repository.
- **Lead-time actions, day one, because they wait on other people:** purchase
  the Apple Developer ID (notarization has approval lag); recruit **six** UAT
  participants so n ≥ 4 survives no-shows (at least one genuinely
  non-technical); book a supervisor slot for the draft review in week 3;
  start the department's ethics/consent route for the UAT study — consent
  forms must exist before the first session, and quotes appear in the report.

### Week 2 — the complete app
- **Onboarding/first-run flow** — machine + disk preflight, resumable model
  downloads with progress, mail sign-in handoff. Required by F1/NF3 and by
  G1 itself; paid for by reducing the granted-sites panel to a read-only list.
- Abilities view — skills and recipes with their permissions, **removal**,
  and **past build attempts including failed ones** (F10, F11, F17, F18) —
  settings (models per tier, linked browser — F15), and the **marked door to
  OpenClaw** (F29): an "Open OpenClaw dashboard" item that launches the
  gateway's own Control UI in the browser, behind a first-time explainer card
  stating that Jarvis's guarantees end at that door. When OpenClaw is not
  installed the item shows disabled with a one-line explanation — that state
  is what the G1 smoke pass checks — and the dashboard always opens in the
  user's default browser, never in the assistant's automation profile.
  Embedding the dashboard inside the app was considered and rejected: a
  Jarvis-looking window running OpenClaw would invite users to assume
  guarantees that do not apply there.
- Startup reconciliation sweep (#62), skill content-hash pinning (#64),
  **service supervision** (#3: app shell owns child processes, restarts,
  plain-language status card) and the **rotating log + diagnostics bundle**
  (#11) — the last two are G1 preconditions; UAT users cannot meet
  terminal-flavoured errors or be undebuggable.
- **DMG built and installed on a clean macOS account — Gate G1**, including
  the UI smoke pass (#14) — which covers the marked door and its explainer
  card, since the verification mapping claims exactly that. Notarization is
  required only for the final submission DMG; the UAT machine may run an
  ad-hoc-signed build if Apple enrollment stalls (an ad-hoc build needs one
  right-click-open, which is excluded from the F1 no-command-line evidence).
  The "conditional extras" once attached to G1 (memory-lite, document Q&A)
  are cut from Phase 1 entirely: no requirement licensed them and no
  freeze-safe build window existed. They live in Phase 3.
- **UAT pack built before freeze day:** the fixture mailbox, the task script,
  consent and SUS forms, and the machine-reset procedure between
  participants.
- **All manual screenshots captured in one pass after G1**, not concurrently
  with the UI they show; the manual *text* is drafted during week 3's
  attended run days (runs need presence, not hands).
- **Freeze day (end of week 2):** every ground-truth predicate written into
  the scoresheet (Suites A and D arrive pre-written from week 1), Suite C's
  four new tasks and fixtures built, config snapshots + `eval-freeze-1` tag,
  the **demo script drafted in prose** (week 3's egress capture and week 4's
  recording only follow it), and OpenClaw's Arm-C model pilot as defined in
  the protocol's §9. Nothing runs before the freeze; nothing changes after
  it.

### Week 3 — evidence
- Evaluation runs per the frozen protocol — **~250 attended runs at 6–8
  minutes each (the figure includes state reset and ground-truth reading) is
  three and a half to four full days**, so they start the weekend
  immediately after freeze day and own Monday–Wednesday: Arm P first, then
  Arm C, both reported in full; deviations logged, not absorbed. The full minimum-viable-model
  descent study is **deferred to Phase 5** — it was never registered in the
  protocol and does not belong beside one.
- Egress-log capture across a full demo script (NF1 evidence — one hour,
  scheduled so it cannot be forgotten).
- **Draft report to supervisors — Gate G2**, redefined honestly: chapters 1–4
  complete in prose (1–2 from the week-1/2 writing block; 3–4 are the
  requirements and architecture documents), chapters 5–6 with results tables
  landing as runs finish.
- The first one or two UAT sessions — the remainder belong to week 4, since
  Thursday–Friday already hold the egress capture, G2 assembly, and the
  supervisor slot: on the **author-prepared machine with the fixture
  mailbox** — participants bring themselves, not 24 GB Macs or their private
  mail.

### Week 4 — finish
- UAT completed: SUS, quotes, task success table.
- Benchmarks page fed from the frozen results (moved here from week 3).
- Supervisor feedback applied; final evaluation numbers frozen into the report.
- Demo video recorded and live demo rehearsed from the script frozen in week
  2 (a consented skill build and the mail loop are the set pieces).
- **Final notarized DMG built and the full smoke pass repeated on it** — the
  submission artifact is this build, not the G1 one.
- Buffer. If — and only if — everything above is green: the calendar-booking
  stretch (F20) — feature-only: its booking cases are registered as Phase-2
  verification, and no suite changes after the freeze.

### The cut order (agreed now, not under fire)
When a week overruns, committed scope is dropped in exactly this order, each
cut logged in the report as a scope decision:
1. The F20 calendar-booking stretch (already gated).
2. Demo video polish — a plain screen recording suffices.
3. The benchmarks page — the report's tables carry the evidence.
4. Evaluation Arm C — Arm P alone is the like-for-like headline; dropping C is
   a logged protocol deviation, not a silent one.
Nothing else is droppable: the MUSTs, the manuals, UAT at n ≥ 4, and Arm P are
the submission.

## Phase 2 — Proactivity, private answers, and the phone
- **Calendar booking (F20): the first item.** Events booked on request or from
  details found in an email, behind the F7 approval rules, verified against
  the calendar itself; booking cases are registered into the next protocol
  revision's suites A and D — the pre-submission protocol is frozen without
  them, so a week-4 stretch build ships feature-only.
- The **channel adapter** (architecture §9): Telegram pairing bound to one
  chat id; text + voice notes both ways; approval cards as inline buttons.
- The **availability manager**: stay-awake-on-AC assertion; watchers are
  catch-up-on-wake by design.
- Watchers on recipes (poll → diff → notify). Morning brief with pre-drafted
  replies queued for consent. The approval queue as an inbox.
- **Web answers**: search → read-only fetch → grounded, cited answers
  (architecture §5), with the read-only webPolicy lane and per-query
  disclosure.

## Phase 3 — Memory, documents, privacy controls, and hands-free voice
- Full user-editable memory with confirmation-carded inference and
  secure-deleting removal (architecture §3–4). Incognito mode. Retention
  settings and full-wipe.
- PDF (then docx) ingestion into the corpus. Semantic file search and document
  Q&A matured. Attachment flows bridging mail ↔ files.
- **"Hey Jarvis"** — the always-on audio front-end (architecture §9.3):
  local wake word, VAD endpointing, menu-bar indicator, stated mic-privacy
  contract.

## Phase 4 — Self-healing & model efficiency
- Grounded verification (test on the request's own data). Skill repair with
  failure context. Recipe re-learning after site changes. Structured skill
  outputs so skills compose. Failure taxonomy as the driver.
- Efficiency ladder steps 1–3 (constrained decoding, prefix caching,
  speculative decoding), each measured on the gates before adoption.

## Phase 5 — Reach & the harness-tuned model
- Adaptive hardware tiers (8/16/24 GB defaults from the minimum-viable-model
  study). Outlook + multi-account. Skill exporter and signed skill packs
  (F16, F30) — exported wrappers invoke a Jarvis shim rather than the script
  directly, so the sandbox and content-hash checks travel with the skill
  across the border; the exporter also ships a **builder meta-skill** into
  OpenClaw (F31), so even a user living in OpenClaw's own surfaces can ask
  for a new capability and get Jarvis's generate-test-install pipeline
  (best-effort: its model must choose the skill).
- LoRA fine-tune of the guard on our own verified traces (efficiency ladder
  step 5), benchmark-gated.

## Phase 6 — Trust & field evidence
- Audit view ("what did you do while I was away"). Permissions dashboard.
  Export/import bundle and checkpointed store snapshots (hardening #10).
- Auto-update and hardening. Six-week field study, 10–15 users, SUS +
  interviews.

## Out of scope in every planned phase (restated from requirements)
General web automation on arbitrary sites with small local models; cloud model
fallback; credential handling; unconsented skill installation.
