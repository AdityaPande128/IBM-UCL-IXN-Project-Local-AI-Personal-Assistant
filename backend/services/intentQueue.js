const crypto = require('crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

let queued = [];
let running = null;

// The queue job the current async context is executing inside, if any.
const inside = new AsyncLocalStorage();

function pump() {
    if (running || queued.length === 0) return;
    const job = queued.shift();
    running = job;
    Promise.resolve()
        .then(() => inside.run(job, () => job.run({ signal: job.controller.signal })))
        .catch(err => {
            console.error(`[IntentQueue] job crashed: ${err.stack || err.message}`);
            return { status: 'error', action: 'error',
                response: 'Something went wrong on my side with that one. '
                    + 'The details are in the log.' };
        })
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

    // A runner already inside the queue would wait on itself forever if its
    // nested work queued behind the very job it is part of; nested work runs
    // inline instead, under the outer job's stop signal.
    const outer = inside.getStore();
    if (outer) {
        const result = Promise.resolve()
            .then(() => run({ signal: outer.controller.signal }))
            .catch(err => {
                console.error(`[IntentQueue] nested job crashed: ${err.stack || err.message}`);
                return { status: 'error', action: 'error',
                    response: 'Something went wrong on my side with that one. '
                        + 'The details are in the log.' };
            });
        return { id: crypto.randomUUID(), position: 0, result };
    }

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

function background(job) {
    return Boolean(job && job.meta && job.meta.background);
}

// A bare Stop is aimed at the user's own work: it never lands on a
// background run holding the queue, but on the newest foreground job.
function abort(id) {
    if (running && (id ? id === running.id : !background(running))) {
        running.controller.abort();
        return { id: running.id, state: 'aborting' };
    }
    const index = id
        ? queued.findIndex(job => job.id === id)
        : queued.findLastIndex(job => !background(job));
    if (index === -1) return { id: id || null, state: 'not_found' };
    const [job] = queued.splice(index, 1);
    job.controller.abort();
    job.resolve({ status: 'aborted', response: 'Stopped before it started.', action: 'aborted' });
    return { id: job.id, state: 'aborted' };
}

// The stop signal of whichever queue job the caller is running inside, so
// long waits deep in a job (a model call, mostly) can end the moment the
// user stops it instead of at the next checkpoint.
function currentSignal() {
    const job = inside.getStore();
    return job ? job.controller.signal : null;
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

module.exports = { submit, abort, size, reset, currentSignal };
