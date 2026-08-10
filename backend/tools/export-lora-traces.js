#!/usr/bin/env node
// Exports the verified routing decisions as triage-stage training data for
// the guard (efficiency ladder, step 5). Each pair is the guard's own system
// prompt, the request as the user turn, and the decision the outcome proved
// right as the assistant turn — mlx_lm's chat format, split deterministically
// into train and valid so repeated exports keep the same boundary.
//
//   node backend/tools/export-lora-traces.js [output-dir]
//
// Defaults to backend/data/lora. The benchmark cases in router-bench.js are
// the adoption gate and must never appear in this data.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const routerTraces = require('../services/routerTraces');
const router = require('../services/router');

const outDir = process.argv[2] || path.join(__dirname, '..', 'data', 'lora');
if (process.env.JARVIS_ROUTER_TRACES_DB) {
    routerTraces.open(process.env.JARVIS_ROUTER_TRACES_DB);
}

const rows = routerTraces.verifiedDecisions();
if (!rows.length) {
    console.error('no verified routing decisions to export yet — the store fills as intents succeed');
    process.exit(1);
}

const pairs = routerTraces.trainingPairs(rows, router.buildTriagePrompt());

const train = [];
const valid = [];
for (const pair of pairs) {
    const prompt = pair.messages[1].content;
    const digest = crypto.createHash('sha256').update(prompt).digest();
    (digest[0] % 10 === 0 ? valid : train).push(pair);
}
// mlx_lm refuses an empty valid set; move one example over when the split
// left it bare.
if (!valid.length && train.length > 1) valid.push(train.pop());

fs.mkdirSync(outDir, { recursive: true });
const write = (name, list) => fs.writeFileSync(
    path.join(outDir, name), list.map(p => JSON.stringify(p)).join('\n') + '\n');
write('train.jsonl', train);
write('valid.jsonl', valid);

const classes = {};
for (const row of rows) classes[row.intent_class] = (classes[row.intent_class] || 0) + 1;

console.log(`exported ${pairs.length} pair(s) → ${train.length} train, ${valid.length} valid in ${outDir}`);
console.log(`verified decisions by class: ${JSON.stringify(classes)}`);
console.log('next: python3 backend/tools/lora-tune.py (dry run), then --train to fit the adapter');
