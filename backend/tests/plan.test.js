const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const capabilityGraph = require('../services/capabilityGraph');
const mailProvider = require('../services/mailProvider');
const planner = require('../services/planner');
const planExecutor = require('../services/planExecutor');
const traceStore = require('../services/traceStore');
const securityStore = require('../security/store');
const labels = require('../security/labels');

const { ORIGIN, SENSITIVITY } = labels;


function fakeGraph(overrides = {}) {
    const capabilities = new Map();

    const add = spec => capabilities.set(spec.id, capabilityGraph.define(spec));

    add({
        id: 'find',
        tier: 0,
        description: 'find things',
        inputs: { what: { type: 'string', required: true } },
        outputs: { paths: { type: 'string[]' } },
        produces: labels.label(ORIGIN.FILE, SENSITIVITY.PERSONAL),
        run: async ({ what }) => ({ paths: [`/tmp/${what}.md`] })
    });

    add({
        id: 'read',
        tier: 0,
        description: 'read files',
        inputs: { paths: { type: 'path[]', required: true } },
        outputs: { passages: { type: 'passage[]' } },
        consent: 'documents',
        produces: labels.label(ORIGIN.FILE, SENSITIVITY.PERSONAL),
        run: async ({ paths }) => ({ passages: paths.map(p => ({ text: `contents of ${p}` })) })
    });

    add({
        id: 'say',
        tier: 1,
        description: 'produce words',
        inputs: { question: { type: 'string', required: true }, passages: { type: 'passage[]' } },
        outputs: { text: { type: 'string' } },
        produces: labels.label(ORIGIN.GENERATED, SENSITIVITY.PUBLIC),
        run: async ({ question, passages }) =>
            ({ text: `${question} -> ${(passages || []).length} passage(s)` })
    });

    add({
        id: 'publish',
        tier: 1,
        description: 'send something off the machine',
        inputs: { body: { type: 'string', required: true } },
        outputs: { sent: { type: 'boolean' } },
        effects: [capabilityGraph.EFFECT.NETWORK],
        produces: labels.label(ORIGIN.GENERATED, SENSITIVITY.PUBLIC),
        run: async () => ({ sent: true })
    });

    add({
        id: 'tidy',
        tier: 1,
        description: 'move files around on this machine',
        inputs: { folder: { type: 'string', required: true } },
        outputs: { moved: { type: 'number' } },
        effects: [capabilityGraph.EFFECT.FILESYSTEM_WRITE],
        produces: labels.label(ORIGIN.FILE, SENSITIVITY.PERSONAL),
        run: async () => ({ moved: 3 })
    });

    add({
        id: 'explode',
        tier: 1,
        description: 'always fails',
        inputs: {},
        outputs: { never: { type: 'string' } },
        produces: labels.label(ORIGIN.GENERATED, SENSITIVITY.PUBLIC),
        run: async () => { throw new Error('the surface moved'); }
    });

    for (const [id, spec] of Object.entries(overrides)) {
        capabilities.set(id, capabilityGraph.define({ id, ...spec }));
    }

    return {
        get: id => capabilities.get(id) || null,
        has: id => capabilities.has(id),
        resolveId: id => (capabilities.has(id) ? id : null),
        list: () => [...capabilities.values()]
    };
}

function scratch({ grant = true } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-plan-'));
    traceStore.open(path.join(dir, 'traces.db'));
    securityStore.open(path.join(dir, 'security.db'));
    if (grant) securityStore.grantRoot('/tmp', 'documents');
    return dir;
}

function cleanup(dir) {
    traceStore.close();
    securityStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
}

const GRAPH = fakeGraph();
const validate = parsed => planner.validatePlan(parsed, { graph: GRAPH });


test('installed skills and builtins share one signature', () => {
    const all = capabilityGraph.list();

    assert.ok(all.some(c => c.id === 'files.search'), 'builtins must be present');
    assert.ok(all.some(c => c.id.startsWith('skill.')), 'skills must be projected in');

    for (const capability of all) {
        assert.ok(capability.description, `${capability.id} needs a description`);
        assert.ok(Object.keys(capability.outputs).length,
            `${capability.id} needs a named output or nothing can reference it`);
        assert.ok(capability.produces, `${capability.id} must declare what its output carries`);
    }
});

