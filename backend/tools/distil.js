#!/usr/bin/env node

const distiller = require('../services/distiller');
const procedureStore = require('../services/procedureStore');

const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const value = (name, fallback) => {
    const at = argv.indexOf(name);
    return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};

function show(procedure) {
    const health = procedure.health || {};
    const retired = procedureStore.isOffered(procedure) ? '' : '  [RETIRED]';

    console.log(`\n  ${procedure.name}${retired}`);
    console.log(`    ${procedure.goal_template}`);
    console.log(`    on ${procedure.surface}, from ${procedure.start_url}`);
    for (const step of procedure.steps) {
        const what = step.action === 'navigate' ? step.url
            : step.slot ? `${step.name} <- {${step.slot}}`
            : step.text !== undefined ? `${step.name} <- "${step.text}"`
            : step.name;
        console.log(`      ${step.action.padEnd(9)} ${what}`);
    }
    if (procedure.learned) {
        console.log(`    learned from ${procedure.learned.runs} run(s), ` +
            `which averaged ${procedure.learned.tier2_model_calls} model call(s) ` +
            `and ${procedure.learned.tier2_mean_ms}ms`);
    }
    if (health.replays) {
        console.log(`    replayed ${health.replays}x — ${health.successes} ok, ${health.failures} failed` +
            (health.last_error ? ` (last: ${health.last_error})` : ''));
    }
}

if (flag('--list')) {
    const all = procedureStore.all();
    console.log(`\n  ${all.length} procedure(s) known\n  ${'-'.repeat(50)}`);
    all.forEach(show);
    console.log('');
    process.exit(0);
}

const result = distiller.distil({
    limit: Number(value('--limit', 200)),
    surface: value('--surface', null),
    dryRun: flag('--dry-run')
});

console.log(`\n  DISTILLATION — ${result.considered} traced run(s), ${result.groups} distinct procedure(s)\n`);

if (result.learned.length) {
    console.log(`  Learned ${result.learned.length}${flag('--dry-run') ? ' (dry run, nothing written)' : ''}:`);
    result.learned.forEach(show);
} else {
    console.log('  Nothing new to learn.');
}

if (result.skipped.length) {
    console.log(`\n  Not promoted:`);
    for (const skip of result.skipped) {
        const which = skip.plan ? `plan ${skip.plan}` : `plans ${(skip.plans || []).join(', ')}`;
        console.log(`    ${(skip.surface || '?').padEnd(24)} ${which.padEnd(18)} ${skip.why}`);
    }
}
console.log('');
