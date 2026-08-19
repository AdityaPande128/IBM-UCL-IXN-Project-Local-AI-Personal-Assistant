const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const memoryStore = require('../services/memoryStore');
const memoryService = require('../services/memoryService');
const proposals = require('../services/proposals');
const traceStore = require('../services/traceStore');
const llmClient = require('../services/llmClient');

const DAY = 24 * 60 * 60 * 1000;

// A deterministic fake embedding: same word, same direction.
function toyVector(text) {
    const vector = new Array(16).fill(0);
    for (const word of String(text).toLowerCase().split(/\W+/).filter(Boolean)) {
        let seed = 0;
        for (const ch of word) seed = (seed * 31 + ch.charCodeAt(0)) % 16;
        vector[seed] += 1;
    }
    return vector;
}

function scratch() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-memory-'));
    memoryStore.open(path.join(dir, 'memory.db'));
    traceStore.open(path.join(dir, 'traces.db'));
    memoryService.setEmbedder(async texts => texts.map(toyVector));
    proposals.reset();
    return {
        dir,
        cleanup() {
            memoryService.setIncognito(false);
            memoryService.setEmbedder(null);
            memoryStore.close();
            traceStore.close();
            proposals.reset();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    };
}


test('hard deletion is secure deletion', () => {
    const scope = scratch();
    try {
        const fact = memoryStore.remember({ text: 'the safe code is 4471', vector: toyVector('safe') });
        assert.strictEqual(memoryStore.stats().secure_delete, true,
            'the pragma must actually be on');

        memoryStore.hardDelete([fact.id]);
        assert.strictEqual(memoryStore.get(fact.id), null);
        assert.strictEqual(memoryStore.list().length, 0);
    } finally {
        scope.cleanup();
    }
});

test('recall prefers relevance, adds a recency nudge, and marks the recall', () => {
    const scope = scratch();
    try {
        memoryStore.remember({ text: 'coffee order is a flat white', vector: toyVector('coffee order flat white') });
        memoryStore.remember({ text: 'sister lives in Pune', vector: toyVector('sister lives pune') });
        const now = Date.now();

        const hits = memoryStore.search(toyVector('coffee order flat white'), { topK: 1, now });

        assert.strictEqual(hits.length, 1);
        assert.match(hits[0].text, /flat white/);
        assert.ok(hits[0].age_days === 0);
        assert.ok(memoryStore.get(hits[0].id).last_recalled_at >= now,
            'a recall is recorded so the demotion rule sees use');
    } finally {
        scope.cleanup();
    }
});

test('superseded facts keep the audit trail and never surface', () => {
    const scope = scratch();
    try {
        const old = memoryStore.remember({ text: 'works at Acme', vector: toyVector('works acme') });
        const now = memoryStore.remember({ text: 'works at Beta', vector: toyVector('works acme') });

        memoryStore.supersede(old.id, now.id);

        const kept = memoryStore.get(old.id);
        assert.strictEqual(kept.status, 'superseded');
        assert.strictEqual(kept.superseded_by, now.id);

        const hits = memoryStore.search(toyVector('works acme'), { topK: 5 });
        assert.ok(!hits.some(hit => hit.id === old.id), 'a superseded belief is not knowledge');
    } finally {
        scope.cleanup();
    }
});

test('the nightly pass archives the unrecalled and spares the pinned', () => {
    const scope = scratch();
    try {
        const now = Date.now();
        const stale = memoryStore.remember({ text: 'liked that ramen place', vector: toyVector('ramen') });
        const pinned = memoryStore.remember({ text: 'passport locker is 12B', vector: toyVector('passport') });
        memoryStore.setPinned(pinned.id, true);

        const past = now + (memoryStore.FACT_ARCHIVE_DAYS + 1) * DAY;
        const swept = memoryStore.nightly(past);

        assert.strictEqual(swept.archivedFacts, 1);
        assert.strictEqual(memoryStore.get(stale.id).status, 'archived');
        assert.strictEqual(memoryStore.get(pinned.id).status, 'active', 'pins trump everything');

        const back = memoryStore.restore(stale.id);
        assert.strictEqual(back.status, 'active');
    } finally {
        scope.cleanup();
    }
});