test('a capability with no named output is rejected at definition', () => {
    assert.throws(() => capabilityGraph.define({
        id: 'silent', tier: 0, description: 'x',
        produces: labels.UNKNOWN, outputs: {}, run: () => ({})
    }), /outputs/);
});

test('a skill that reaches the network produces web-origin data', () => {
    const label = capabilityGraph.skillOutputLabel({ capabilities: { network: true, filesystem: [] } });
    assert.ok(label.origins.includes(ORIGIN.WEB));
    assert.strictEqual(labels.isInstructionSafe(label), false);
});

test('a skill that declares nothing is assumed to touch the filesystem', () => {
    const label = capabilityGraph.skillOutputLabel({ capabilities: {} });
    assert.ok(label.origins.includes(ORIGIN.FILE));
});

test('a pure skill introduces nothing its caller did not already have', () => {
    const label = capabilityGraph.skillOutputLabel({ capabilities: { filesystem: [], network: false } });
    assert.strictEqual(label.sensitivity, SENSITIVITY.PUBLIC);
});

test('capability ids survive the artefacts small models put in identifiers', () => {
    assert.strictEqual(capabilityGraph.resolveId('files. search'), 'files.search');
    assert.strictEqual(capabilityGraph.resolveId('FILES.SEARCH'), 'files.search');
    assert.strictEqual(capabilityGraph.resolveId('system-volume'), 'skill.system-volume');
    assert.strictEqual(capabilityGraph.resolveId('no-such-thing'), null);
});

