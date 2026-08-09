const crypto = require('crypto');

let queued = [];
let running = null;

function pump() {
    if (running || queued.length === 0) return;
    const job = queued.shift();
    running = job;
    Promise.resolve()
        .then(() => job.run({ signal: job.controller.signal }))
        .catch(err => ({ status: 'error', response: err.message, action: 'error' }))
        .then(result => {
            const final = job.controller.signal.aborted
                ? { status: 'aborted', response: 'Stopped.', action: 'aborted' }
                : result;
            if (running === job) running = null;
            job.resolve(final);
            pump();
        });
}

function submit(run, meta = {}) {
    if (typeof run !== 'function') throw new Error('a job needs a runner');
    const job = {
        id: crypto.randomUUID(),
        run,
        meta,
        controller: new AbortController(),
        createdAt: Date.now()
    };
    job.result = new Promise(resolve => { job.resolve = resolve; });
    const position = queued.length + (running ? 1 : 0) + 1;
    queued.push(job);
    pump();
    return { id: job.id, position, result: job.result };
}

function abort(id) {
    if (running && (!id || id === running.id)) {
        running.controller.abort();
        return { id: running.id, state: 'aborting' };
    }
    const index = queued.findIndex(job => job.id === id);
    if (index === -1) return { id: id || null, state: 'not_found' };
    const [job] = queued.splice(index, 1);
    job.controller.abort();
    job.resolve({ status: 'aborted', response: 'Stopped before it started.', action: 'aborted' });
    return { id: job.id, state: 'aborted' };
}

function size() {
    return queued.length + (running ? 1 : 0);
}

function reset() {
    for (const job of queued) {
        job.controller.abort();
        job.resolve({ status: 'aborted', response: 'Stopped.', action: 'aborted' });
    }
    queued = [];
    running = null;
}

module.exports = { submit, abort, size, reset };