test('a wipe is reviewed before it deletes, and finds every tier', () => {
    const scope = scratch();
    try {
        const a = memoryStore.remember({ text: 'Sam prefers email to calls', vector: toyVector('sam email') });
        const b = memoryStore.remember({ text: 'lunch with Sam on Fridays', vector: toyVector('sam lunch') });
        memoryStore.supersede(a.id, b.id);
        memoryStore.remember({ text: 'the car is due a service', vector: toyVector('car') });

        const candidates = memoryStore.wipeCandidates('sam');
        assert.strictEqual(candidates.length, 2, 'superseded rows are found too');

        const removed = memoryStore.hardDelete(candidates.map(fact => fact.id));
        assert.strictEqual(removed, 2);
        assert.strictEqual(memoryStore.list({ status: 'all' }).length, 1);
    } finally {
        scope.cleanup();
    }
});

test('inference offers a card and only approval writes the row', async () => {
    const scope = scratch();
    try {
        const offered = memoryService.offer('the user cycles to work', 'came up twice');

        assert.ok(offered, 'an offer exists');
        assert.strictEqual(memoryStore.list().length, 0, 'the card is the write barrier');

        const outcome = await proposals.approve(offered.id);
        assert.strictEqual(outcome.status, 'success');

        const [fact] = memoryStore.list();
        assert.strictEqual(fact.text, 'the user cycles to work');
        assert.strictEqual(fact.source, 'inferred');
    } finally {
        scope.cleanup();
    }
});

test('a fact already known is not offered again', () => {
    const scope = scratch();
    try {
        memoryStore.remember({ text: 'The user cycles to work', vector: toyVector('cycles') });
        assert.strictEqual(memoryService.offer('the user cycles to work'), null);
    } finally {
        scope.cleanup();
    }
});

test('incognito blocks writes, keeps recall, and takes traces off disk', async () => {
    const scope = scratch();
    try {
        await memoryService.add('home is in Camden');
        memoryService.setIncognito(true);

        await assert.rejects(() => memoryService.add('a secret errand'), /incognito/);
        assert.strictEqual(memoryService.offer('a secret habit'), null);

        const hits = memoryStore.search(toyVector('home is in Camden'), { topK: 1 });
        assert.strictEqual(hits.length, 1, 'reading is not recording');

        const planId = traceStore.beginPlan({ request: 'incognito errand' });
        assert.ok(traceStore.getPlan(planId), 'traces still work in memory');

        memoryService.setIncognito(false);
        assert.strictEqual(traceStore.getPlan(planId), null,
            'the incognito trace died with the mode');
        assert.match(traceStore.path, /jarvis-memory-/,
            'the store returns to where it was, not to a hardcoded default');
    } finally {
        scope.cleanup();
    }
});

test('model inference is parsed, bounded, and lands as cards', async (t) => {
    const scope = scratch();
    const real = llmClient.complete;
    t.after(() => { llmClient.complete = real; });
    try {
        llmClient.complete = async () => JSON.stringify({
            facts: ['the user is allergic to peanuts', 'x', 'the user asked to open a file today']
        });

        const offers = await memoryService.inferFrom('user: no peanuts ever\nassistant: noted');

        assert.strictEqual(offers.length, 2, 'the too-short candidate is dropped');
        assert.strictEqual(memoryStore.list().length, 0, 'nothing wrote itself');
        assert.strictEqual(proposals.pending().length, 2);
    } finally {
        scope.cleanup();
    }
});

test('facts born in a chat die with it; what the user typed stays', () => {
    const store = scratch();
    try {
        const inferred = memoryStore.remember({
            text: 'the user is planning a trip to Lisbon',
            source: 'inferred', origin: 7
        });
        const typed = memoryStore.remember({ text: 'the user is called Adi' });

        assert.strictEqual(memoryStore.deleteByOrigin(7), 1);
        assert.strictEqual(memoryStore.get(inferred.id), null);
        assert.ok(memoryStore.get(typed.id), 'a typed fact has no origin and survives');
        assert.strictEqual(memoryStore.deleteByOrigin(null), 0,
            'no origin never deletes anything');
    } finally {
        store.cleanup();
    }
});