test('the rendered catalogue names inputs and outputs', () => {
    const rendered = capabilityGraph.describe([capabilityGraph.get('files.search')]);
    assert.match(rendered, /files\.search\(/);
    assert.match(rendered, /text:string/);
    assert.match(rendered, /-> \{files, paths\}/);
});


test('a well-formed plan validates', () => {
    const check = validate({
        goal: 'read a file and answer',
        steps: [
            { id: 's1', capability: 'find', inputs: { what: 'boiler' } },
            { id: 's2', capability: 'read', inputs: { paths: '$s1.paths' } },
            { id: 's3', capability: 'say', inputs: { question: 'when?', passages: '$s2.passages' } }
        ],
        missing: []
    });

    assert.ok(check.valid, check.errors.join('; '));
});

test('a capability that does not exist is a gap, not just an error', () => {
    const check = validate({
        goal: 'send a slack message',
        steps: [{ id: 's1', capability: 'slack.post', inputs: {} }],
        missing: []
    });

    assert.strictEqual(check.valid, false);
    assert.deepStrictEqual(check.missing, ['slack.post']);
});

test('a step cannot consume what no earlier step produced', () => {
    const forward = validate({
        goal: 'x',
        steps: [
            { id: 's1', capability: 'read', inputs: { paths: '$s2.paths' } },
            { id: 's2', capability: 'find', inputs: { what: 'y' } }
        ]
    });
    assert.strictEqual(forward.valid, false);
    assert.match(forward.errors.join(' '), /does not name an earlier step/);

    const invented = validate({
        goal: 'x',
        steps: [{ id: 's1', capability: 'read', inputs: { paths: '$s9.paths' } }]
    });
    assert.strictEqual(invented.valid, false);
});

test('a reference to an output the producer does not have is caught', () => {
    const check = validate({
        goal: 'x',
        steps: [
            { id: 's1', capability: 'find', inputs: { what: 'y' } },
            { id: 's2', capability: 'read', inputs: { paths: '$s1.passages' } }
        ]
    });

    assert.strictEqual(check.valid, false);
    assert.match(check.errors.join(' '), /s1 \(find\) produces paths/);
});

test('a required input cannot be left out', () => {
    const check = validate({ goal: 'x', steps: [{ id: 's1', capability: 'find', inputs: {} }] });

    assert.strictEqual(check.valid, false);
    assert.match(check.errors.join(' '), /requires "what"/);
});

test('duplicate step ids are rejected', () => {
    const check = validate({
        goal: 'x',
        steps: [
            { id: 's1', capability: 'find', inputs: { what: 'a' } },
            { id: 's1', capability: 'find', inputs: { what: 'b' } }
        ]
    });

    assert.strictEqual(check.valid, false);
    assert.match(check.errors.join(' '), /duplicate/);
});

test('a plan longer than the executor will run is rejected', () => {
    const steps = Array.from({ length: planner.MAX_STEPS + 1 }, (_, i) => ({
        id: `s${i + 1}`, capability: 'find', inputs: { what: 'x' }
    }));

    assert.strictEqual(validate({ goal: 'x', steps }).valid, false);
});

test('a reply with gaps but no steps reports the gaps rather than crashing', () => {
    const check = validate({ goal: 'do the thing', missing: ['no way to send email'] });

    assert.strictEqual(check.valid, false);
    assert.deepStrictEqual(check.declaredMissing, ['no way to send email']);
    assert.ok(check.errors.includes('missing_field:steps'));
});

test('a plan of no steps is valid only when it says what it could not do', () => {
    assert.strictEqual(validate({ goal: 'x', steps: [], missing: [] }).valid, false);

    const declared = validate({
        goal: 'post to slack',
        steps: [],
        missing: ['posting to Slack']
    });
    assert.ok(declared.valid, declared.errors.join('; '));
    assert.deepStrictEqual(declared.declaredMissing, ['posting to Slack']);
});

test('a step whose result goes nowhere is rejected', () => {
    const check = validate({
        goal: 'convert photos',
        steps: [
            { id: 's1', capability: 'find', inputs: { what: 'photos' } },
            { id: 's2', capability: 'read', inputs: { paths: '$s1.paths' } }
        ],
        missing: ['converting an image']
    });

    assert.strictEqual(check.valid, false);
    assert.match(check.errors.join(' '), /nothing uses/);
});

test('a step that changes something earns its place without being consumed', () => {
    const check = validate({
        goal: 'tidy up and say so',
        steps: [
            { id: 's1', capability: 'tidy', inputs: { folder: '~/Desktop' } },
            { id: 's2', capability: 'say', inputs: { question: 'what did you do?' } }
        ],
        missing: []
    });

    assert.ok(check.valid, check.errors.join('; '));
});

test('a plan that gathers material must end by saying something', () => {
    const dangling = validate({
        goal: 'where is my thesis',
        steps: [{ id: 's1', capability: 'find', inputs: { what: 'thesis' } }],
        missing: []
    });
    assert.strictEqual(dangling.valid, false);

    const answered = validate({
        goal: 'where is my thesis',
        steps: [
            { id: 's1', capability: 'find', inputs: { what: 'thesis' } },
            { id: 's2', capability: 'say', inputs: { question: 'where is it?', passages: '$s1.paths' } }
        ],
        missing: []
    });
    assert.ok(answered.valid, answered.errors.join('; '));
});

const PATHS_GRAPH = fakeGraph({
    find: {
        tier: 0, description: 'find things',
        inputs: { what: { type: 'string', required: true }, dir: { type: 'path' } },
        outputs: { paths: { type: 'string[]' } },
        produces: labels.label(ORIGIN.FILE, SENSITIVITY.PERSONAL),
        run: async () => ({ paths: [] })
    }
});

for (const invented of ['/Users/$(whoami)/Documents', '/Users/<username>/Desktop', 'Documents']) {
    test(`an invented folder filter is dropped: ${invented}`, () => {
        const plan = {
            goal: 'find the boiler note',
            steps: [
                { id: 's1', capability: 'find', inputs: { what: 'boiler', dir: invented } },
                { id: 's2', capability: 'say', inputs: { question: 'when?', passages: '$s1.paths' } }
            ],
            missing: []
        };

        const check = planner.validatePlan(plan, { graph: PATHS_GRAPH });

        assert.ok(check.valid, check.errors.join('; '));
        assert.strictEqual(plan.steps[0].inputs.dir, undefined);
        assert.strictEqual(plan.steps[0].inputs.what, 'boiler');
        assert.match(check.repairs.join(' '), /invented_path/);
    });
}

test('a real folder filter is left alone', () => {
    const plan = {
        goal: 'find the boiler note on the desktop',
        steps: [
            { id: 's1', capability: 'find', inputs: { what: 'boiler', dir: '~/Desktop' } },
            { id: 's2', capability: 'say', inputs: { question: 'when?', passages: '$s1.paths' } }
        ],
        missing: []
    };

    assert.ok(planner.validatePlan(plan, { graph: PATHS_GRAPH }).valid);
    assert.strictEqual(plan.steps[0].inputs.dir, '~/Desktop');
});

test('an invented path that nothing can replace is an error, not a repair', () => {
    const check = validate({
        goal: 'read a file',
        steps: [
            { id: 's1', capability: 'read', inputs: { paths: 'Documents/notes.md' } },
            { id: 's2', capability: 'say', inputs: { question: 'what?', passages: '$s1.passages' } }
        ]
    });

    assert.strictEqual(check.valid, false);
    assert.match(check.errors.join(' '), /not a full path/);
});

test('references are found however deeply they are nested', () => {
    const found = planner.referencesIn({
        a: '$s1.paths',
        b: [{ c: '$s2.passages' }],
        d: 'not a reference'
    });

    assert.deepStrictEqual(found.map(r => r.raw), ['$s1.paths', '$s2.passages']);
});


test('data flows from one step to the next', async () => {
    const dir = scratch();

    const result = await planExecutor.run({
        goal: 'read and answer',
        steps: [
            { id: 's1', capability: 'find', inputs: { what: 'boiler' }, reason: 'locate' },
            { id: 's2', capability: 'read', inputs: { paths: '$s1.paths' }, reason: 'read' },
            { id: 's3', capability: 'say', inputs: { question: 'when?', passages: '$s2.passages' }, reason: 'answer' }
        ],
        missing: []
    }, { graph: GRAPH, request: 'when was the boiler serviced' });

    assert.strictEqual(result.status, 'success');
    assert.strictEqual(result.completed, 3);
    assert.match(result.text, /when\? -> 1 passage/);

    cleanup(dir);
});

test('a reference embedded in prose is not silently interpolated', () => {
    const environment = new Map([['s1', {
        values: { paths: ['/tmp/a.md'] }, label: labels.UNKNOWN
    }]]);
    const track = { labels: [], resolved: [] };

    assert.deepStrictEqual(
        planExecutor.bind('$s1.paths', environment, track), ['/tmp/a.md']);
    assert.strictEqual(
        planExecutor.bind('the file is $s1.paths', environment, track),
        'the file is $s1.paths');
});

test('a step handed nothing stops the plan instead of continuing over it', async () => {
    const dir = scratch();
    const graph = fakeGraph({
        nothing: {
            tier: 0, description: 'finds nothing',
            inputs: {}, outputs: { paths: { type: 'string[]' } },
            produces: labels.label(ORIGIN.FILE, SENSITIVITY.PERSONAL),
            run: async () => ({ paths: [] })
        }
    });

    const result = await planExecutor.run({
        goal: 'read what was found',
        steps: [
            { id: 's1', capability: 'nothing', inputs: {}, reason: 'search' },
            { id: 's2', capability: 'read', inputs: { paths: '$s1.paths' }, reason: 'read them' },
            { id: 's3', capability: 'say', inputs: { question: 'what?', passages: '$s2.passages' }, reason: 'answer' }
        ],
        missing: []
    }, { graph, request: 'what do my notes say' });

    assert.strictEqual(result.status, 'empty');
    assert.strictEqual(result.completed, 1);
    assert.match(result.text, /I found nothing/);
    assert.match(result.text, /step to search came back empty/);
    assert.ok(!/\bs1\b/.test(result.text), 'step ids are not for the user');
    assert.ok(!/no access/i.test(result.text));

    cleanup(dir);
});

test('an empty result is not filed as a broken capability', async () => {
    const dir = scratch();
    const graph = fakeGraph({
        nothing: {
            tier: 0, description: 'finds nothing',
            inputs: {}, outputs: { paths: { type: 'string[]' } },
            produces: labels.label(ORIGIN.FILE, SENSITIVITY.PERSONAL),
            run: async () => ({ paths: [] })
        }
    });

    const result = await planExecutor.run({
        goal: 'x',
        steps: [
            { id: 's1', capability: 'nothing', inputs: {} },
            { id: 's2', capability: 'read', inputs: { paths: '$s1.paths' } }
        ],
        missing: []
    }, { graph, request: 'x' });

    assert.strictEqual(traceStore.getPlan(result.planId).status, 'empty');
    const stats = Object.fromEntries(traceStore.capabilityStats().map(s => [s.capability, s]));
    assert.strictEqual(stats.nothing.success_rate, 1);

    cleanup(dir);
});

test('SECURITY: the label follows the data across steps', async () => {
    const dir = scratch();

    const result = await planExecutor.run({
        goal: 'read then speak',
        steps: [
            { id: 's1', capability: 'find', inputs: { what: 'salary' } },
            { id: 's2', capability: 'read', inputs: { paths: '$s1.paths' } },
            { id: 's3', capability: 'say', inputs: { question: 'how much?', passages: '$s2.passages' } }
        ],
        missing: []
    }, { graph: GRAPH, request: 'how much do I earn' });

    assert.strictEqual(result.status, 'success');

    const final = result.label;
    assert.ok(final.origins.includes(ORIGIN.FILE),
        'reading a file must taint everything downstream of it');
    assert.strictEqual(final.sensitivity, SENSITIVITY.PERSONAL);
    assert.strictEqual(labels.isInstructionSafe(final), false);

    cleanup(dir);
});

test('ATTACK: a plan cannot launder personal data into a network step', async () => {
    const dir = scratch();

    const result = await planExecutor.run({
        goal: 'read a file then publish it',
        steps: [
            { id: 's1', capability: 'find', inputs: { what: 'salary' } },
            { id: 's2', capability: 'read', inputs: { paths: '$s1.paths' } },
            { id: 's3', capability: 'say', inputs: { question: 'summarise', passages: '$s2.passages' } },
            { id: 's4', capability: 'publish', inputs: { body: '$s3.text' } }
        ],
        missing: []
    }, { graph: GRAPH, request: 'summarise my salary and post it' });

    assert.strictEqual(result.status, 'blocked');
    assert.strictEqual(result.failure.step, 's4');
    assert.strictEqual(result.completed, 3);
    assert.match(result.text, /3 of 4 steps/);

    cleanup(dir);
});

test('a step that changes the machine is recorded but not gated', async () => {
    const dir = scratch();

    const result = await planExecutor.run({
        goal: 'tidy the desktop',
        steps: [{ id: 's1', capability: 'tidy', inputs: { folder: '~/Desktop' }, reason: 'tidy up' }],
        missing: []
    }, { graph: GRAPH, request: 'tidy my desktop' });

    assert.strictEqual(result.status, 'success');
    const audit = securityStore.recentDecisions(10);
    assert.ok(audit.some(row => row.channel === 'mutation' && row.action === 'tidy'),
        'a mutation must reach the audit ledger');

    cleanup(dir);
});

test('a step needing consent is blocked before it opens anything', async () => {
    const dir = scratch({ grant: false });

    const result = await planExecutor.run({
        goal: 'read a file',
        steps: [{ id: 's1', capability: 'read', inputs: { paths: ['/tmp/x.md'] } }],
        missing: []
    }, { graph: GRAPH, request: 'read x' });

    assert.strictEqual(result.status, 'blocked');
    assert.match(result.text, /index-corpus/);

    cleanup(dir);
});

test('granting a folder unblocks the step that needed it', async () => {
    const dir = scratch();

    const result = await planExecutor.run({
        goal: 'read a file',
        steps: [{ id: 's1', capability: 'read', inputs: { paths: ['/tmp/x.md'] } }],
        missing: []
    }, { graph: GRAPH, request: 'read x' });

    assert.strictEqual(result.status, 'success');

    cleanup(dir);
});

test('a failing step stops the plan and reports what did get done', async () => {
    const dir = scratch();

    const result = await planExecutor.run({
        goal: 'find then fail then speak',
        steps: [
            { id: 's1', capability: 'find', inputs: { what: 'x' }, reason: 'locate' },
            { id: 's2', capability: 'explode', inputs: {}, reason: 'break' },
            { id: 's3', capability: 'say', inputs: { question: 'never' }, reason: 'unreached' }
        ],
        missing: []
    }, { graph: GRAPH, request: 'do three things' });

    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.completed, 1);
    assert.strictEqual(result.steps.length, 2, 'nothing after the failure may run');
    assert.match(result.text, /the surface moved/);

    cleanup(dir);
});

