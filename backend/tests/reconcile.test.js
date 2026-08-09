const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const traceStore = require('../services/traceStore');

test('plans left running by a dead daemon are failed on reconcile', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-rec-'));
    traceStore.open(path.join(dir, 'traces.db'));

    const orphan = traceStore.beginPlan({ request: 'send the report', status: 'running', stepCount: 2 });
    const finished = traceStore.beginPlan({ request: 'count words', status: 'running', stepCount: 1 });
    traceStore.finishPlan(finished, { status: 'success' });
    const rejected = traceStore.beginPlan({ request: 'no plan composed', status: 'planned' });
    traceStore.finishPlan(rejected, { status: 'rejected', error: 'no plan' });

    assert.strictEqual(traceStore.reconcileInterrupted(), 1);

    assert.strictEqual(traceStore.getPlan(orphan).status, 'failed');
    assert.match(traceStore.getPlan(orphan).error, /interrupted/);
    assert.strictEqual(traceStore.getPlan(finished).status, 'success');
    assert.strictEqual(traceStore.getPlan(rejected).status, 'rejected');

    assert.strictEqual(traceStore.reconcileInterrupted(), 0);

    traceStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
});
