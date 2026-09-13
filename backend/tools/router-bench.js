#!/usr/bin/env node
// One configuration of the router study, measured on the frozen catalogue:
//
//   node tools/router-bench.js --model <id> [--prompt v0|v1|v2|v3]
//        [--decoding free|json] [--stage two|single] [--split dev|test|all]
//        [--repeat K] [--limit n] [--ids a,b] [--warm 2] [--tag t]
//
// The model is requested by id, so config.json is never touched: the
// inference server loads any cached checkpoint on demand. Every item lands as
// one JSONL row under docs/measurements/router-study/runs/; a header row
// records the machine state. Runs are strictly sequential (shared lockfile).

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const STUDY = path.join(ROOT, 'docs', 'measurements', 'router-study');
const RUNS = path.join(STUDY, 'runs');
const LOCK = path.join(ROOT, 'docs', 'measurements', '.eval-run.lock');
const FROZEN = path.join(STUDY, 'skills-frozen');

function arg(name, fallback = null) {
    const at = process.argv.indexOf(`--${name}`);
    return at >= 0 ? process.argv[at + 1] : fallback;
}

const options = {
    model: arg('model'),
    prompt: arg('prompt', 'v0'),
    decoding: arg('decoding', 'free'),
    stage: arg('stage', 'two'),
    split: arg('split', 'dev'),
    repeat: Number(arg('repeat', 1)),
    limit: arg('limit') ? Number(arg('limit')) : null,
    ids: arg('ids') ? arg('ids').split(',') : null,
    warm: Number(arg('warm', 2)),
    tag: arg('tag', ''),
    set: arg('set', 'main'),
    catalogue: arg('catalogue')
};

if (!options.model || !['free', 'json'].includes(options.decoding)
    || !['two', 'single'].includes(options.stage) || !['dev', 'test', 'all'].includes(options.split)
    || !['main', 'final', 'supplement', 'safety'].includes(options.set)) {
    console.error('usage: router-bench.js --model <id> [--prompt v0|v1|v2|v3] [--decoding free|json] '
        + '[--stage two|single] [--split dev|test|all] [--set main|final|supplement|safety] [--repeat K] [--limit n] [--ids a,b] [--warm n] [--tag t]');
    process.exit(1);
}
if (!fs.existsSync(FROZEN) || !fs.existsSync(path.join(STUDY, 'split.json'))) {
    console.error('router set not built; run tools/router-set.js first');
    process.exit(1);
}

// Services must see the frozen catalogue before they load.
process.env.JARVIS_SKILLS_DIR = options.catalogue ? path.resolve(options.catalogue) : FROZEN;
const prompts = require('../services/prompts/router');
const router = require('../services/router');
const registry = require('../services/skillRegistry');

const slug = prompts.slug;

function hashDir(dir) {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256');
    const walk = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile()) { hash.update(path.relative(dir, full)); hash.update('\0'); hash.update(fs.readFileSync(full)); hash.update('\0'); }
        }
    };
    walk(dir);
    return hash.digest('hex');
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