test('a plan reports the part it had no way to carry out', async () => {
    const dir = scratch();

    const result = await planExecutor.run({
        goal: 'answer, and post to slack',
        steps: [{ id: 's1', capability: 'say', inputs: { question: 'what is a mutex?' } }],
        missing: ['posting to Slack']
    }, { graph: GRAPH, request: 'explain mutexes and post it to slack' });

    assert.strictEqual(result.status, 'success');
    assert.match(result.text, /no way to do this part: posting to Slack/);

    cleanup(dir);
});


const bridge = require('../services/openclawBridge');

test('a plan that only talks is not composition', () => {
    assert.strictEqual(bridge.isRealComposition({
        steps: [{ id: 's1', capability: 'answer', inputs: {} }],
        missing: []
    }), false);
});

test('a plan that admits a gap and changes nothing is downgraded to a gap', () => {
    assert.strictEqual(planner.changesAnything({
        steps: [
            { id: 's1', capability: 'find', inputs: {} },
            { id: 's2', capability: 'read', inputs: { paths: '$s1.paths' } },
            { id: 's3', capability: 'say', inputs: { question: 'how do I convert these?' } }
        ],
        missing: ['converting an image from one format to another']
    }, GRAPH), false);
});

test('a gap alongside real work still runs the real work', () => {
    assert.strictEqual(planner.changesAnything({
        steps: [{ id: 's1', capability: 'tidy', inputs: { folder: '~/Desktop' } }],
        missing: ['posting to Slack']
    }, GRAPH), true);
});

