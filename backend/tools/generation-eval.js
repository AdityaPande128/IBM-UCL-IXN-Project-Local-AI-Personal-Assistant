#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const { TASKS } = require('./generation-tasks');
const generator = require('../services/skillGenerator');
const registry = require('../services/skillRegistry');
const executor = require('../services/skillExecutor');
const router = require('../services/router');
const configReader = require('../utils/configReader');

const config = configReader.readConfig();
const RESULTS_DIR = path.resolve(__dirname, '..', '..', 'ClawBenchmark');


function makeWorkdir(task) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `geneval-${task.id}-`)));
    for (const fixture of task.fixtures) {
        const target = path.join(dir, fixture.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, fixture.content);
    }
    return dir;
}

function runIndependentCheck(task, dir) {
    try {
        return task.check(dir);
    } catch (err) {
        return { passed: false, detail: `check threw: ${err.message}` };
    }
}

async function invokeSkill(skillName, prompt) {
    const skill = registry.get(skillName);
    if (!skill) return { ok: false, error: 'skill vanished from registry' };

    const routeStart = Date.now();
    const parameters = await router.extractParameters(skill, prompt);
    const routeMs = Date.now() - routeStart;

    const execStart = Date.now();
    const result = await executor.execute(skill, parameters);
    const execMs = Date.now() - execStart;

    return {
        ok: result.status === 'success',
        status: result.status,
        response: result.response,
        parameters,
        routeMs,
        execMs
    };
}

function runOpenClaw(prompt, timeoutMs = 180000) {
    return new Promise(resolve => {
        const started = Date.now();
        execFile('openclaw', [
            'agent', '--agent', 'main',
            '--session-key', `agent:main:geneval-${Date.now()}`,
            '--message', prompt, '--json'
        ], { timeout: timeoutMs }, (err, stdout, stderr) => {
            resolve({
                ok: !err,
                durationMs: Date.now() - started,
                error: err ? (err.killed ? 'timeout' : err.message) : null,
                output: (stdout || stderr || '').slice(0, 400)
            });
        });
    });
}


async function evaluateTask(task, options) {
    const record = { id: task.id, category: task.category };

    const workdir = makeWorkdir(task);
    const prompt = task.prompt.replace(/\{\{dir\}\}/g, workdir);
    record.prompt = prompt;

    const genStart = Date.now();
    const generation = await generator.generate(prompt);
    record.generateMs = Date.now() - genStart;
    record.generationStatus = generation.status;
    record.attempts = generation.attempts ?? null;
    record.skill = generation.skill ?? null;
    record.rejectionReason = generation.reason ?? null;

    if (generation.status !== 'registered' && generation.status !== 'duplicate') {
        record.outcome = 'not_registered';
        fs.rmSync(workdir, { recursive: true, force: true });
        return record;
    }

    const first = await invokeSkill(generation.skill, prompt);
    record.firstInvocation = { ok: first.ok, status: first.status, routeMs: first.routeMs, execMs: first.execMs };
    record.parameters = first.parameters;

    const verdict = runIndependentCheck(task, workdir);
    record.independentlyCorrect = verdict.passed;
    record.checkDetail = verdict.detail;

    const warmDir = makeWorkdir(task);
    const warmPrompt = task.prompt.replace(/\{\{dir\}\}/g, warmDir);
    const warm = await invokeSkill(generation.skill, warmPrompt);
    record.warmInvocation = { ok: warm.ok, routeMs: warm.routeMs, execMs: warm.execMs };
    record.warmCorrect = runIndependentCheck(task, warmDir).passed;

    record.coldTotalMs = record.generateMs + (first.routeMs || 0) + (first.execMs || 0);
    record.warmTotalMs = (warm.routeMs || 0) + (warm.execMs || 0);

    record.outcome = record.independentlyCorrect ? 'correct' : 'registered_but_wrong';

    if (options.baseline) {
        const baseDir = makeWorkdir(task);
        const basePrompt = task.prompt.replace(/\{\{dir\}\}/g, baseDir);
        const oc = await runOpenClaw(basePrompt);
        record.baseline = {
            ok: oc.ok,
            durationMs: oc.durationMs,
            independentlyCorrect: runIndependentCheck(task, baseDir).passed,
            error: oc.error
        };
        fs.rmSync(baseDir, { recursive: true, force: true });
    }

    fs.rmSync(workdir, { recursive: true, force: true });
    fs.rmSync(warmDir, { recursive: true, force: true });
    return record;
}


