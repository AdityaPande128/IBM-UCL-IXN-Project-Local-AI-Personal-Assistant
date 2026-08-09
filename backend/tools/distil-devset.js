#!/usr/bin/env node

const path = require('path');
const os = require('os');
const fs = require('fs');

const fixture = require('../tests/webFixture');
const webAgent = require('../services/webAgent');
const distiller = require('../services/distiller');
const procedureStore = require('../services/procedureStore');
const procedureRunner = require('../services/procedureRunner');
const traceStore = require('../services/traceStore');
const securityStore = require('../security/store');
const browser = require('../services/browser');
const labels = require('../security/labels');

const VERBOSE = process.argv.includes('--verbose');
const USER = labels.label(labels.ORIGIN.USER, labels.SENSITIVITY.PERSONAL);

const FAMILIES = [
    {
        name: 'catalogue search',
        start: '/search',
        teach: [
            'what does the bookshop say about The Long Field',
            'what does the bookshop say about Wild Places'
        ],
        replay: {
            goal: 'what does the bookshop say about Quiet Water',
            args: { title: 'Quiet Water' },
            expect: /11\.25|Poetry/i
        }
    },
    {
        name: 'opening hours',
        start: '/',
        teach: [
            'what time does the bookshop close on Sunday',
            'what time does the bookshop close on Sunday'
        ],
        replay: {
            goal: 'what time does the bookshop close on Sunday',
            args: {},
            expect: /11am to 5pm|Sunday/i
        }
    }
];

function scratch() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-distil-bench-'));
    traceStore.open(path.join(dir, 'traces.db'));
    securityStore.open(path.join(dir, 'security.db'));
    procedureStore.open(path.join(dir, 'procedures'));
    procedureStore.reload();
    return dir;
}

function textOf(result) {
    return [result.answer || '', ...(result.passages || []).map(p => p.text)].join('\n');
}

(async () => {
    const dir = scratch();
    const site = await fixture.start();

    console.log(`\n  DISTILLATION DEV SET — ${FAMILIES.length} procedure famil(ies)\n`);

    const score = { learned: 0, replayed: 0, correct: 0 };
    const rows = [];

    try {
        for (const family of FAMILIES) {
            console.log(`  ${family.name}`);

            const teaching = [];
            for (const goal of family.teach) {
                const run = await webAgent.browse(goal, {
                    url: `${site.origin}${family.start}`,
                    label: USER,
                    allowPrivate: true
                });
                teaching.push(run);
                console.log(`    tier 2 (learning)  ${String(run.run_ms).padStart(6)}ms  ` +
                    `${run.actions.length} action(s)  ${run.status}`);
                if (VERBOSE) console.log(`        ${run.answer || run.reason}`);
                await browser.close();
            }

            if (teaching.some(run => run.status !== 'success')) {
                console.log('    FAIL  a teaching run did not succeed; nothing to distil\n');
                rows.push({ family: family.name, ok: false, why: 'teaching run failed' });
                continue;
            }

            const result = distiller.distil({});
            const learned = result.learned.find(procedure => procedure.surface === '127.0.0.1'
                && procedure.start_url === `${site.origin}${family.start}`);

            if (!learned) {
                const why = (result.skipped[0] || {}).why || 'no group reached the threshold';
                console.log(`    FAIL  nothing distilled: ${why}\n`);
                rows.push({ family: family.name, ok: false, why });
                continue;
            }
            score.learned++;
            console.log(`    distilled          ${learned.name}`);
            console.log(`                       "${learned.goal_template}" ` +
                `[${Object.keys(learned.parameters).join(', ') || 'no arguments'}]`);
            console.log(`                       ${learned.steps.length} step(s) from runs of ` +
                `${learned.learned.tier2_model_calls} model call(s)`);

            const control = await webAgent.browse(family.replay.goal, {
                url: `${site.origin}${family.start}`,
                label: USER,
                allowPrivate: true
            });
            await browser.close();

            const replay = await procedureRunner.replay(learned, family.replay.args, {
                label: USER, allowPrivate: true
            });
            await browser.close();

            const replayed = replay.status === 'success';
            const grounded = family.replay.expect.test(textOf(replay));
            if (replayed) score.replayed++;
            if (replayed && grounded) score.correct++;

            const speedup = control.run_ms && replay.run_ms
                ? (control.run_ms / replay.run_ms) : 0;

            console.log(`    tier 2 (same task) ${String(control.run_ms).padStart(6)}ms  ` +
                `${control.actions.length} model call(s)  ${control.status}`);
            console.log(`    tier 1 (replay)    ${String(replay.run_ms).padStart(6)}ms  ` +
                `0 model calls  ${replay.status}` +
                (grounded ? '  answer on the page' : '  WRONG PAGE'));
            console.log(`    ${speedup ? `${speedup.toFixed(1)}x faster` : ''}\n`);

            if (VERBOSE) {
                console.log(`        control: ${control.answer || control.reason}`);
                console.log(`        replay:  ${replay.url}`);
            }

            rows.push({
                family: family.name,
                ok: replayed && grounded,
                tier2_ms: control.run_ms,
                tier1_ms: replay.run_ms,
                tier2_calls: control.actions.length,
                speedup,
                why: replayed ? (grounded ? null : 'landed on the wrong page') : replay.reason
            });
        }
    } finally {
        await browser.close();
        await site.close();
        traceStore.close();
        securityStore.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }

    const measured = rows.filter(row => row.speedup);
    const meanSpeedup = measured.length
        ? measured.reduce((total, row) => total + row.speedup, 0) / measured.length : 0;
    const callsSaved = measured.reduce((total, row) => total + row.tier2_calls, 0);

    console.log('  ----------------------------------------------------');
    console.log(`  distilled               ${score.learned}/${FAMILIES.length}`);
    console.log(`  replayed successfully   ${score.replayed}/${FAMILIES.length}`);
    console.log(`  landed on the right page ${score.correct}/${FAMILIES.length}`);
    console.log(`  mean speedup            ${meanSpeedup.toFixed(1)}x`);
    console.log(`  model calls removed     ${callsSaved} across ${measured.length} task(s)`);
    console.log('  ----------------------------------------------------\n');

    for (const row of rows.filter(entry => !entry.ok)) {
        console.log(`  FAILED  ${row.family} — ${row.why}`);
    }
    console.log('');
})();
