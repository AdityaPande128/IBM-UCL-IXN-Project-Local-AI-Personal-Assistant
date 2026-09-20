#!/usr/bin/env node
// The joint factorial: routers × coders × smith prompts, each request run the
// way the product runs it — route, plan, generate, install, invoke, check —
// under the shipped memory budget, so interactions between the two tiers land
// as outcomes instead of hiding. The router model also serves the planner and
// parameter extraction (they share the engine tier), which is the point.
//
//   node tools/eval-joint.js --routers id:prompt,id:prompt --coders id,id
//        [--prompts v0,v2] [--seeds 1] [--tasks G01,G02] [--out path]
//
// Resumable by row key; interleaved task-major so drift falls on every
// configuration alike; throwaway builtin-only catalogue cleaned per task.

const argv = process.argv.slice(2);
function arg(name, fallback = null) {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : fallback;
}

const { makeScratchSkills } = require('./study-scratch');
process.env.JARVIS_SKILLS_DIR = makeScratchSkills({ label: 'joint', builtinOnly: true });
process.on('exit', () => { try { require('fs').rmSync(process.env.JARVIS_SKILLS_DIR, { recursive: true, force: true }); } catch {} });

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { TASKS, removeSkill, makeWorkdir, runIndependentCheck, invokeSkill } = require('./generation-eval');
const routerPrompts = require('../services/prompts/router');
const smithPrompts = require('../services/prompts/smith');
const router = require('../services/router');
const planner = require('../services/planner');
const planExecutor = require('../services/planExecutor');
const generator = require('../services/skillGenerator');
const registry = require('../services/skillRegistry');

const ROOT = path.resolve(__dirname, '..', '..');
const LOCK = path.join(ROOT, 'docs', 'measurements', '.eval-run.lock');

const routers = (arg('routers') || '').split(',').filter(Boolean).map(spec => {
    const [model, prompt] = spec.split(':');
    return { model, prompt: prompt || 'v0' };
});
const coders = (arg('coders') || '').split(',').filter(Boolean);
const smithPromptList = (arg('prompts') || 'v0,v2').split(',');
const seeds = (arg('seeds') || '1').split(',').map(Number);
const taskIds = arg('tasks') ? arg('tasks').split(',') : TASKS.map(t => t.id);
const out = arg('out', path.join(ROOT, 'docs', 'measurements', 'joint-factorial.jsonl'));

if (!routers.length || !coders.length) {
    console.error('usage: eval-joint.js --routers id:prompt,... --coders id,... [--prompts v0,v2] [--seeds 1] [--tasks G01,...] [--out path]');
    process.exit(1);
}

