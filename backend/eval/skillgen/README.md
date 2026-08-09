# Skill-build dev set

Ten capability requests with mechanically checkable outcomes, used to measure
the build pipeline before and after each change. This is a development
instrument, not part of the frozen evaluation: Suite C's tasks must be authored
disjoint from this list.

Run it with the inference server up:

```
cd backend
node eval/skillgen/run-devset.js            # all entries
node eval/skillgen/run-devset.js sort-csv   # one entry by id
```

Each run scores every entry on Suite C's three levels — **proposed** (a
candidate was parsed at all), **installed** (it passed the gate and registered),
**correct** (invoking it on the entry's fixtures yields the known answer) —
plus **damaged** (installed but wrong, the dangerous quadrant). Generated
skills, pins and the ledger are confined to a throwaway directory; the real
installation is never touched. Results land in `results/` (not committed);
the curated numbers belong in `docs/measurements/skillgen-pipeline.md`.
