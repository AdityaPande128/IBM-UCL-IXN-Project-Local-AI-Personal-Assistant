const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const modelCatalog = require('../services/modelCatalog');
const modelDownloads = require('../services/modelDownloads');

const GB = 1024 ** 3;

const QWEN4B = 'mlx-community/Qwen3-4B-Instruct-2507-4bit';
const GRANITE = 'mlx-community/granite-4.1-8b-4bit';
const CODER3B = 'mlx-community/Qwen2.5-Coder-3B-Instruct-4bit';
const CODER14B = 'mlx-community/Qwen2.5-Coder-14B-Instruct-4bit';

function testConfig() {
    const config = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', '..', 'config.json'), 'utf8'));
    // The machine this suite runs on has a real profile; the tests reason
    // about a Mac that has none.
    delete config.profile;
    return config;
}


test('a model shared by two tiers is budgeted once, not twice', () => {
    const config = testConfig();
    const tiers = {
        guard: { model: GRANITE, policy: 'resident' },
        engine: { model: GRANITE, policy: 'resident' }
    };
    // On the 16 GB budget (9 GB minus voice), one granite fits and a
    // double-counted one would not — the old per-tier sum refused this.
    assert.strictEqual(
        modelCatalog.budgetError(config, tiers, { budget_gb: 9 }),
        null);
});

test('the formula still refuses what genuinely does not fit', () => {
    const config = testConfig();
    const tiers = {
        guard: { model: GRANITE, policy: 'resident' },
        engine: { model: GRANITE, policy: 'resident' },
        smith: { model: CODER14B, policy: 'pinned' }
    };
    // A pinned 14B next to a resident granite blows a 9 GB budget.
    assert.match(
        modelCatalog.budgetError(config, tiers, { budget_gb: 9 }),
        /available for models/);
});

test('selections are floored at the catalog: an unlisted engine is refused', () => {
    const config = testConfig();
    const checked = modelCatalog.checkSelection(config, {
        engine: 'mlx-community/SomeRandom-70B', smith: null, voice: false
    }, 24 * GB);
    assert.strictEqual(checked.ok, false);
    assert.match(checked.error, /not one of the offered base models/);
});

test('the 24 GB class accepts the full recommended selection', () => {
    const config = testConfig();
    const checked = modelCatalog.checkSelection(config, {
        engine: GRANITE, smith: CODER14B, voice: true, tts: true
    }, 24 * GB);
    assert.strictEqual(checked.error, null);
    assert.strictEqual(checked.ok, true);
});

test('an 8 GB machine refuses the 8B engine but accepts the 4B', () => {
    const config = testConfig();
    const total = 8 * GB;

    const big = modelCatalog.checkSelection(config,
        { engine: GRANITE, smith: null, voice: true }, total);
    assert.strictEqual(big.ok, false);

    const small = modelCatalog.checkSelection(config,
        { engine: QWEN4B, smith: CODER3B, voice: true }, total);
    assert.strictEqual(small.error, null);
});

test('turning voice off returns its reserve to the models', () => {
    const config = testConfig();
    const tiers = { engine: { model: QWEN4B, policy: 'resident' } };
    // 2.109 GB against a 4 GB budget: fails with the 1.83 GB voice
    // reserve held back (2.17 available), fits without it.
    assert.strictEqual(
        modelCatalog.budgetError(config, tiers, { budget_gb: 4, voice: false }),
        null);
    assert.match(
        modelCatalog.budgetError(config, tiers, { budget_gb: 3.9, voice: true }),
        /available for models/);
});

test('describe recommends this machine\'s class defaults and marks them', () => {
    const config = testConfig();
    const described = modelCatalog.describe(config, 24 * GB);

    assert.strictEqual(described.machine.class, 24);
    assert.strictEqual(described.budget_gb, 14);
    const recommendedEngine = described.engines.find(e => e.recommended);
    const recommendedSmith = described.smiths.find(e => e.recommended);
    assert.strictEqual(recommendedEngine.model, GRANITE);
    assert.strictEqual(recommendedSmith.model,
        'mlx-community/Qwen2.5-Coder-7B-Instruct-4bit');
    assert.ok(described.voice.stt && described.voice.stt.disk_gb > 0);
});