function report(records, options) {
    const n = records.length;
    const registered = records.filter(r => r.generationStatus === 'registered');
    const correct = records.filter(r => r.outcome === 'correct');
    const wrong = records.filter(r => r.outcome === 'registered_but_wrong');
    const notRegistered = records.filter(r => r.outcome === 'not_registered');

    const pct = (k, d) => d ? `${((k / d) * 100).toFixed(1)}%` : 'n/a';
    const mean = xs => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;

    console.log('\n' + '='.repeat(72));
    console.log('  SKILL GENERATION EVALUATION');
    console.log(`  model: ${config.generation?.model || config.model_id}`);
    console.log(`  tasks: ${n}`);
    console.log('='.repeat(72));
    console.log(`  Registered              ${registered.length}/${n}  (${pct(registered.length, n)})`);
    console.log(`  Independently correct   ${correct.length}/${n}  (${pct(correct.length, n)})`);
    console.log(`  Registered but WRONG    ${wrong.length}/${n}  — passed its own tests, failed ours`);
    console.log(`  Never registered        ${notRegistered.length}/${n}`);

    const firstTry = registered.filter(r => r.attempts === 1).length;
    console.log(`\n  First-attempt registrations  ${firstTry}/${registered.length}`);

    const colds = correct.map(r => r.coldTotalMs).filter(Boolean);
    const warms = correct.map(r => r.warmTotalMs).filter(Boolean);
    if (colds.length) {
        console.log(`\n  Cold (generate + run)   ${mean(colds)}ms`);
        console.log(`  Warm (run only)         ${mean(warms)}ms`);
        console.log(`  Speedup after learning  ${(mean(colds) / Math.max(mean(warms), 1)).toFixed(1)}x`);
    }

    const byCategory = {};
    for (const r of records) {
        byCategory[r.category] ??= { total: 0, correct: 0 };
        byCategory[r.category].total++;
        if (r.outcome === 'correct') byCategory[r.category].correct++;
    }
    console.log('\n  By category:');
    for (const [cat, s] of Object.entries(byCategory)) {
        console.log(`    ${cat.padEnd(16)} ${s.correct}/${s.total}`);
    }

    if (notRegistered.length) {
        console.log('\n  Never registered:');
        for (const r of notRegistered) {
            console.log(`    ${r.id}  ${String(r.rejectionReason).slice(0, 68)}`);
        }
    }
    if (wrong.length) {
        console.log('\n  Registered but independently wrong:');
        for (const r of wrong) {
            console.log(`    ${r.id}  ${String(r.checkDetail).slice(0, 68)}`);
        }
    }

    if (options.baseline) {
        const withBase = records.filter(r => r.baseline);
        const baseCorrect = withBase.filter(r => r.baseline.independentlyCorrect).length;
        console.log(`\n  BASELINE (OpenClaw, no skill system)`);
        console.log(`    Independently correct  ${baseCorrect}/${withBase.length}`);
        console.log(`    Mean duration          ${mean(withBase.map(r => r.baseline.durationMs))}ms`);
    }

    console.log('\n' + '='.repeat(72) + '\n');
}

async function main() {
    const args = process.argv.slice(2);
    const options = { baseline: args.includes('--baseline') };
    const selected = args.filter(a => !a.startsWith('--'));
    const tasks = selected.length ? TASKS.filter(t => selected.includes(t.id)) : TASKS;

    if (!tasks.length) {
        console.error('No matching tasks.');
        process.exit(1);
    }

    const records = [];
    for (const [index, task] of tasks.entries()) {
        process.stdout.write(`[${index + 1}/${tasks.length}] ${task.id} (${task.category}) ... `);
        const record = await evaluateTask(task, options);
        records.push(record);

        const tag = record.outcome === 'correct' ? 'CORRECT'
            : record.outcome === 'registered_but_wrong' ? 'WRONG'
            : 'NOT REGISTERED';
        console.log(`${tag}  (${record.attempts ?? '-'} attempt(s), ${Math.round(record.generateMs / 1000)}s)`);
    }

    const model = (config.generation?.model || config.model_id).split('/').pop();
    const outFile = path.join(RESULTS_DIR, `generation_eval_${model}.json`);
    fs.writeFileSync(outFile, JSON.stringify({ model, timestamp: new Date().toISOString(), records }, null, 2));

    report(records, options);
    console.log(`  Written to ${outFile}\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
