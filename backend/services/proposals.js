const crypto = require('crypto');

const TTL_MS = 10 * 60 * 1000;

const open = new Map();

function prune(now = Date.now()) {
    for (const [id, proposal] of open) {
        if (now - proposal.createdAt > TTL_MS) open.delete(id);
    }
}

function create(kind, detail, runner) {
    if (typeof runner !== 'function') throw new Error('a proposal needs a runner');
    prune();

    const id = crypto.randomUUID();
    open.set(id, { kind, detail, runner, createdAt: Date.now() });

    return { id, kind, ...detail };
}

async function approve(id, context = {}) {
    prune();
    const proposal = open.get(id);
    if (!proposal) {
        return { status: 'unknown_proposal',
                 response: 'That offer has expired or was already answered. Ask again if you still want it.' };
    }
    open.delete(id);
    return proposal.runner(context);
}

function decline(id) {
    prune();
    const existed = open.delete(id);
    return {
        status: existed ? 'declined' : 'unknown_proposal',
        response: existed ? 'Okay — I won\'t build that.' : 'That offer had already expired.'
    };
}

function pending() {
    prune();
    return Array.from(open.entries()).map(([id, p]) =>
        ({ id, kind: p.kind, createdAt: p.createdAt, ...p.detail }));
}

function reset() {
    open.clear();
}

module.exports = { create, approve, decline, pending, reset, TTL_MS };