test('downloaded() judges the hub cache honestly', t => {
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cache-'));
    const previous = process.env.HF_HUB_CACHE;
    process.env.HF_HUB_CACHE = cache;
    t.after(() => {
        if (previous === undefined) delete process.env.HF_HUB_CACHE;
        else process.env.HF_HUB_CACHE = previous;
        fs.rmSync(cache, { recursive: true, force: true });
    });

    const repo = path.join(cache, 'models--org--tiny');
    assert.strictEqual(modelCatalog.downloaded('org/tiny'), false, 'absent repo');

    const blobs = path.join(repo, 'blobs');
    const snapshot = path.join(repo, 'snapshots', 'rev1');
    fs.mkdirSync(blobs, { recursive: true });
    fs.mkdirSync(snapshot, { recursive: true });
    fs.writeFileSync(path.join(blobs, 'aaa'), 'weights');
    fs.symlinkSync(path.join(blobs, 'aaa'), path.join(snapshot, 'model.safetensors'));
    assert.strictEqual(modelCatalog.downloaded('org/tiny'), true, 'complete repo');

    fs.writeFileSync(path.join(blobs, 'bbb.incomplete'), 'partial');
    assert.strictEqual(modelCatalog.downloaded('org/tiny'), false, 'partial blob present');
    fs.rmSync(path.join(blobs, 'bbb.incomplete'));

    fs.symlinkSync(path.join(blobs, 'gone'), path.join(snapshot, 'tokenizer.json'));
    assert.strictEqual(modelCatalog.downloaded('org/tiny'), false, 'dangling snapshot link');
});


function withTempConfig(t, mutate) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-config-'));
    const file = path.join(dir, 'config.json');
    const config = testConfig();
    if (mutate) mutate(config);
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');

    const previous = process.env.JARVIS_CONFIG_PATH;
    process.env.JARVIS_CONFIG_PATH = file;
    t.after(() => {
        if (previous === undefined) delete process.env.JARVIS_CONFIG_PATH;
        else process.env.JARVIS_CONFIG_PATH = previous;
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return file;
}

test('the guard cannot be edited directly and follows the engine', t => {
    const file = withTempConfig(t);
    const settings = require('../services/settings');

    const direct = settings.apply({ tiers: { guard: { model: QWEN4B } } });
    assert.strictEqual(direct.status, 'invalid');
    assert.match(direct.error, /guard runs on the engine/);

    const viaEngine = settings.apply({ tiers: { engine: { model: QWEN4B } } });
    assert.strictEqual(viaEngine.status, 'applied');
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(written.models.tiers.engine.model, QWEN4B);
    assert.deepStrictEqual(written.models.tiers.guard, written.models.tiers.engine);
});

test('settings refuse an engine from outside the catalog', t => {
    withTempConfig(t);
    const settings = require('../services/settings');
    const result = settings.apply({ tiers: { engine: { model: 'mlx-community/Rogue-32B' } } });
    assert.strictEqual(result.status, 'invalid');
    assert.match(result.error, /not one of the offered engine models/);
});

test('a profile is validated, written and read back whole', t => {
    const file = withTempConfig(t);
    const profile = require('../services/profile');

    assert.strictEqual(profile.apply({ mode: 'chaos' }).status, 'invalid');
    assert.strictEqual(profile.apply({ name: '   ' }).status, 'invalid');
    assert.strictEqual(profile.apply({ theme: 'sepia' }).status, 'invalid');

    // No profile on disk: improvement stays on — absence is not a choice.
    assert.strictEqual(profile.improvementEnabled(), true);

    const applied = profile.apply({
        name: 'Aditya', theme: 'light', mode: 'jarvis',
        improvement: false, voice: { enabled: true, tts: false }
    });
    assert.strictEqual(applied.status, 'applied');

    const read = profile.read(JSON.parse(fs.readFileSync(file, 'utf8')));
    assert.strictEqual(read.name, 'Aditya');
    assert.strictEqual(read.theme, 'light');
    assert.strictEqual(read.voice.enabled, true);
    assert.strictEqual(read.onboarded, false);
    // A recorded "off" is honoured.
    assert.strictEqual(profile.improvementEnabled(), false);

    assert.strictEqual(profile.apply({ onboarded: true }).profile.onboarded, true);
});


function stubDownloader(dir, body) {
    const script = path.join(dir, 'download.py');
    fs.writeFileSync(script, body);
    return script;
}

function makeManager(t, body, downloadedFn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'downloads-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return {
        dir,
        file: path.join(dir, 'queue.json'),
        manager: modelDownloads.createManager({
            file: path.join(dir, 'queue.json'),
            script: stubDownloader(dir, body),
            downloaded: downloadedFn || (() => false)
        })
    };
}

function waitFor(predicate, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
            if (predicate()) { clearInterval(timer); resolve(); }
            else if (Date.now() - started > timeoutMs) {
                clearInterval(timer);
                reject(new Error('condition never became true'));
            }
        }, 25);
    });
}

