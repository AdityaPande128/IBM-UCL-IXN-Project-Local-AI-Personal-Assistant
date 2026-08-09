#!/usr/bin/env node
// Runs the skill-build dev set against the live pipeline and scores each entry
// on Suite C's three levels: proposed, installed, correct. Generated skills,
// pins and the ledger are confined to a throwaway directory so the real
// installation is untouched.

const fs = require('fs');
const os = require('os');
const path = require('path');

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-devset-'));
process.env.JARVIS_SKILLS_DIR = path.join(workspace, 'skills');
fs.mkdirSync(process.env.JARVIS_SKILLS_DIR, { recursive: true });

const generator = require('../../services/skillGenerator');
const skillRegistry = require('../../services/skillRegistry');
const skillExecutor = require('../../services/skillExecutor');
const skillPins = require('../../services/skillPins');
const ledger = require('../../services/generationLog');

skillPins.open(path.join(workspace, 'skill-pins.json'));

const devset = JSON.parse(fs.readFileSync(path.join(__dirname, 'devset.json'), 'utf8'));

function resolveTemplate(value, dir) {
    return String(value).replace('{dir}', dir);
}

function mapParameters(skill, entry, dir) {
    const supplied = {};
    for (const [name, spec] of Object.entries(skill.parameters || {})) {
        const hay = `${name} ${spec.description || ''}`.toLowerCase();
        if (entry.invoke.output !== undefined && /\bout|dest|target|result|new\b/.test(hay)) {
            supplied[name] = resolveTemplate(entry.invoke.output, dir);
        } else if (spec.type === 'number' && entry.invoke.number !== undefined) {
            supplied[name] = entry.invoke.number;
        } else if (entry.invoke.input !== undefined && spec.type !== 'number') {
            supplied[name] = resolveTemplate(entry.invoke.input, dir);
        }
    }
    return supplied;
}

function runChecks(entry, dir, stdout) {
    const failures = [];
    for (const check of entry.checks) {
        if (check.type === 'stdout_contains') {
            if (!stdout.includes(check.text)) failures.push(`stdout lacks "${check.text}"`);
        } else if (check.type === 'stdout_matches') {
            if (!new RegExp(check.pattern).test(stdout)) failures.push(`stdout does not match /${check.pattern}/`);
        } else {
            const target = resolveTemplate(check.path, dir);
            let content = null;
            try { content = fs.readFileSync(target, 'utf8'); } catch { }
            // Line endings are incidental unless the check itself targets them
            // (csv.writer emits \r\n; a correctly sorted file must not fail on that).
            if (content !== null && !check.text?.includes('\r')) {
                content = content.replace(/\r\n/g, '\n');
            }
            if (content === null) {
                failures.push(`missing file ${path.basename(target)}`);
            } else if (check.type === 'file_contains' && !content.includes(check.text)) {
                failures.push(`${path.basename(target)} lacks ${JSON.stringify(check.text)}`);
            } else if (check.type === 'file_not_contains' && content.includes(check.text)) {
                failures.push(`${path.basename(target)} still contains ${JSON.stringify(check.text)}`);
            }
        }
    }
    return failures;
}

async function scoreEntry(entry) {
    const dir = fs.mkdtempSync(path.join(workspace, `${entry.id}-`));
    for (const fixture of entry.fixtures || []) {
        const target = path.join(dir, fixture.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, fixture.content, 'utf8');
    }

    const before = ledger.read().length;
    const startedAt = Date.now();
    const generated = await generator.generate(entry.request);
    const record = ledger.read().slice(before).at(-1) || {};

    const result = {
        id: entry.id,
        proposed: ['parsed', 'static_check', 'verified', 'registered'].includes(record.stage),
        installed: generated.status === 'registered',
        correct: false,
        attempts: generated.attempts || null,
        seconds: Math.round((Date.now() - startedAt) / 1000),
        failure: generated.status === 'registered' ? null : (generated.reason || record.failure || 'unknown')
    };

    if (result.installed) {
        const skill = skillRegistry.get(generated.skill);
        const parameters = mapParameters(skill, entry, dir);
        const run = await skillExecutor.execute(skill, parameters);
        const failures = run.status === 'success'
            ? runChecks(entry, dir, run.stdout || run.response || '')
            : [`execution ${run.status}: ${(run.response || '').slice(0, 160)}`];
        result.correct = failures.length === 0;
        if (!result.correct) result.failure = failures.join('; ');
    }

    return result;
}

async function main() {
    const only = process.argv.slice(2);
    const entries = only.length ? devset.entries.filter(e => only.includes(e.id)) : devset.entries;
    const results = [];

    for (const entry of entries) {
        console.log(`\n=== ${entry.id} ===`);
        try {
            results.push(await scoreEntry(entry));
        } catch (err) {
            results.push({ id: entry.id, proposed: false, installed: false, correct: false, failure: err.message });
        }
        const r = results.at(-1);
        console.log(`    proposed=${r.proposed} installed=${r.installed} correct=${r.correct}` +
                    (r.failure ? `  (${r.failure.slice(0, 140)})` : ''));
    }

    const count = key => results.filter(r => r[key]).length;
    const summary = {
        ran_at: new Date().toISOString(),
        entries: results.length,
        proposed: count('proposed'),
        installed: count('installed'),
        correct: count('correct'),
        damaged: results.filter(r => r.installed && !r.correct).length,
        results
    };

    const stamp = summary.ran_at.replace(/[:.]/g, '-').slice(0, 19);
    const out = path.join(__dirname, 'results', `${stamp}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(summary, null, 2), 'utf8');

    console.log(`\nproposed ${summary.proposed}/${summary.entries}  installed ${summary.installed}/${summary.entries}  ` +
                `correct ${summary.correct}/${summary.entries}  damaged ${summary.damaged}`);
    console.log(`written to ${out}`);
    fs.rmSync(workspace, { recursive: true, force: true });
}

main().catch(err => { console.error(err); process.exit(1); });
