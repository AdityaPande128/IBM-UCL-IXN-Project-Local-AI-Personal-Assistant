#!/usr/bin/env node
// Stage B: the coder race. Arms (builder models) × prompt variants × seeds,
// over the G01-G20 tasks, interleaved so drift falls on every arm alike, in a
// throwaway builtin-only catalogue. After every block of tasks a Friedman
// test asks whether the arms differ at all; when it does, arms that lose an
// exact McNemar against the leader (Holm-adjusted) are dropped, F-Race style,
// and every drop is recorded. Resumable: rows already in the output are skipped.
//
//   node tools/eval-race.js --arms a,b,c [--prompts v0,v2] [--seeds 1,2]
//        [--tasks G01,G02] [--block 10] [--alpha 0.05] [--out path] [--no-race]

const argv = process.argv.slice(2);
function arg(name, fallback = null) {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : fallback;
}

const { makeScratchSkills } = require('./study-scratch');
process.env.JARVIS_SKILLS_DIR = makeScratchSkills({ label: 'race', builtinOnly: true });
process.on('exit', () => { try { require('fs').rmSync(process.env.JARVIS_SKILLS_DIR, { recursive: true, force: true }); } catch {} });

const fs = require('fs');
const os = require('os');
const path = require('path');
const { evaluateTask, TASKS } = require('./generation-eval');
const stats = require('./study-stats');

const ROOT = path.resolve(__dirname, '..', '..');
const LOCK = path.join(ROOT, 'docs', 'measurements', '.eval-run.lock');

const arms = (arg('arms') || '').split(',').filter(Boolean);
const promptsList = (arg('prompts') || 'v0').split(',');
const seeds = (arg('seeds') || '1').split(',').map(Number);
const taskIds = arg('tasks') ? arg('tasks').split(',') : TASKS.map(t => t.id);
const block = Number(arg('block', 10));
const alpha = Number(arg('alpha', 0.05));
const out = arg('out', path.join(ROOT, 'docs', 'measurements', 'coder-race.jsonl'));
const racing = !argv.includes('--no-race');

if (!arms.length) {
    console.error('usage: eval-race.js --arms <id,id,...> [--prompts v0,v2] [--seeds 1,2] [--tasks G01,...] [--block 10] [--alpha 0.05] [--out path] [--no-race]');
    process.exit(1);
}

