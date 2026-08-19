const test = require('node:test');
const assert = require('node:assert');

const intentQueue = require('../services/intentQueue');

test('intents run one at a time, in submission order', async () => {
    intentQueue.reset();
    const log = [];
    const slow = (name, ms) => () => new Promise(resolve => {
        log.push(`start ${name}`);
        setTimeout(() => { log.push(`end ${name}`); resolve({ status: 'success' }); }, ms);
    });

    const a = intentQueue.submit(slow('a', 30));
    const b = intentQueue.submit(slow('b', 5));
    assert.strictEqual(a.position, 1);
    assert.strictEqual(b.position, 2);
    assert.strictEqual(intentQueue.size(), 2);

    await Promise.all([a.result, b.result]);
    assert.deepStrictEqual(log, ['start a', 'end a', 'start b', 'end b']);
    assert.strictEqual(intentQueue.size(), 0);
});

test('a queued intent aborts before it ever runs', async () => {
    intentQueue.reset();
    let ran = false;
    const a = intentQueue.submit(() =>
        new Promise(resolve => setTimeout(() => resolve({ status: 'success' }), 40)));
    const b = intentQueue.submit(() => { ran = true; return Promise.resolve({ status: 'success' }); });

    const outcome = intentQueue.abort(b.id);
    assert.strictEqual(outcome.state, 'aborted');

    assert.strictEqual((await b.result).status, 'aborted');
    assert.strictEqual((await a.result).status, 'success');
    assert.strictEqual(ran, false);
});

test('aborting the running intent signals it and discards its result', async () => {
    intentQueue.reset();
    const a = intentQueue.submit(({ signal }) => new Promise(resolve => {
        signal.addEventListener('abort', () => resolve({ status: 'success', tainted: true }));
    }));
    await new Promise(resolve => setTimeout(resolve, 10));

    const outcome = intentQueue.abort();
    assert.strictEqual(outcome.state, 'aborting');
    assert.strictEqual(outcome.id, a.id);

    const result = await a.result;
    assert.strictEqual(result.status, 'aborted');
    assert.strictEqual(result.tainted, undefined);
});

test('an aborted id that never existed reports not_found', () => {
    intentQueue.reset();
    assert.strictEqual(intentQueue.abort('no-such-id').state, 'not_found');
});

test('a crashing job speaks plainly, keeps its detail in the log, and frees the queue', async () => {
    intentQueue.reset();
    const a = intentQueue.submit(() => Promise.reject(new Error('boom')));
    const result = await a.result;
    assert.strictEqual(result.status, 'error');
    assert.match(result.response, /went wrong on my side/);
    assert.ok(!/boom/.test(result.response),
        'internals belong in the log, not the reply');

    const b = intentQueue.submit(() => Promise.resolve({ status: 'success' }));
    assert.strictEqual((await b.result).status, 'success');
});

test('executeIntent honours an already-aborted signal before doing any work', async () => {
    const bridge = require('../services/openclawBridge');
    const controller = new AbortController();
    controller.abort();
    const result = await bridge.executeIntent('list my files', { signal: controller.signal });
    assert.strictEqual(result.status, 'aborted');
});

test('a job that submits from inside the queue runs inline instead of deadlocking', async () => {
    intentQueue.reset();
    const outer = intentQueue.submit(async () => {
        const inner = intentQueue.submit(() =>
            Promise.resolve({ status: 'success', response: 'inner done' }));
        assert.strictEqual(inner.position, 0, 'nested work never takes a queue place');
        const got = await inner.result;
        return { status: 'success', response: got.response };
    });
    const result = await outer.result;
    assert.strictEqual(result.status, 'success');
    assert.strictEqual(result.response, 'inner done');
    assert.strictEqual(intentQueue.size(), 0);
});

test('nested inline work runs under the outer job\'s stop signal', async () => {
    intentQueue.reset();
    const outer = intentQueue.submit(async ({ signal }) => {
        let inherited = null;
        await intentQueue.submit(({ signal: inner }) => {
            inherited = inner;
            return Promise.resolve({ status: 'success' });
        }).result;
        return { status: 'success', shared: inherited === signal };
    });
    const result = await outer.result;
    assert.strictEqual(result.shared, true);
});

test('a bare Stop passes over a background run and lands on the queued foreground job', async () => {
    intentQueue.reset();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const watcher = intentQueue.submit(() =>
        gate.then(() => ({ status: 'success' })), { background: true });
    const user = intentQueue.submit(() => Promise.resolve({ status: 'success' }));

    const outcome = intentQueue.abort();
    assert.strictEqual(outcome.id, user.id, 'the Stop lands on the user\'s job');
    assert.strictEqual((await user.result).status, 'aborted');

    release();
    assert.strictEqual((await watcher.result).status, 'success',
        'the background run was never touched');
});
