#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');

const corpusIndexer = require('../services/corpusIndexer');
const vectorIndex = require('../services/vectorIndex');
const embedClient = require('../services/embedClient');
const store = require('../security/store');

const REPO = path.join(__dirname, '..', '..');

const ANSWERABLE = [
    'How much memory does the 14 billion parameter coder model use?',
    'What happens when a model is evicted from memory?',
    'Which model is pinned and never evicted?',
    'Why was the smaller router model rejected?',
    'How long does it take to reload a model after eviction?',
    'What is the Metal working set size on this machine?',
    'How does the router decide whether to refuse a request?',
    'What is the difference between the pinned catalogue and the live one?'
];

const FOREIGN = [
    'What is the capital of Peru?',
    'How do I make sourdough bread rise properly?',
    'When does the last train to Manchester leave?',
    'Who won the football World Cup in 1998?',
    'What is the recommended dose of ibuprofen for an adult?',
    'How do I repot an orchid without damaging the roots?',
    'What are the opening hours of the British Museum?',
    'How much does a plumber charge to fix a leaking tap?'
];

function percentile(values, p) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1,
        Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
    return sorted[index];
}

function summarise(label, scores) {
    const fmt = v => (v === null ? '  n/a' : v.toFixed(3));
    console.log(
        `  ${label.padEnd(12)} n=${String(scores.length).padStart(3)}  ` +
        `min ${fmt(percentile(scores, 0))}  p25 ${fmt(percentile(scores, 25))}  ` +
        `median ${fmt(percentile(scores, 50))}  p75 ${fmt(percentile(scores, 75))}  ` +
        `max ${fmt(percentile(scores, 100))}`
    );
}

(async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-calib-'));
    store.open(path.join(scratch, 'security.db'));

    const roots = [path.join(REPO, 'docs'), path.join(REPO, 'backend', 'skills')];
    for (const root of roots) store.grantRoot(root, 'calibration');

    console.log('\n  indexing the calibration corpus');
    for (const root of roots) console.log(`    ${root}`);

    const built = await corpusIndexer.build({
        name: 'calibration',
        roots,
        dir: scratch,
        extensions: new Set(['.md']),
        log: msg => console.log(`    ${msg}`)
    });
    console.log(`  ${built.indexed} chunk(s) from ${built.files} file(s)\n`);

    if (built.indexed === 0) {
        console.error('  nothing indexed — cannot calibrate\n');
        process.exit(1);
    }

    const collection = vectorIndex.collection('calibration', scratch).ensureLoaded();

    const top = { answerable: [], foreign: [] };
    const gaps = [];

    for (const [kind, questions] of [['answerable', ANSWERABLE], ['foreign', FOREIGN]]) {
        for (const question of questions) {
            const [vector] = await embedClient.embed([question]);
            const hits = collection.search(vector, { topK: 5, minScore: 0 });
            if (!hits.length) continue;

            top[kind].push(hits[0].score);
            if (kind === 'answerable' && hits.length > 1) {
                gaps.push(hits[0].score - hits[hits.length - 1].score);
            }
        }
    }

    console.log('  top-hit similarity');
    summarise('answerable', top.answerable);
    summarise('foreign', top.foreign);

    const worstAnswerable = percentile(top.answerable, 0);
    const bestForeign = percentile(top.foreign, 100);
    const separation = worstAnswerable - bestForeign;

    console.log(`\n  worst answerable ${worstAnswerable.toFixed(3)} vs ` +
        `best foreign ${bestForeign.toFixed(3)}  ->  separation ${separation.toFixed(3)}`);

    if (separation <= 0) {
        console.log('\n  NO SEPARATION. A foreign question scores at least as high as the');
        console.log('  weakest genuine one, so no floor can divide them. The floor should be');
        console.log('  set from the foreign distribution and the residual errors accepted,');
        console.log('  or the embedding model reconsidered.\n');
    } else {
        const suggested = bestForeign + separation / 2;
        console.log(`  suggested corpus_min_score: ${suggested.toFixed(2)} ` +
            `(midpoint of the gap)\n`);
    }

    const medianGap = percentile(gaps, 50);
    if (medianGap !== null) {
        console.log(`  spread within a genuine result set (top hit minus 5th): ` +
            `median ${medianGap.toFixed(3)}, p75 ${percentile(gaps, 75).toFixed(3)}`);
        console.log(`  suggested corpus_margin: ${Math.max(0.05, medianGap / 2).toFixed(2)} ` +
            `(half the median spread, so the tail is trimmed but the body survives)\n`);
    }

    store.close();
    fs.rmSync(scratch, { recursive: true, force: true });
})();
