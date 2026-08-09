# Skill-build pipeline: repair from evidence

Measured 9 August 2026 with `Qwen2.5-Coder-14B-Instruct-4bit` as the generator,
on the ten-request dev set in `backend/eval/skillgen/` (disjoint from Suite C by
construction — Suite C's frozen tasks must be authored away from this list).
Each run scores Suite C's three levels per request: **proposed** (a candidate
parsed), **installed** (passed the gate and registered), **correct** (invoking
it on fixtures gives the known answer), plus **damaged** (installed but wrong).

## Baseline

| | proposed | installed | correct | damaged |
|---|---|---|---|---|
| unchanged pipeline | 10/10 | 7/10 | 7/10 | 0 |

All three failures burned their full three attempts, and each exposed a
different blindness:

1. **csv-columns** — `exit code 3, expected 0` was the entire feedback. The
   repair loop never saw stdout, stderr, or the command line, so three
   attempts regenerated blind.
2. **sort-csv** — the model's test asserted a full sentence
   (`"Sorting the CSV file…"`) and its script printed a slightly different one
   (`"Sorted the CSV file…"`). Three repairs adjusted neither side to match.
3. **longest-word** — the test's expectation was itself wrong: it claimed the
   longest word in its own fixture was "long" when the fixture's is "simple".
   The script was right; the gate rejected it three times.

## Changes

- The repair prompt predated the two-part response format: it demanded "ONLY
  the JSON object", which drops the fenced script. It now demands both parts.
- A failing case feeds its full evidence to the repair attempt — the command
  line, stdout, stderr — with the instruction to recompute the test's
  expectation by hand and fix the test when the expectation is what's wrong.
  Passing cases are named so they stay green.
- Full-sentence `stdout_contains` assertions are rejected at the envelope
  gate. The advisory rule alone did not hold (the model reproduced the same
  sentence three times); the schema example now shows the right shape
  (`'3'`, `'output.csv'`) and the gate makes it mechanical.
- Retries warm up: temperature rises 0.2 per attempt (capped at 0.7). At 0.2 a
  rejected envelope tends to be reproduced verbatim — a repair loop that
  regenerates the same candidate is just a slow rejection.
- **Grounded trial**: when the request names a real path, the verified script
  runs once against a copy of that data before installation (read-only with
  respect to the original; size-capped; only when the parameter mapping is
  unambiguous). Passing authored tests proves the script runs — this proves it
  runs on what the user actually has.
- Generated skills are taught the `JARVIS_RESULT` envelope, so a skill whose
  outcome is a file hands the file back as an artifact.

## After

| | proposed | installed | correct | damaged |
|---|---|---|---|---|
| with repair evidence | 10/10 | 9/10 | 8/10 | 1* |
| + hard gate, schema example, warm retries (retest of the two stuck entries) | 2/2 | 2/2 | 2/2 | 0 |

\* The one "damaged" entry was a harness artifact, not a wrong skill:
`csv.writer` emits `\r\n` line endings and the correctness check compared
against `\n`. The harness now normalises line endings unless the check itself
targets them (the CRLF-conversion task still checks raw bytes). The entry that
regressed in this run — a fresh prose assertion on `number-lines` — is what
motivated promoting the advisory rule to a hard gate; after that change both
previously stuck entries built first-attempt.

## Caveats and what's still owed

Single runs at temperature 0.2: a ±1 difference between runs is sampling
noise (the smoke run built `longest-word` first-attempt minutes before the
baseline failed it three times). The load-bearing evidence is the failure
classes and their repair transcripts, not the aggregate row. Still owed: one
full ten-entry pass on the final configuration, and a live grounded-trial run
through the daemon with a request naming a real file.