function readRows() {
    if (!fs.existsSync(out)) return [];
    return fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function key(r) { return `${r.model}|${r.prompt}|${r.seed}|${r.id}`; }

function friedmanOverArms(rows, alive) {
    const blocks = new Map();
    for (const r of rows) {
        if (r.kind !== 'item' || !alive.includes(r.model)) continue;
        const b = `${r.prompt}|${r.seed}|${r.id}`;
        if (!blocks.has(b)) blocks.set(b, {});
        blocks.get(b)[r.model] = r.outcome === 'correct' ? 1 : 0;
    }
    const complete = [...blocks.values()].filter(b => alive.every(a => a in b));
    const matrix = complete.map(b => alive.map(a => b[a]));
    return { test: stats.friedman(matrix), matrix, blocks: complete };
}

function raceDecision(rows, alive) {
    const { test, matrix } = friedmanOverArms(rows, alive);
    const decision = { friedman: test, dropped: [], detail: [] };
    if (test.p === null || test.p >= alpha || alive.length < 2) return decision;
    const means = alive.map((_, j) => matrix.reduce((s, row) => s + row[j], 0) / matrix.length);
    const best = means.indexOf(Math.max(...means));
    const tests = alive.map((arm, j) => {
        if (j === best) return null;
        let b = 0, c = 0;
        for (const row of matrix) { if (row[best] && !row[j]) b++; if (!row[best] && row[j]) c++; }
        return { arm, b, c, p: stats.mcnemarExact(b, c).p, mean: means[j] };
    });
    const others = tests.filter(Boolean);
    const adjusted = stats.holm(others.map(t => t.p));
    others.forEach((t, i) => {
        t.p_holm = adjusted[i];
        decision.detail.push(t);
        if (t.p_holm < alpha && t.mean < means[best]) decision.dropped.push(t.arm);
    });
    decision.leader = alive[best];
    return decision;
}

async function main() {
    if (fs.existsSync(LOCK)) {
        console.error(`another measurement holds ${LOCK}; runs are strictly sequential`);
        process.exit(1);
    }
    fs.writeFileSync(LOCK, `${process.pid} eval-race ${new Date().toISOString()}\n`);
    process.on('exit', () => { try { fs.unlinkSync(LOCK); } catch {} });
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));

    fs.mkdirSync(path.dirname(out), { recursive: true });
    const existing = readRows();
    const done = new Set(existing.filter(r => r.kind === 'item').map(key));
    let alive = [...arms];
    // Recorded drops bind a resumed race; a --no-race pass runs every arm it is given.
    if (racing) for (const r of existing) if (r.kind === 'race' && r.dropped) alive = alive.filter(a => !r.dropped.includes(a));

    const tasks = taskIds.map(id => TASKS.find(t => t.id === id)).filter(Boolean);
    const total = tasks.length * seeds.length * promptsList.length * arms.length;
    fs.appendFileSync(out, JSON.stringify({ kind: 'header', ts: new Date().toISOString(), arms, prompts: promptsList,
        seeds, tasks: tasks.map(t => t.id), block, alpha, racing, skills_dir: process.env.JARVIS_SKILLS_DIR,
        loadavg: os.loadavg().map(x => Number(x.toFixed(2))), resumed: done.size }) + '\n');
    console.log(`[race] ${arms.length} arms × ${promptsList.length} prompts × ${seeds.length} seeds × ${tasks.length} tasks = ${total} runs (${done.size} already done); alive: ${alive.join(', ')}`);

    let sinceCheck = 0;
    for (const [ti, task] of tasks.entries()) {
        for (const seed of seeds) {
            for (const prompt of promptsList) {
                for (const model of arms) {
                    if (!alive.includes(model)) continue;
                    const probe = { model, prompt, seed, id: task.id };
                    if (done.has(key(probe))) continue;
                    process.stdout.write(`[race] ${task.id} s${seed} ${prompt} ${model.split('/').pop()} ... `);
                    let record;
                    try {
                        record = await evaluateTask(task, { model, prompt, seed, tag: 'race' });
                    } catch (err) {
                        record = { id: task.id, category: task.category, model, prompt, seed, outcome: 'error', error: err.message };
                    }
                    const row = { kind: 'item', ts: new Date().toISOString(), ...record };
                    fs.appendFileSync(out, JSON.stringify(row) + '\n');
                    done.add(key(row));
                    console.log(row.outcome === 'correct' ? 'CORRECT' : row.outcome.toUpperCase(),
                        record.generateMs ? `(${Math.round(record.generateMs / 1000)}s)` : '');
                }
            }
        }
        sinceCheck += 1;
        if (racing && sinceCheck >= block && alive.length > 1) {
            sinceCheck = 0;
            const decision = raceDecision(readRows(), alive);
            const row = { kind: 'race', ts: new Date().toISOString(), after_task: task.id, alive: [...alive], ...decision };
            fs.appendFileSync(out, JSON.stringify(row) + '\n');
            const f = decision.friedman;
            console.log(`[race] after ${ti + 1} tasks: Friedman chi2=${f.chi2 === null ? 'n/a' : f.chi2.toFixed(2)} df=${f.df} p=${f.p === null ? 'n/a' : f.p.toFixed(4)} (n=${f.n})`
                + (decision.dropped.length ? `; dropping ${decision.dropped.join(', ')}` : '; no arm dropped'));
            alive = alive.filter(a => !decision.dropped.includes(a));
        }
    }
    fs.appendFileSync(out, JSON.stringify({ kind: 'footer', ts: new Date().toISOString(), alive }) + '\n');
    console.log(`[race] finished; surviving arms: ${alive.join(', ')}`);
}

main().catch(err => { console.error(err); process.exit(1); });
