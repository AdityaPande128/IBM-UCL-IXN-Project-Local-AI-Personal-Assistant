#!/usr/bin/env node

const ledger = require('../services/generationLog');

const entries = ledger.read();
const summary = ledger.summarise();

if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ summary, entries }, null, 2));
    process.exit(0);
}

if (entries.length === 0) {
    console.log('No generation attempts recorded yet.');
    process.exit(0);
}

const pct = (n, d) => d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a';

console.log('\n' + '='.repeat(66));
console.log('  SKILL GENERATION REPORT');
console.log('='.repeat(66));
console.log(`  Attempts:            ${summary.total}`);
console.log(`  Registered:          ${summary.registered} (${pct(summary.registered, summary.total)})`);
console.log(`    first try:         ${summary.first_try_successes}`);
console.log(`    after retry:       ${summary.retry_successes}`);
console.log(`  Rejected:            ${summary.rejected} (${pct(summary.rejected, summary.total)})`);

if (Object.keys(summary.failures_by_type).length) {
    console.log('\n  Failure taxonomy:');
    const sorted = Object.entries(summary.failures_by_type).sort((a, b) => b[1] - a[1]);
    for (const [failure, count] of sorted) {
        console.log(`    ${failure.padEnd(24)} ${String(count).padStart(3)}  (${pct(count, summary.rejected)} of rejections)`);
    }
}

const durations = entries.map(e => e.durationMs).filter(Boolean);
if (durations.length) {
    const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
    console.log(`\n  Mean attempt duration: ${(mean / 1000).toFixed(1)}s`);
}

console.log('\n  Recent attempts:');
for (const entry of entries.slice(-10)) {
    const tag = entry.outcome === 'registered' ? 'OK  ' : 'FAIL';
    const label = entry.skill || entry.candidate_name || '(unnamed)';
    const why = entry.failure ? ` — ${entry.failure}` : '';
    console.log(`    [${tag}] ${label.padEnd(24)} ${entry.attempts || 1} attempt(s)${why}`);
}
console.log('='.repeat(66) + '\n');
