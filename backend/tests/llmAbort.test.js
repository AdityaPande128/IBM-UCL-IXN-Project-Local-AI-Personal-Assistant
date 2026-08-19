const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

// A server that accepts the request and then says nothing, like a model
// mid-generation.
const silent = http.createServer(() => { });
const ready = new Promise(resolve => silent.listen(0, '127.0.0.1', resolve));

let llmClient;
let intentQueue;
test.before(async () => {
    await ready;
    process.env.INFERENCE_URL = `http://127.0.0.1:${silent.address().port}`;
    llmClient = require('../services/llmClient');
    intentQueue = require('../services/intentQueue');
});
test.after(() => silent.close());

test('an in-flight completion ends the moment its signal fires', async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = llmClient.complete([{ role: 'user', content: 'hi' }],
        { model: 'stub', signal: controller.signal, timeout_ms: 30000 });
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(pending, err => err.aborted === true);
    assert.ok(Date.now() - startedAt < 5000, 'the abort should not wait out the call');
});

test('a signal that already fired never opens a request', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
        llmClient.complete([{ role: 'user', content: 'hi' }],
            { model: 'stub', signal: controller.signal }),
        err => err.aborted === true);
});

test('a completion inside a queue job stops with the job, unasked', async () => {
    intentQueue.reset();
    let seen = null;
    const job = intentQueue.submit(async () => {
        try {
            await llmClient.complete([{ role: 'user', content: 'hi' }],
                { model: 'stub', timeout_ms: 30000 });
        } catch (err) {
            seen = err;
        }
        return { status: 'success' };
    });
    setTimeout(() => intentQueue.abort(job.id), 30);
    const result = await job.result;
    assert.strictEqual(result.status, 'aborted');
    assert.ok(seen && seen.aborted === true,
        'the model call should reject the moment the job is stopped');
});
