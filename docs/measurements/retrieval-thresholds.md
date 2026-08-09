# Retrieval thresholds

Measured 30 July 2026 with `node backend/tools/calibrate-retrieval.js`, against a
251-chunk corpus built from this repository's own documentation — real prose of
realistic length and variety, and not the user's private data.

Two query sets: eight questions the corpus genuinely answers, and eight about
subjects it has never mentioned. What matters is the **top hit**, because that is
what decides whether an answer is grounded at all.

| Top-hit similarity | min | p25 | median | p75 | max |
|---|---:|---:|---:|---:|---:|
| answerable | 0.609 | 0.648 | 0.702 | 0.707 | 0.735 |
| foreign | 0.406 | 0.456 | 0.497 | 0.507 | 0.514 |

Worst answerable **0.609** against best foreign **0.514** — a separation of
**0.096**. The distributions do not overlap, so a floor can divide them.

## Both previous settings were wrong

**`corpus_min_score` was 0.50, and the best foreign question scored 0.514.** The
floor sat *below* the noise, so a question the corpus knew nothing about could
still be answered "grounded", citing whatever it happened to be nearest to. This
is the same failure as the earlier synthetic case where asking about Peru
retrieved a bolognese recipe. Raising the floor from 0.35 to 0.50 narrowed it but
did not close it, because six synthetic chunks gave a query nothing to be
confused by — the corpus was too small to contain a plausible wrong answer.

Now **0.56**: the midpoint of the measured gap, and therefore the point least
sensitive to either distribution shifting on a different corpus.

**`corpus_margin` was 0.12, while the real spread between the best and fifth hit
within a genuine result set is 0.061 median.** A relative cutoff wider than the
entire spread never fired — the margin was doing nothing at all. Now **0.06**,
which trims the weak tail while keeping the body of a genuine result set.

## Which error was being made

The floor and the margin fail in opposite directions, and the costs are not
symmetric.

A floor set too low produces a **confident wrong answer with a citation**, which
is worse than no answer, because the citation is what makes it credible. A floor
set too high produces an ungrounded answer that is explicitly labelled as such.
The safe direction is up, which is why the midpoint rather than something nearer
the answerable minimum.

## Caveat

Sixteen queries over one corpus. The separation is wide enough that the midpoint
is not a close call, but the tails are not well characterised, and a corpus of
the user's own mail — shorter, less formal, far more repetitive than
documentation — could move both distributions. Re-run the tool against a real
personal corpus before treating these as settled.