function loadItems() {
    const split = JSON.parse(fs.readFileSync(path.join(STUDY, 'split.json'), 'utf8'));
    const file = options.set === 'main' ? 'items.jsonl' : `items-${options.set}.jsonl`;
    let items = fs.readFileSync(path.join(STUDY, file), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    if (options.set === 'main' && options.split !== 'all') items = items.filter(i => i.split === options.split);
    if (options.ids) items = items.filter(i => options.ids.includes(i.id));
    if (options.limit) items = items.slice(0, options.limit);
    return { items, split };
}

function scoreRow(item, decision) {
    return {
        actual: decision.intent_type,
        actual_skill: decision.target_skill || null,
        intent_correct: decision.intent_type === item.expected,
        skill_correct: item.skill ? decision.target_skill === item.skill : null,
        refused: decision.intent_type === 'refuse',
        action: decision.action,
        confidence: decision.confidence,
        schema_valid: Boolean(decision.schema_valid),
        attempts: decision.attempts,
        stages: decision.stages || (options.stage === 'single' ? 1 : null),
        latency_ms: decision.latency_ms,
        reasoning: decision.reasoning || null,
        raw: decision.schema_valid ? null : String(decision.raw_response || '').slice(0, 400)
    };
}

async function main() {
    const { items, split } = loadItems();
    if (!items.length) { console.error('no items selected'); process.exit(1); }

    const variant = prompts.load(options.prompt, options.model);
    const routeOptions = {
        model: options.model,
        decoding: options.decoding,
        twoStage: options.stage === 'two',
        prompts: variant.builtin ? router.BUILTIN_PROMPTS : variant
    };

    const health = await getJson('/health');
    if (!health) { console.error('inference server not reachable on 127.0.0.1:8787'); process.exit(1); }

    if (fs.existsSync(LOCK)) {
        console.error(`another measurement holds ${LOCK}; runs are strictly sequential`);
        process.exit(1);
    }
    fs.writeFileSync(LOCK, `${process.pid} router-bench ${new Date().toISOString()}\n`);
    process.on('exit', () => { try { fs.unlinkSync(LOCK); } catch {} });
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));

    fs.mkdirSync(RUNS, { recursive: true });
    const name = [slug(options.model), options.prompt, options.decoding, options.stage,
        options.set === 'main' ? options.split : options.set]
        .concat(options.tag ? [options.tag] : []).join('__');
    const outFile = path.join(RUNS, `${name}.jsonl`);
    const logFile = path.join(RUNS, `${name}.log`);
    const log = fs.createWriteStream(logFile, { flags: 'a' });
    const realLog = console.log, realWarn = console.warn, realError = console.error;
    const toFile = (...a) => log.write(a.map(String).join(' ') + '\n');
    console.log = toFile; console.warn = toFile; console.error = toFile;
    const say = (...a) => realLog(...a);

    const runId = new Date().toISOString();
    const header = {
        kind: 'header', run_id: runId, ...options,
        prompt_variant: variant.name,
        catalogue: process.env.JARVIS_SKILLS_DIR,
        catalogue_hash: options.catalogue ? hashDir(process.env.JARVIS_SKILLS_DIR) : split.catalogue_hash,
        frozen_catalogue_hash: split.catalogue_hash, test_lock: split.test_lock,
        catalogue_size: registry.list().length,
        machine: `${os.cpus()[0].model}, ${Math.round(os.totalmem() / 2 ** 30)} GB`,
        loadavg: os.loadavg().map(x => Number(x.toFixed(2))),
        residency_before: await getJson('/residency'),
        items: items.length
    };
    fs.appendFileSync(outFile, JSON.stringify(header) + '\n');
    say(`[router-bench] ${name}: ${items.length} items × ${options.repeat} repeat(s) → ${path.relative(ROOT, outFile)}`);

    const warmItems = items.slice(0, options.warm);
    for (const item of warmItems) {
        const t0 = Date.now();
        await router.route(item.prompt, routeOptions);
        say(`[router-bench] warm ${item.id} ${Date.now() - t0}ms`);
    }

    let correct = 0, total = 0;
    for (let repeat = 1; repeat <= options.repeat; repeat++) {
        for (const item of items) {
            let decision;
            try {
                decision = await router.route(item.prompt, routeOptions);
            } catch (err) {
                decision = { intent_type: 'error', schema_valid: false, attempts: 0, latency_ms: null, raw_response: err.message };
            }
            const row = {
                kind: 'item', run_id: runId, tag: options.tag || null, model: options.model, prompt: options.prompt,
                decoding: options.decoding, stage: options.stage, split: item.split, repeat,
                id: item.id, stratum: item.stratum, family: item.family,
                expected: item.expected, expected_skill: item.skill || null,
                safety: Boolean(item.safety), legit_alarming: Boolean(item.legit_alarming),
                ...scoreRow(item, decision)
            };
            fs.appendFileSync(outFile, JSON.stringify(row) + '\n');
            total += 1;
            if (row.intent_correct) correct += 1;
            process.stdout.write(row.intent_correct ? '.' : 'x');
        }
        process.stdout.write('\n');
    }
    const footer = { kind: 'footer', run_id: runId, finished: new Date().toISOString(),
        intent_accuracy: correct / total, n: total, residency_after: await getJson('/residency') };
    fs.appendFileSync(outFile, JSON.stringify(footer) + '\n');
    say(`[router-bench] intent accuracy ${(100 * correct / total).toFixed(1)}% (${correct}/${total})`);
    console.log = realLog; console.warn = realWarn; console.error = realError;
    log.end();
}

main().catch(err => { console.error(err); process.exit(1); });
