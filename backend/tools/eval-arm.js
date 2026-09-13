#!/usr/bin/env node
// Point the model tiers at the declared evaluation arm and record which arm
// the machine is in, so eval-run.js can refuse a mismatched run.
//   node tools/eval-arm.js P   — parity: every tier on the 4B
//   node tools/eval-arm.js C   — configured: gemma-4-E4B guard/engine (v3 prompt), 14B smith
//   node tools/eval-arm.js C0  — the as-built arm of 2026-09-01: 4B guard/engine, 14B smith
// Tier changes only take effect when the inference server next boots; this
// tool never kills a server it does not own — restart it yourself and check
// /health lists the expected tiers before any registered run.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const CONFIG = path.join(ROOT, 'config.json');
const ARM_STATE = path.join(ROOT, 'docs', 'measurements', 'eval-arm.state');

const { ARMS } = require('./eval-arms');
const arm = process.argv[2];
if (!ARMS[arm]) {
    console.error('usage: eval-arm.js P|C|C0');
    process.exit(1);
}

const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const backup = CONFIG + '.pre-eval-arm';
if (!fs.existsSync(backup)) fs.copyFileSync(CONFIG, backup);
config.models.tiers = ARMS[arm];
fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2) + '\n');
fs.mkdirSync(path.dirname(ARM_STATE), { recursive: true });
fs.writeFileSync(ARM_STATE, arm + '\n');

console.log(`Arm ${arm} written to config.json (original kept at `
    + path.basename(backup) + ').');
console.log('Now restart the inference server and confirm /health shows:');
for (const [tier, spec] of Object.entries(ARMS[arm])) {
    console.log(`  ${tier}: ${spec.model} (${spec.policy})`);
}
console.log('Arm C note, recorded in the protocol deviations: guard and '
    + 'engine share the 4B by design (the guard merge); the registered '
    + '8B engine row predates that decision.');
