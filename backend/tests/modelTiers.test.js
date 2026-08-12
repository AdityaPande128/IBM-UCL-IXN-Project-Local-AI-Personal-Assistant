const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const modelTiers = require('../services/modelTiers');

const GB = 1024 ** 3;

const DEFAULTS = {
    '8': { guard: { model: 'org/guard-4b', policy: 'pinned' } },
    '16': {
        guard: { model: 'org/guard-4b', policy: 'pinned' },
        engine: { model: 'org/engine-8b', policy: 'resident' }
    },
    '24': {
        guard: { model: 'org/guard-4b', policy: 'pinned' },
        engine: { model: 'org/engine-8b', policy: 'resident' },
        smith: { model: 'org/smith-14b', policy: 'transient' }
    }
};

test('memory class rounds down and clamps to the table', () => {
    assert.strictEqual(modelTiers.memoryClass(DEFAULTS, 8 * GB), 8);
    assert.strictEqual(modelTiers.memoryClass(DEFAULTS, 12 * GB), 8);
    assert.strictEqual(modelTiers.memoryClass(DEFAULTS, 16 * GB), 16);
    assert.strictEqual(modelTiers.memoryClass(DEFAULTS, 18 * GB), 16);
    assert.strictEqual(modelTiers.memoryClass(DEFAULTS, 24 * GB), 24);
    assert.strictEqual(modelTiers.memoryClass(DEFAULTS, 64 * GB), 24);
    assert.strictEqual(modelTiers.memoryClass(DEFAULTS, 6 * GB), 8);
});

test('an explicit models.tiers wins over the hardware table', () => {
    const explicit = { guard: { model: 'org/other', policy: 'pinned' } };
    const config = { models: { tiers: explicit, hardware_defaults: DEFAULTS } };
    assert.strictEqual(modelTiers.effective(config, 24 * GB), explicit);
});

test('without explicit tiers the memory class picks the defaults', () => {
    const config = { models: { hardware_defaults: DEFAULTS } };
    assert.deepStrictEqual(modelTiers.effective(config, 24 * GB), DEFAULTS['24']);
    assert.deepStrictEqual(modelTiers.effective(config, 16 * GB), DEFAULTS['16']);
    assert.deepStrictEqual(modelTiers.effective(config, 8 * GB), DEFAULTS['8']);
});

test('no tiers and no table means an empty assignment, not a crash', () => {
    assert.deepStrictEqual(modelTiers.effective({}, 24 * GB), {});
    assert.deepStrictEqual(modelTiers.effective({ models: {} }, 24 * GB), {});
});

test('the shipped config resolves to a usable tier table on this machine', () => {
    const shipped = JSON.parse(fs.readFileSync(
        path.resolve(__dirname, '../../config.json'), 'utf8'));
    const tiers = modelTiers.effective(shipped);
    assert.ok(tiers.guard && tiers.guard.model, 'a guard tier is always named');
    assert.deepStrictEqual(tiers.guard, tiers.engine,
        'the guard runs on the engine\'s weights');

    // And with the explicit assignment removed, every hardware class the
    // table advertises keeps the guard on the engine's own model — one set
    // of weights, never a third.
    const models = { ...shipped.models };
    delete models.tiers;
    for (const gb of Object.keys(models.hardware_defaults).map(Number)) {
        const chosen = modelTiers.effective({ models }, gb * GB);
        assert.deepStrictEqual(chosen.guard, chosen.engine,
            `the ${gb} GB defaults keep the guard on the engine`);
        assert.ok(chosen.smith && chosen.smith.policy === 'transient',
            `the ${gb} GB defaults keep the smith transient`);
    }
});

test('editing a tier materializes the hardware defaults into config', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-tiers-'));
    const configPath = path.join(scratch, 'config.json');
    const shipped = JSON.parse(fs.readFileSync(
        path.resolve(__dirname, '../../config.json'), 'utf8'));
    delete shipped.models.tiers;
    fs.writeFileSync(configPath, JSON.stringify(shipped, null, 2));

    const previous = process.env.JARVIS_CONFIG_PATH;
    process.env.JARVIS_CONFIG_PATH = configPath;
    try {
        delete require.cache[require.resolve('../utils/configReader')];
        delete require.cache[require.resolve('../services/settings')];
        const settings = require('../services/settings');

        const result = settings.apply({
            tiers: { engine: { model: 'mlx-community/Qwen3-4B-Instruct-2507-4bit' } }
        });
        assert.strictEqual(result.status, 'applied');

        const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.ok(written.models.tiers, 'the effective table was pinned into config');
        assert.deepStrictEqual(written.models.tiers.guard, written.models.tiers.engine,
            'the guard follows the engine edit');
        assert.ok(written.models.tiers.smith, 'untouched tiers came along');
    } finally {
        if (previous === undefined) delete process.env.JARVIS_CONFIG_PATH;
        else process.env.JARVIS_CONFIG_PATH = previous;
        delete require.cache[require.resolve('../utils/configReader')];
        delete require.cache[require.resolve('../services/settings')];
        fs.rmSync(scratch, { recursive: true, force: true });
    }
});