test('a plan with nothing missing is never downgraded', () => {
    assert.strictEqual(planner.changesAnything({
        steps: [{ id: 's1', capability: 'say', inputs: { question: 'what is a mutex?' } }],
        missing: []
    }, GRAPH), true);
});

test('an ordinary multi-step plan is composition', () => {
    assert.strictEqual(bridge.isRealComposition({
        steps: [
            { id: 's1', capability: 'files.search', inputs: { text: 'boiler' } },
            { id: 's2', capability: 'files.read', inputs: { paths: '$s1.paths' } },
            { id: 's3', capability: 'answer', inputs: { question: 'when?' } }
        ],
        missing: []
    }), true);
});


test('every step is recorded, including the one that failed', async () => {
    const dir = scratch();

    const result = await planExecutor.run({
        goal: 'find then fail',
        steps: [
            { id: 's1', capability: 'find', inputs: { what: 'x' } },
            { id: 's2', capability: 'explode', inputs: {} }
        ],
        missing: []
    }, { graph: GRAPH, request: 'do two things' });

    const traced = traceStore.getPlan(result.planId);
    assert.strictEqual(traced.status, 'failed');
    assert.strictEqual(traced.steps.length, 2);
    assert.strictEqual(traced.steps[0].status, 'success');
    assert.strictEqual(traced.steps[1].status, 'failed');
    assert.match(traced.steps[1].error, /surface moved/);
    assert.strictEqual(traced.steps[0].tier, 0);

    cleanup(dir);
});