const QUICK_SCRIPT = [
    'import json, sys',
    'print(json.dumps({"total": 100}), flush=True)',
    'print(json.dumps({"received": 100, "total": 100, "done": True}), flush=True)'
].join('\n') + '\n';

const SLOW_SCRIPT = [
    'import json, sys, time',
    'print(json.dumps({"total": 1000}), flush=True)',
    'for i in range(200):',
    '    print(json.dumps({"received": i * 5, "total": 1000}), flush=True)',
    '    time.sleep(0.1)'
].join('\n') + '\n';

test('downloads run in order and settle as done', async t => {
    const { manager } = makeManager(t, QUICK_SCRIPT);
    const events = [];
    manager.subscribe(job => events.push({ model: job.model, status: job.status }));

    manager.enqueue([
        { model: 'org/base', kind: 'engine' },
        { model: 'org/improver', kind: 'smith' }
    ]);
    await waitFor(() => manager.status().queue.every(j => j.status === 'done'));

    const finished = manager.status().queue;
    assert.deepStrictEqual(finished.map(j => j.model), ['org/base', 'org/improver']);
    assert.ok(finished.every(j => j.received_bytes === 100));
    // The base model must have finished before the improver started.
    const baseDone = events.findIndex(e => e.model === 'org/base' && e.status === 'done');
    const improverStarts = events.findIndex(
        e => e.model === 'org/improver' && e.status === 'downloading');
    assert.ok(baseDone !== -1 && improverStarts > baseDone);
});

test('a download can be stopped, and started again by name', async t => {
    const { manager } = makeManager(t, SLOW_SCRIPT);

    manager.enqueue([{ model: 'org/slow', kind: 'engine' }]);
    await waitFor(() => manager.status().queue[0].status === 'downloading');

    manager.stop('org/slow');
    await waitFor(() => manager.status().queue[0].status === 'stopped');
    assert.strictEqual(manager.status().active, null);

    manager.start('org/slow');
    await waitFor(() => manager.status().queue[0].status === 'downloading');
    manager.stop('org/slow');
    await waitFor(() => manager.status().queue[0].status === 'stopped');
});

test('a failing downloader surfaces its error instead of hanging the queue', async t => {
    const { manager } = makeManager(t, [
        'import sys',
        'print("no network", file=sys.stderr)',
        'sys.exit(1)'
    ].join('\n') + '\n');

    manager.enqueue([
        { model: 'org/broken', kind: 'engine' },
        { model: 'org/next', kind: 'smith' }
    ]);
    await waitFor(() => manager.status().queue[1].status !== 'queued'
        || manager.status().queue[0].status === 'error');
    await waitFor(() => manager.status().queue.every(
        j => j.status === 'error' || j.status === 'done'));

    const [broken] = manager.status().queue;
    assert.strictEqual(broken.status, 'error');
    assert.match(broken.error, /no network/);
});

test('a deferred queue is persisted for the next boot, which resumes it', async t => {
    const first = makeManager(t, QUICK_SCRIPT);
    first.manager.enqueue([{ model: 'org/later', kind: 'engine' }], { defer: true });

    // Deferred: persisted as queued, nothing spawned.
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.strictEqual(first.manager.status().queue[0].status, 'queued');
    const stored = JSON.parse(fs.readFileSync(first.file, 'utf8'));
    assert.deepStrictEqual(stored.queue, [
        { model: 'org/later', kind: 'engine', status: 'queued' }]);

    // "Next boot": a fresh manager over the same file picks the work up.
    const second = modelDownloads.createManager({
        file: first.file,
        script: path.join(first.dir, 'download.py'),
        downloaded: () => false
    });
    second.resume();
    await waitFor(() => second.status().queue[0].status === 'done');
});

test('resume trusts the disk over the stored status', async t => {
    const { manager, file } = makeManager(t, QUICK_SCRIPT, model => model === 'org/have');
    fs.writeFileSync(file, JSON.stringify({ queue: [
        { model: 'org/have', kind: 'engine', status: 'queued' },
        { model: 'org/stopped', kind: 'smith', status: 'stopped' }
    ] }) + '\n');

    manager.resume();
    await waitFor(() => manager.status().queue[0].status === 'done');
    // What the user stopped stays stopped; what is already on disk is done.
    assert.strictEqual(manager.status().queue[1].status, 'stopped');
});

test('models already on disk are marked done without spawning anything', () => {
    const manager = modelDownloads.createManager({
        file: path.join(os.tmpdir(), `noop-${Date.now()}.json`),
        script: '/nonexistent/download.py',
        downloaded: () => true
    });
    manager.enqueue([{ model: 'org/cached', kind: 'engine' }]);
    assert.strictEqual(manager.status().queue[0].status, 'done');
});
