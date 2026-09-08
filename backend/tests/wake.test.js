const test = require('node:test');
const assert = require('node:assert');

const wakeWord = require('../services/wakeWord');

function withEars(t, transcript) {
    wakeWord.setTranscriber(async () => transcript);
    t.after(() => wakeWord.setTranscriber(null));
}

test('the wake phrase with a command wakes and carries the command', async (t) => {
    withEars(t, 'Hey Jarvis, what time is my recital?');
    const probed = await wakeWord.probe(Buffer.alloc(4));

    assert.strictEqual(probed.wake, true);
    assert.strictEqual(probed.command, 'what time is my recital?');
});

test('the bare wake phrase wakes with nothing to run', async (t) => {
    withEars(t, ' Hey, Jarvis. ');
    const probed = await wakeWord.probe(Buffer.alloc(4));

    assert.strictEqual(probed.wake, true);
    assert.strictEqual(probed.command, null);
});

test('okay and ok work as openers, and so does the name alone', async (t) => {
    withEars(t, 'okay jarvis read my email');
    assert.strictEqual((await wakeWord.probe(Buffer.alloc(4))).wake, true);

    withEars(t, 'Jarvis, lights please');
    const bare = await wakeWord.probe(Buffer.alloc(4));
    assert.strictEqual(bare.wake, true);
    assert.strictEqual(bare.command, 'lights please');
});

test('idle speech returns wake false and nothing else at all', async (t) => {
    withEars(t, 'so I told him the meeting moved to Thursday');
    const probed = await wakeWord.probe(Buffer.alloc(4));

    assert.deepStrictEqual(probed, { wake: false },
        'what was heard while idle must not even be echoed back');
});

test('the name mentioned mid-sentence is not a summons', async (t) => {
    withEars(t, 'I asked jarvis about it yesterday');
    assert.strictEqual((await wakeWord.probe(Buffer.alloc(4))).wake, false);
});

test('silence and a broken transcriber both stay quiet', async (t) => {
    withEars(t, '');
    assert.deepStrictEqual(await wakeWord.probe(Buffer.alloc(4)), { wake: false });

    wakeWord.setTranscriber(async () => { throw new Error('stt down'); });
    assert.deepStrictEqual(await wakeWord.probe(Buffer.alloc(4)), { wake: false });
});

test('a transcript far longer than its clip could hold is refused as a hallucination', () => {
    const { plausibleTranscript } = require('../services/aiPipeline');
    const oneSecond = 44 + 2 * 16000;
    assert.ok(plausibleTranscript('hey jarvis what is the time', oneSecond));
    assert.ok(!plausibleTranscript('x'.repeat(892), oneSecond));
    assert.ok(plausibleTranscript('x'.repeat(150), 44 + 2 * 16000 * 5));
});