test('the trace records what a step touched, not what it read', async () => {
    const dir = scratch();

    const result = await planExecutor.run({
        goal: 'read a file',
        steps: [{ id: 's1', capability: 'read', inputs: { paths: ['/tmp/secrets.md'] } }],
        missing: []
    }, { graph: GRAPH, request: 'read it' });

    const traced = traceStore.getPlan(result.planId);
    assert.strictEqual(traced.steps[0].summary, 'passages: 1 item(s)');
    assert.ok(!JSON.stringify(traced).includes('contents of'),
        'file contents must not reach the trace');
    assert.ok(traced.steps[0].label.origins.includes(ORIGIN.FILE));

    cleanup(dir);
});

test('capability reliability is a query, not an opinion', async () => {
    const dir = scratch();

    for (let i = 0; i < 2; i++) {
        await planExecutor.run({
            goal: 'x',
            steps: [
                { id: 's1', capability: 'find', inputs: { what: 'x' } },
                { id: 's2', capability: 'explode', inputs: {} }
            ],
            missing: []
        }, { graph: GRAPH, request: 'x' });
    }

    const stats = Object.fromEntries(traceStore.capabilityStats().map(s => [s.capability, s]));
    assert.strictEqual(stats.find.success_rate, 1);
    assert.strictEqual(stats.explode.success_rate, 0);
    assert.strictEqual(stats.explode.runs, 2);

    cleanup(dir);
});