function getJson(pathname) {
    return new Promise((resolve) => {
        const req = http.get({ hostname: '127.0.0.1', port: 8787, path: pathname, timeout: 5000 }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

function readRows() {
    if (!fs.existsSync(out)) return [];
    return fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}
function key(r) { return `${r.router}|${r.routerPrompt}|${r.coder}|${r.coderPrompt}|${r.seed}|${r.id}`; }

function setTiers(routerModel, coderModel) {
    process.env.JARVIS_STUDY_TIER_GUARD = routerModel;
    process.env.JARVIS_STUDY_TIER_ENGINE = routerModel;
    process.env.JARVIS_STUDY_TIER_SMITH = coderModel;
}

async function runOne(cfg, task, seed) {
    const row = {
        kind: 'run', at: new Date().toISOString(),
        router: cfg.router.model, routerPrompt: cfg.router.prompt,
        coder: cfg.coder, coderPrompt: cfg.smithPrompt, seed, id: task.id, category: task.category
    };
    setTiers(cfg.router.model, cfg.coder);
    const workdir = makeWorkdir(task);
    const prompt = task.prompt.replace(/\{\{dir\}\}/g, workdir);
    const t0 = Date.now();
    row.residency_before = await getJson('/residency');
    try {
        const variant = routerPrompts.load(cfg.router.prompt, cfg.router.model);
        const decision = await router.route(prompt, {
            model: cfg.router.model, decoding: 'free', twoStage: true,
            ...(variant.builtin ? {} : { prompts: variant })
        });
        row.route = {
            intent: decision.intent_type, action: decision.action, skill: decision.target_skill || null,
            confidence: decision.confidence ?? null, attempts: decision.attempts ?? null,
            latency_ms: decision.latency_ms ?? null, schema_valid: Boolean(decision.schema_valid)
        };
        let skillName = null;
        if (decision.action === router.ACTIONS.GENERATE) {
            const p0 = Date.now();
            let plan;
            try { plan = await planner.plan(prompt); } catch (err) { plan = { status: 'error', reason: err.message, missing: [] }; }
            row.plan = { status: plan.status, missing: plan.missing || [], ms: Date.now() - p0 };
            if (plan.status === 'planned' && !(plan.missing || []).length && (plan.steps || []).length) {
                const e0 = Date.now();
                const execution = await planExecutor.run(plan, { request: prompt });
                row.composed = { status: execution.status, steps: execution.total ?? null, ms: Date.now() - e0 };
                row.outcome = execution.status === 'success' ? 'composed' : 'compose_failed';
            } else {
                const g0 = Date.now();
                const genOptions = { gaps: plan.missing || [], model: cfg.coder, seed };
                if (cfg.smithPrompt !== 'v0') genOptions.promptBuilder = smithPrompts.load(cfg.smithPrompt, cfg.coder).build;
                const generation = await generator.generate(prompt, genOptions);
                row.generation = { status: generation.status, attempts: generation.attempts ?? null, reason: generation.reason ?? null, ms: Date.now() - g0 };
                if (generation.status === 'registered' || generation.status === 'duplicate') {
                    skillName = generation.skill;
                } else {
                    row.outcome = 'not_registered';
                }
            }
        } else if (decision.action === router.ACTIONS.EXECUTE) {
            skillName = decision.target_skill;
            row.outcome = registry.get(skillName) ? null : 'misrouted_execute_unknown_skill';
            if (row.outcome) skillName = null;
            else row.misrouted = 'execute_existing';
        } else {
            row.outcome = `misrouted_${decision.action}`;
        }
        if (skillName) {
            const inv = await invokeSkill(skillName, prompt);
            row.invocation = { ok: inv.ok, status: inv.status, routeMs: inv.routeMs, execMs: inv.execMs };
            row.skill = skillName;
        }
        if (row.outcome === null || row.outcome === undefined || row.outcome === 'composed') {
            const verdict = runIndependentCheck(task, workdir);
            row.check = verdict.detail;
            if (row.outcome !== 'composed') {
                row.outcome = verdict.passed ? 'correct'
                    : (row.misrouted ? 'misrouted_execute_wrong' : 'registered_but_wrong');
            }
            row.correct = verdict.passed;
        } else {
            row.correct = false;
        }
        if (skillName && row.generation && row.generation.status === 'registered') removeSkill(skillName);
    } catch (err) {
        row.outcome = 'error'; row.correct = false; row.error = String(err.message || err).slice(0, 300);
    }
    row.total_ms = Date.now() - t0;
    row.residency_after = await getJson('/residency');
    row.health_after = await getJson('/health');
    // The guarantee, checked rather than assumed: nothing but this pair was resident.
    const resident = ((row.health_after || {}).llm || {}).resident || [];
    const allowed = new Set([cfg.router.model, cfg.coder].map(m => m.replace(/^\/.*\//, '')));
    row.residency_ok = resident.every(m => allowed.has(m) || allowed.has(m.replace(/^\/.*\//, '')));
    row.budget_gb = ((row.health_after || {}).llm || {}).budget_gb ?? null;
    fs.rmSync(workdir, { recursive: true, force: true });
    return row;
}

async function main() {
    if (fs.existsSync(LOCK)) { console.error(`another measurement holds ${LOCK}; runs are strictly sequential`); process.exit(1); }
    fs.writeFileSync(LOCK, `${process.pid} eval-joint ${new Date().toISOString()}\n`);
    process.on('exit', () => { try { fs.unlinkSync(LOCK); } catch {} });
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));

    const configs = [];
    for (const r of routers) for (const c of coders) for (const sp of smithPromptList) configs.push({ router: r, coder: c, smithPrompt: sp });
    const tasks = TASKS.filter(t => taskIds.includes(t.id));
    const done = new Set(readRows().filter(r => r.kind === 'run').map(key));
    const total = configs.length * seeds.length * tasks.length;
    console.log(`[joint] ${routers.length} routers × ${coders.length} coders × ${smithPromptList.length} smith prompts × ${seeds.length} seeds × ${tasks.length} tasks = ${total} runs (${done.size} already done)`);
    if (!done.size) {
        fs.appendFileSync(out, JSON.stringify({
            kind: 'header', at: new Date().toISOString(), routers, coders, smithPrompts: smithPromptList, seeds, tasks: tasks.map(t => t.id),
            machine: `${os.platform()} ${os.arch()} ${os.cpus().length} cores ${Math.round(os.totalmem() / 2 ** 30)} GB`,
            catalogue_size: registry.list().length, skills_dir: process.env.JARVIS_SKILLS_DIR, health: await getJson('/health'),
            loadavg: os.loadavg().map(x => Number(x.toFixed(2))), residency: await getJson('/residency'), node: process.version
        }) + '\n');
    }
    let n = done.size;
    for (const task of tasks) for (const seed of seeds) for (const cfg of configs) {
        const probe = { router: cfg.router.model, routerPrompt: cfg.router.prompt, coder: cfg.coder, coderPrompt: cfg.smithPrompt, seed, id: task.id };
        if (done.has(key(probe))) continue;
        process.stdout.write(`[joint] ${task.id} s${seed} ${cfg.router.model.split('/').pop()}/${cfg.router.prompt} + ${cfg.coder.split('/').pop()}/${cfg.smithPrompt} ... `);
        const row = await runOne(cfg, task, seed);
        fs.appendFileSync(out, JSON.stringify(row) + '\n');
        n += 1;
        console.log(`${row.outcome.toUpperCase()} ${(row.total_ms / 1000).toFixed(0)}s (${n}/${total})`);
    }
    const rows = readRows().filter(r => r.kind === 'run');
    const tally = {};
    for (const r of rows) {
        const k = `${r.router.split('/').pop()}/${r.routerPrompt} + ${r.coder.split('/').pop()}/${r.coderPrompt}`;
        tally[k] ??= { n: 0, correct: 0, misrouted: 0, composed: 0 };
        tally[k].n += 1; if (r.correct) tally[k].correct += 1;
        if (String(r.outcome).startsWith('misrouted')) tally[k].misrouted += 1;
        if (r.outcome === 'composed') tally[k].composed += 1;
    }
    console.log('[joint] finished');
    for (const [k, t] of Object.entries(tally).sort((a, b) => b[1].correct / b[1].n - a[1].correct / a[1].n)) {
        console.log(`  ${k.padEnd(70)} ${t.correct}/${t.n} correct, ${t.misrouted} misrouted, ${t.composed} composed`);
    }
}

main().catch(err => { console.error(err); process.exit(1); });
