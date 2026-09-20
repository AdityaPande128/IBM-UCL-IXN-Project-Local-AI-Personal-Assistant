#!/usr/bin/env node
// Between-task and between-arm state resets, per protocol §5.4 — reversible
// by construction: everything cleared is snapshotted first.
//
//   node tools/eval-reset.js task   — light: close the agent browser so the
//       next task gets a fresh context; prints the manual mailbox steps.
//   node tools/eval-reset.js arm    — full: snapshot then clear traces and
//       learned recipes so amortization starts cold (the distiller re-learns;
//       the per-model ledger is the arm's record of what it learned).
//   node tools/eval-reset.js restore <snapshot-dir> — put a snapshot back.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA = path.join(ROOT, 'backend', 'data');
const SNAPS = path.join(ROOT, 'docs', 'measurements', 'eval-snapshots');

const mode = process.argv[2];

function closeAgentBrowser() {
    try {
        execSync('pkill -f "user-data-dir=.*browser-profile"', { stdio: 'ignore' });
        console.log('Agent browser closed; the next task opens a fresh context.');
    } catch {
        console.log('No agent browser was running.');
    }
}

function stamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

if (mode === 'task') {
    closeAgentBrowser();
    console.log('Manual steps before the next task:');
    console.log('  1. Restore the mailbox to its documented initial state.');
    console.log('  2. Restart the inference server if residency has drifted '
        + 'from baseline (check /health used_gb).');
} else if (mode === 'arm') {
    closeAgentBrowser();
    const snap = path.join(SNAPS, stamp());
    fs.mkdirSync(snap, { recursive: true });
    for (const name of ['traces.db', 'router-traces.db']) {
        const from = path.join(DATA, name);
        if (fs.existsSync(from)) {
            fs.copyFileSync(from, path.join(snap, name));
            fs.rmSync(from);
        }
        for (const side of ['-wal', '-shm']) fs.rmSync(from + side, { force: true });
    }
    const procedures = path.join(DATA, 'procedures');
    if (fs.existsSync(procedures)) {
        fs.cpSync(procedures, path.join(snap, 'procedures'), { recursive: true });
        for (const file of fs.readdirSync(procedures)) {
            // Learned recipes start cold; a recipe written by hand is part
            // of the shipped system, not something the arm distilled.
            let handWritten = false;
            try { handWritten = /written by hand/.test(fs.readFileSync(path.join(procedures, file), 'utf8')); } catch {}
            if (handWritten) continue;
            fs.rmSync(path.join(procedures, file), { recursive: true });
        }
    }
    console.log(`Cold state set; snapshot kept at ${path.relative(ROOT, snap)}`);
    console.log('Restart the daemon so nothing holds the removed stores open.');
} else if (mode === 'restore') {
    const snap = process.argv[3];
    if (!snap || !fs.existsSync(snap)) {
        console.error('usage: eval-reset.js restore <snapshot-dir>');
        process.exit(1);
    }
    for (const name of ['traces.db', 'router-traces.db']) {
        const from = path.join(snap, name);
        if (fs.existsSync(from)) fs.copyFileSync(from, path.join(DATA, name));
    }
    const procedures = path.join(snap, 'procedures');
    if (fs.existsSync(procedures)) {
        fs.cpSync(procedures, path.join(DATA, 'procedures'), { recursive: true });
    }
    console.log('Snapshot restored; restart the daemon.');
} else {
    console.error('usage: eval-reset.js task|arm|restore <dir>');
    process.exit(1);
}