test('requests that could not be planned are kept as a backlog', () => {
    const dir = scratch();

    traceStore.finishPlan(
        traceStore.beginPlan({ request: 'post this to slack', status: 'planned' }),
        { status: 'rejected', error: 'no capability: slack.post' }
    );

    const backlog = traceStore.gaps();
    assert.strictEqual(backlog.length, 1);
    assert.match(backlog[0].error, /slack\.post/);

    cleanup(dir);
});

test('a trace summary reports shape rather than content', () => {
    assert.strictEqual(traceStore.summarise([1, 2, 3]), '3 item(s)');
    assert.strictEqual(traceStore.summarise({ files: [1, 2] }), 'files: 2 item(s)');
    assert.strictEqual(
        traceStore.summarise('x'.repeat(traceStore.MAX_SUMMARY_CHARS + 50)).length,
        traceStore.MAX_SUMMARY_CHARS + 1);
});

test('the mail provider maps names to mailbox addresses with a safe default', () => {
    assert.strictEqual(mailProvider.current({}).url, 'https://mail.google.com');
    assert.strictEqual(mailProvider.current({ mail: { provider: 'outlook' } }).url,
        'https://outlook.live.com/mail');
    assert.strictEqual(mailProvider.current({ mail: { provider: 'outlook-work' } }).url,
        'https://outlook.office.com/mail');
    assert.strictEqual(mailProvider.current({ mail: { provider: 'compuserve' } }).name, 'gmail');
});

test('the plan prompt steers mail at the configured provider, not a hardcoded one', () => {
    const prompt = planner.buildPlanPrompt([]);
    const configured = mailProvider.current(
        JSON.parse(fs.readFileSync(process.env.JARVIS_CONFIG_PATH
            || path.join(__dirname, '..', '..', 'config.json'), 'utf8'))).url;
    assert.ok(prompt.includes(configured), 'the configured mailbox address must appear');
    assert.ok(!prompt.includes('${MAIL_URL}'), 'the template token must be substituted');
});

test('a named account steers the request to its own mailbox', () => {
    const config = {
        mail: {
            provider: 'gmail',
            accounts: { personal: 'gmail', work: 'outlook-work' }
        }
    };

    // The account name must qualify a mail word to steer.
    assert.strictEqual(mailProvider.forRequest('check my work mail', config).url,
        'https://outlook.office.com/mail');
    assert.strictEqual(mailProvider.forRequest('anything new in the work inbox?', config).url,
        'https://outlook.office.com/mail');
    assert.strictEqual(mailProvider.forRequest('open my work email', config).url,
        'https://outlook.office.com/mail');
    assert.strictEqual(mailProvider.forRequest('check my personal mailbox', config).url,
        'https://mail.google.com');

    // A bare mention of the word is not a steer: the default account holds.
    assert.strictEqual(mailProvider.forRequest('tell my work colleague I am late', config).url,
        'https://mail.google.com');
    assert.strictEqual(mailProvider.forRequest('reply to Sam saying hi', config).url,
        'https://mail.google.com');
    assert.strictEqual(mailProvider.forRequest('', config).url,
        'https://mail.google.com');

    // An account naming a provider that does not exist is ignored, not served.
    const broken = { mail: { accounts: { work: 'compuserve' } } };
    assert.strictEqual(mailProvider.forRequest('check my work mail', broken).url,
        'https://mail.google.com');
    assert.deepStrictEqual(mailProvider.accounts(broken), []);

    // And the plan prompt for a steered request carries the steered mailbox.
    const prompt = planner.buildPlanPrompt([], mailProvider.forRequest('check my work mail', config).url);
    assert.ok(prompt.includes('https://outlook.office.com/mail'),
        'the steered mailbox address must appear in the prompt');
});

