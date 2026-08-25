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

// "What does this PDF say?" once routed to the skill factory at 0.98
// confidence while the file's text sat indexed in the corpus. A content
// question about a file already in the conversation answers from that file.
test('a question about an in-conversation file answers from its text, not triage', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const answerService = require('../services/answerService');
    const router = require('../services/router');

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-gate-'));
    const file = path.join(scratch, 'Iron Profile.pdf');
    fs.writeFileSync(file, 'stub');

    const originalAnswer = answerService.answer;
    const originalRoute = router.route;
    let answeredWith = null;
    let routed = false;
    answerService.answer = async (asked, options = {}) => {
        answeredWith = options;
        return { is_successful: true, refused: false, grounded: true,
            text: 'Ferritin is 18.', sources: ['file: Iron Profile.pdf'] };
    };
    router.route = async () => { routed = true; throw new Error('must not route'); };

    const corpusIndexer = require('../services/corpusIndexer');
    const originalRecords = corpusIndexer.recordsForFile;
    corpusIndexer.recordsForFile = () => [{ meta: { text: 'Ferritin: 18 ng/mL' } }];
    try {
        const outcome = await bridge.executeIntent('Thanks. What does this PDF say?', {
            history: [{ role: 'user', text: 'Send me the PDF of my iron profile report.' }],
            recentFiles: [{ id: 'ab12', name: 'Iron Profile.pdf', path: file }]
        });
        assert.equal(outcome.status, 'success');
        assert.equal(outcome.response, 'Ferritin is 18.');
        assert.equal(routed, false, 'triage must never see it');
        assert.ok(Array.isArray(answeredWith.passages) && answeredWith.passages.length,
            'the file text is pinned');
        assert.ok(Array.isArray(answeredWith.history) && answeredWith.history.length,
            'the conversation rides along');
    } finally {
        answerService.answer = originalAnswer;
        router.route = originalRoute;
        corpusIndexer.recordsForFile = originalRecords;
    }
});

// "Send it to my phone" is delivery, not a content question: it must still
// reach the router however file-flavoured it sounds.
test('a delivery ask about a file still routes', async () => {
    const router = require('../services/router');
    const originalRoute = router.route;
    let routed = false;
    router.route = async () => {
        routed = true;
        return { action: router.ACTIONS.REFUSE, reasoning: 'test stop', is_successful: true };
    };
    try {
        await bridge.executeIntent('Send that PDF to my phone', {
            recentFiles: [{ id: 'cd34', name: 'Iron Profile.pdf', path: '/tmp/x.pdf' }]
        });
        assert.equal(routed, true);
    } finally {
        router.route = originalRoute;
    }
});
