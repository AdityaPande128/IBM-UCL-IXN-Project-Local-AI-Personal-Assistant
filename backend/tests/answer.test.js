const test = require('node:test');
const assert = require('node:assert');

const answerService = require('../services/answerService');
const skillRegistry = require('../services/skillRegistry');

test('capability source claims questions about what the assistant can do', () => {
    const { matches } = answerService.capabilitySource;

    assert.ok(matches('what can you do'));
    assert.ok(matches('What are you capable of?'));
    assert.ok(matches('list your skills'));
    assert.ok(matches('can Jarvis help with CSV files'));
});

test('capability source does not claim unrelated questions', () => {
    const { matches } = answerService.capabilitySource;

    assert.ok(!matches('what is the capital of France'));
    assert.ok(!matches('how do I write a for loop in python'));
});

test('capability source answers from the registry, not a hardcoded list', async () => {
    const [passage] = await answerService.capabilitySource.retrieve('what can you do');
    const installed = skillRegistry.list();

    assert.match(passage.text, new RegExp(`${installed.length} installed skills`));
    for (const skill of installed) {
        assert.ok(
            passage.text.includes(skill.name),
            `"${skill.name}" missing from the capability answer`
        );
    }
});


test('a source that throws during triage does not break the answer', async () => {
    answerService.clearSources();
    answerService.registerSource({
        name: 'exploding',
        matches() { throw new Error('boom'); },
        async retrieve() { return [{ text: 'unreachable', cite: 'x' }]; }
    });
    answerService.registerSource({
        name: 'healthy',
        matches: () => true,
        retrieve: async () => [{ text: 'good context', cite: 'ok' }]
    });

    const gathered = await answerService.gather('anything');

    assert.strictEqual(gathered.length, 1);
    assert.strictEqual(gathered[0].cite, 'ok');
});

test('a source that throws during retrieval degrades to ungrounded, not to an error', async () => {
    answerService.clearSources();
    answerService.registerSource({
        name: 'exploding',
        matches: () => true,
        async retrieve() { throw new Error('index unavailable'); }
    });

    const gathered = await answerService.gather('anything');

    assert.deepStrictEqual(gathered, []);
});

test('empty passages are discarded so they cannot fake grounding', async () => {
    answerService.clearSources();
    answerService.registerSource({
        name: 'blank',
        matches: () => true,
        retrieve: async () => [{ text: '   ', cite: 'nothing' }]
    });

    assert.deepStrictEqual(await answerService.gather('anything'), []);
});


test('fit keeps whole passages and stops at the budget', () => {
    const passages = [
        { text: 'a'.repeat(50), cite: 'one' },
        { text: 'b'.repeat(50), cite: 'two' },
        { text: 'c'.repeat(50), cite: 'three' }
    ];

    const kept = answerService.fit(passages, 130);

    assert.strictEqual(kept.length, 2);
    assert.deepStrictEqual(kept.map(p => p.cite), ['one', 'two']);
});

test('the only passage there is gets truncated rather than dropped', () => {
    const kept = answerService.fit([{ text: 'x'.repeat(9999), cite: 'huge' }], 100);

    assert.strictEqual(kept.length, 1);
    assert.ok(kept[0].block.length <= 100);
    assert.strictEqual(kept[0].truncated, true);
});

test('an oversized passage is still dropped whole when something else fits', () => {
    const kept = answerService.fit([
        { text: 'a'.repeat(50), cite: 'one' },
        { text: 'b'.repeat(9999), cite: 'huge' }
    ], 130);

    assert.deepStrictEqual(kept.map(p => p.cite), ['one']);
});


test('a malformed source is rejected at registration', () => {
    answerService.clearSources();
    assert.throws(() => answerService.registerSource({ name: 'partial' }), /matches/);
});

test.after(() => {
    answerService.clearSources();
    answerService.registerSource(answerService.capabilitySource);
});


test('the global margin drops a source whose best hit is globally weak', () => {
    const kept = answerService.applyGlobalMargin([
        { text: 'a', cite: 'doc', score: 0.80 },
        { text: 'b', cite: 'mail-1', score: 0.67 },
        { text: 'c', cite: 'mail-2', score: 0.58 }
    ], 0.12);

    assert.deepStrictEqual(kept.map(p => p.cite), ['doc']);
});

test('the global margin keeps genuinely close hits', () => {
    const kept = answerService.applyGlobalMargin([
        { text: 'a', cite: 'one', score: 0.66 },
        { text: 'b', cite: 'two', score: 0.65 }
    ], 0.12);

    assert.strictEqual(kept.length, 2);
});

test('unscored sources are never dropped by the margin', () => {
    const kept = answerService.applyGlobalMargin([
        { text: 'a', cite: 'catalogue' },
        { text: 'b', cite: 'doc', score: 0.9 },
        { text: 'c', cite: 'weak', score: 0.3 }
    ], 0.12);

    assert.deepStrictEqual(kept.map(p => p.cite), ['catalogue', 'doc']);
});