test('a recipe surface applies only to the mailbox the request steers to', () => {
    const outlook = { mail: { provider: 'outlook' } };
    assert.ok(mailProvider.surfaceApplies('mail.google.com', '', {}));
    assert.ok(!mailProvider.surfaceApplies('mail.google.com', '', outlook));
    assert.ok(mailProvider.surfaceApplies('outlook.live.com', '', outlook));

    // A surface that is not a mailbox never participates.
    assert.ok(mailProvider.surfaceApplies('calendar.google.com', '', outlook));
    assert.ok(mailProvider.surfaceApplies(undefined, '', outlook));

    // Account steering decides applicability per request, not per config.
    const steered = { mail: { provider: 'gmail', accounts: { work: 'outlook-work' } } };
    assert.ok(!mailProvider.surfaceApplies('mail.google.com', 'check my work mail', steered));
    assert.ok(mailProvider.surfaceApplies('outlook.office.com', 'check my work mail', steered));
    assert.ok(mailProvider.surfaceApplies('mail.google.com', 'reply to Sam saying hi', steered));
});

const failureTaxonomy = require('../services/failureTaxonomy');
const negativeMemory = require('../services/negativeMemory');

test('the failure taxonomy names every observed class of trouble', () => {
    assert.strictEqual(failureTaxonomy.classifyStep(
        { capability: 'web.browse', error: 'model call timed out after 45000ms' }), 'timeout');
    assert.strictEqual(failureTaxonomy.classifyStep(
        { capability: 'web.browse', error: 'transport_error: connect ECONNREFUSED 127.0.0.1:8787' }), 'model_unreachable');
    assert.strictEqual(failureTaxonomy.classifyStep(
        { capability: 'web.browse', error: 'stopped at a password field' }), 'credential_boundary');
    assert.strictEqual(failureTaxonomy.classifyStep(
        { capability: 'web.browse', error: 'pressing Send is outside what was asked' }), 'mandate_blocked');
    assert.strictEqual(failureTaxonomy.classifyStep(
        { capability: 'procedure.gmail-search', error: 'selector matched nothing' }), 'site_drift');
    assert.strictEqual(failureTaxonomy.classifyStep(
        { capability: 'skill.csv-to-json', error: 'exit code 2' }), 'execution_error');
    assert.strictEqual(failureTaxonomy.classifyGeneration(
        { failure: 'grounded_trial_failed' }), 'grounding_failure');
    assert.strictEqual(failureTaxonomy.classifyGeneration(
        { failure: 'script_syntax_error' }), 'generation_static');
    for (const name of Object.keys(failureTaxonomy.report().classes)) {
        assert.ok(failureTaxonomy.CLASSES.includes(name));
    }
});

test('a recipe that failed its last two runs is not offered again', () => {
    const dir = scratch();
    try {
        const recipe = { id: 'procedure.gmail-search', kind: 'procedure' };
        const record = status => {
            const planId = traceStore.beginPlan({
                request: 'search my mail', status: status === 'failed' ? 'failed' : 'success',
                stepCount: 1
            });
            traceStore.recordStep(planId, {
                ordinal: 0, key: 's1', capability: recipe.id, status,
                error: status === 'failed' ? 'selector matched nothing' : null
            });
        };

        record('success');
        assert.strictEqual(negativeMemory.isBlocked(recipe.id), false);

        record('failed');
        assert.strictEqual(negativeMemory.isBlocked(recipe.id), false,
            'one failure is not a pattern');

        record('failed');
        assert.strictEqual(negativeMemory.isBlocked(recipe.id), true);
        assert.deepStrictEqual(negativeMemory.offerable([recipe]), []);

        record('success');
        assert.strictEqual(negativeMemory.isBlocked(recipe.id), false,
            'a success clears the block');

        assert.strictEqual(negativeMemory.isBlocked('skill.csv-to-json'), false,
            'only recipes are subject to negative memory');

        const failures = failureTaxonomy.report();
        assert.ok(failures.classes.site_drift.count >= 2);
        assert.strictEqual(failures.classes.site_drift.examples[0].request, 'search my mail');
    } finally {
        cleanup(dir);
    }
});
