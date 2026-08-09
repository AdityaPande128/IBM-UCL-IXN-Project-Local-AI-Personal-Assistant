const test = require('node:test');
const assert = require('node:assert');

const proposals = require('../services/proposals');
const activityBus = require('../services/activityBus');
const bridge = require('../services/openclawBridge');

test.beforeEach(() => proposals.reset());

test('an approved proposal runs what was captured, exactly once', async () => {
    let ran = 0;
    const offer = proposals.create('build_skill', { request: 'count words' },
        () => { ran += 1; return { status: 'success' }; });

    const first = await proposals.approve(offer.id);
    assert.strictEqual(first.status, 'success');
    assert.strictEqual(ran, 1);

    const second = await proposals.approve(offer.id);
    assert.strictEqual(second.status, 'unknown_proposal');
    assert.strictEqual(ran, 1);
});

test('a declined proposal never runs, and cannot be approved afterwards', async () => {
    let ran = 0;
    const offer = proposals.create('build_skill', { request: 'x' }, () => { ran += 1; });

    const declined = proposals.decline(offer.id);
    assert.strictEqual(declined.status, 'declined');

    const after = await proposals.approve(offer.id);
    assert.strictEqual(after.status, 'unknown_proposal');
    assert.strictEqual(ran, 0);
});

test('consent expires: an old offer cannot be redeemed', async () => {
    let ran = 0;
    const offer = proposals.create('build_skill', { request: 'x' }, () => { ran += 1; });

    const entry = proposals.pending().find(p => p.id === offer.id);
    assert.ok(entry, 'the offer is pending');
    proposals.decline(offer.id);
    const gone = await proposals.approve(offer.id);
    assert.strictEqual(gone.status, 'unknown_proposal');
    assert.strictEqual(ran, 0);
});

test('an interactive request that needs generation asks instead of acting', () => {
    const result = bridge.maybeProposeGeneration(
        'convert my photos to webp', ['nothing converts images'], { interactive: true });

    assert.strictEqual(result.status, 'needs_approval');
    assert.strictEqual(result.action, 'proposed_skill_build');
    assert.ok(result.proposal.id, 'the offer carries an id the client can answer');
    assert.match(result.response, /don't have a skill/i);
    assert.match(result.response, /test/i);
    assert.match(result.proposal.will, /sandbox/);

    proposals.decline(result.proposal.id);
});

test('answering an unknown proposal is safe and says so', async () => {
    const result = await bridge.answerProposal('not-a-real-id', 'yes');
    assert.strictEqual(result.status, 'unknown_proposal');
});

test('activity is published to whoever is listening, and stops on unsubscribe', () => {
    const seen = [];
    const unsubscribe = activityBus.subscribe(e => seen.push(e));

    activityBus.publish('generator', 'attempt', { attempt: 1, of: 3 });
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].source, 'generator');
    assert.strictEqual(seen[0].event, 'attempt');
    assert.ok(seen[0].at <= Date.now());

    unsubscribe();
    activityBus.publish('generator', 'attempt', { attempt: 2, of: 3 });
    assert.strictEqual(seen.length, 1, 'nothing arrives after unsubscribe');
});

test('handing a request to the general executor is offered, not assumed', () => {
    const result = bridge.maybeDelegate(
        'do something nothing here covers', { interactive: true }, 'nothing installed covers this');

    assert.strictEqual(result.status, 'needs_approval');
    assert.strictEqual(result.action, 'proposed_delegation');
    assert.ok(result.proposal.id);
    assert.match(result.proposal.will, /outside this app/);
    assert.match(result.proposal.will, /not independently verified/);

    proposals.decline(result.proposal.id);
});
