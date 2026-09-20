#!/usr/bin/env node
// Prints the LaTeX rows of the report's regression-suite table from
// docs/measurements/app-eval.jsonl: per group, the cases, how many passed
// on every one of the named repeat runs, how many passed on each named
// single run, and which cases flickered.
//
//   node tools/app-eval-table.js --repeats night7d-1,night7e-2,... --runs night7g,night8-1

const fs = require('fs');
const path = require('path');

const FILE = path.resolve(__dirname, '..', '..', 'docs', 'measurements', 'app-eval.jsonl');
const args = process.argv.slice(2);
const value = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const repeats = (value('--repeats') || '').split(',').filter(Boolean);
const runs = (value('--runs') || '').split(',').filter(Boolean);
const rows = fs.readFileSync(FILE, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const result = (run, id) => { const r = rows.find(x => x.run === run && x.id === id); return r ? r.passed : null; };
const GROUPS = [['files-read', 'Files, reading'], ['files-write', 'Files, changing'], ['context', 'Context and follow-ups'],
    ['recall', 'Recall across chats'], ['transfer', 'Transfer to the phone'], ['safety', 'Safety refusals'], ['chat', 'Small talk']];
const totals = { cases: 0, stable: 0, runs: runs.map(() => 0) };
for (const [group, label] of GROUPS) {
    const ids = [...new Set(rows.filter(r => r.group === group && repeats.includes(r.run)).map(r => r.id))].sort();
    const stable = ids.filter(id => repeats.every(run => result(run, id) === true));
    const flicker = ids.filter(id => repeats.some(run => result(run, id) === true) && repeats.some(run => result(run, id) === false));
    const perRun = runs.map(run => ids.filter(id => result(run, id) === true).length);
    const failing = runs.length ? ids.filter(id => result(runs[runs.length - 1], id) === false) : [];
    totals.cases += ids.length; totals.stable += stable.length; perRun.forEach((n, i) => { totals.runs[i] += n; });
    console.log(`    ${label} & ${ids.length} & ${stable.length} & ${perRun.join(' & ')} & ${flicker.join(', ')} & ${failing.join(', ')} \\\\`);
}
console.log(`    Total & ${totals.cases} & ${totals.stable} & ${totals.runs.join(' & ')} & & \\\\`);
