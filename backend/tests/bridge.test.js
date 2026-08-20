const test = require('node:test');
const assert = require('node:assert');

const planner = require('../services/planner');
const traceStore = require('../services/traceStore');
const bridge = require('../services/openclawBridge');

// "who are u" once became a skill build: the reply mentioned the web it
// lacks, the disclaimer regex escalated, and the planner's "just answer"
// verdict read as a gap. The carried answer must win that argument.
test('a plan that is just "answer" keeps the answer instead of building a skill', async () => {
    const originalPlan = planner.plan;
    const originalBegin = traceStore.beginPlan;
    const originalFinish = traceStore.finishPlan;
    planner.plan = async () => ({
        status: 'planned', goal: 'reply',
        steps: [{ id: 's1', capability: 'answer' }], missing: []
    });
    traceStore.beginPlan = () => 'trace';
    traceStore.finishPlan = () => {};
    try {
        const fallbackAnswer = {
            status: 'success', response: "I'm Jarvis.", action: 'answered',
            grounded: false, sources: []
        };
        const outcome = await bridge.composeThenGenerate('who are u', { fallbackAnswer });
        assert.deepEqual(outcome, fallbackAnswer);
    } finally {
        planner.plan = originalPlan;
        traceStore.beginPlan = originalBegin;
        traceStore.finishPlan = originalFinish;
    }
});
