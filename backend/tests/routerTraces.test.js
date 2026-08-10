const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const routerTraces = require('../services/routerTraces');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-routertraces-'));
routerTraces.open(path.join(scratch, 'router-traces.db'));

function decision(overrides = {}) {
    return {
        intent_type: 'execute_existing',
        confidence: 0.9,
        reasoning: 'names an installed skill',
        target_skill: 'system-volume',
        schema_valid: true,
        ...overrides
    };
}

test('only outcome-confirmed decisions count as verified', () => {
    const confirmed = routerTraces.record('turn the volume down', decision());
    const pending = routerTraces.record('open the calculator', decision({ target_skill: 'app-launch' }));
    assert.ok(confirmed && pending);

    routerTraces.confirm(confirmed, 'executed');
    routerTraces.note(pending, 'error');

    const verified = routerTraces.verifiedDecisions();
    assert.strictEqual(verified.length, 1);
    assert.strictEqual(verified[0].prompt, 'turn the volume down');
    assert.strictEqual(verified[0].outcome, 'executed');

    const counts = routerTraces.counts();
    assert.strictEqual(counts.recorded, 2);
    assert.strictEqual(counts.verified, 1);
    assert.strictEqual(counts.act, 1);
});

test('a decision that failed its schema is never recorded', () => {
    assert.strictEqual(routerTraces.record('anything', decision({ schema_valid: false })), null);
    assert.strictEqual(routerTraces.record('anything', null), null);
});

test('the triage view maps intents back to act, tell and refuse', () => {
    assert.strictEqual(routerTraces.classOf('execute_existing'), 'act');
    assert.strictEqual(routerTraces.classOf('generate_new_skill'), 'act');
    assert.strictEqual(routerTraces.classOf('answer'), 'tell');
    assert.strictEqual(routerTraces.classOf('refuse'), 'refuse');
});

test('training pairs carry the guard prompt and the proven decision, one per request', () => {
    const first = routerTraces.record('what is a mutex', decision({
        intent_type: 'answer', target_skill: null, confidence: 0.8, reasoning: 'a question'
    }));
    routerTraces.confirm(first, 'answered');

    // The same request routed again later: the newest verified decision wins.
    const again = routerTraces.record('what is a mutex', decision({
        intent_type: 'answer', target_skill: null, confidence: 0.95, reasoning: 'still a question'
    }));
    routerTraces.confirm(again, 'answered');

    const pairs = routerTraces.trainingPairs(routerTraces.verifiedDecisions(), 'SYSTEM PROMPT');
    const mutex = pairs.filter(p => p.messages[1].content === 'what is a mutex');
    assert.strictEqual(mutex.length, 1, 'duplicate prompts collapse to the latest decision');

    const [system, user, assistant] = mutex[0].messages;
    assert.strictEqual(system.role, 'system');
    assert.strictEqual(system.content, 'SYSTEM PROMPT');
    assert.strictEqual(user.role, 'user');

    const target = JSON.parse(assistant.content);
    assert.strictEqual(target.intent_class, 'tell');
    assert.strictEqual(target.confidence, 0.95);
    assert.ok(target.reasoning);
});

test('the export tool writes mlx_lm chat data from a seeded store', () => {
    const { execFileSync } = require('child_process');

    // Seed a fresh store with enough verified decisions to split.
    const seededDb = path.join(scratch, 'seeded.db');
    routerTraces.open(seededDb);
    for (let i = 0; i < 30; i++) {
        const id = routerTraces.record(`set the volume to ${i} percent`, decision());
        routerTraces.confirm(id, 'executed');
    }

    const outDir = path.join(scratch, 'lora-out');
    const output = execFileSync('node',
        [path.resolve(__dirname, '..', 'tools', 'export-lora-traces.js'), outDir],
        { env: { ...process.env, JARVIS_ROUTER_TRACES_DB: seededDb }, encoding: 'utf8' });

    assert.ok(output.includes('30 pair(s)'), output);
    const train = fs.readFileSync(path.join(outDir, 'train.jsonl'), 'utf8').trim().split('\n');
    const valid = fs.readFileSync(path.join(outDir, 'valid.jsonl'), 'utf8').trim().split('\n');
    assert.strictEqual(train.length + valid.length, 30);
    assert.ok(valid.length >= 1, 'mlx_lm needs a non-empty validation set');

    for (const line of [...train, ...valid]) {
        const record = JSON.parse(line);
        assert.strictEqual(record.messages.length, 3);
        const target = JSON.parse(record.messages[2].content);
        assert.strictEqual(target.intent_class, 'act');
    }

    // An empty store is a refusal, not an empty file.
    const emptyDb = path.join(scratch, 'empty.db');
    routerTraces.open(emptyDb);
    routerTraces.counts();
    assert.throws(() => execFileSync('node',
        [path.resolve(__dirname, '..', 'tools', 'export-lora-traces.js'), path.join(scratch, 'x')],
        { env: { ...process.env, JARVIS_ROUTER_TRACES_DB: emptyDb }, encoding: 'utf8' }));
});
