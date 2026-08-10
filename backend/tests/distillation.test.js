const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const fixture = require('./webFixture');
const traceStore = require('../services/traceStore');
const procedureStore = require('../services/procedureStore');
const procedureRunner = require('../services/procedureRunner');
const distiller = require('../services/distiller');
const capabilityGraph = require('../services/capabilityGraph');
const webAgent = require('../services/webAgent');
const browser = require('../services/browser');
const securityStore = require('../security/store');
const labels = require('../security/labels');

const { ORIGIN, SENSITIVITY } = labels;
const USER = labels.label(ORIGIN.USER, SENSITIVITY.PERSONAL);


function scratch() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-distil-'));
    traceStore.open(path.join(dir, 'traces.db'));
    securityStore.open(path.join(dir, 'security.db'));
    procedureStore.open(path.join(dir, 'procedures'));
    procedureStore.reload();

    return {
        dir,
        cleanup() {
            traceStore.close();
            securityStore.close();
            procedureStore.open();
            procedureStore.reload();
            capabilityGraph.reset();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    };
}

function searchRun({ goal, typed, surface = 'books.example', start = 'https://books.example/search',
    steps = null, status = 'success' } = {}) {

    const parent = traceStore.beginPlan({ request: 'outer', status: 'running' });
    const id = traceStore.beginPlan({
        request: goal, goal, status: 'running',
        parentPlanId: parent, parentStep: 's1', surface,
        detail: { budget: 8, start }
    });

    const recorded = steps || [
        { capability: 'web.fill', status: 'success',
          inputs: { role: 'textbox', name: 'Title or author', ref: 'e1', text: typed } },
        { capability: 'web.click', status: 'success',
          inputs: { role: 'button', name: 'Search', ref: 'e2' } },
        { capability: 'web.done', status: 'success', summary: 'found it' }
    ];

    recorded.forEach((step, ordinal) =>
        traceStore.recordStep(id, { ordinal, key: `a${ordinal + 1}`, tier: 2, ...step }));
    traceStore.finishPlan(id, { status, runMs: 9000 });
    return id;
}

const TWO_GOALS = [
    { goal: 'what does the bookshop say about The Long Field', typed: 'The Long Field' },
    { goal: 'what does the bookshop say about Wild Places', typed: 'Wild Places' }
];


test('one successful run is not enough, however well it went', () => {
    const world = scratch();
    try {
        searchRun(TWO_GOALS[0]);
        const result = distiller.distil({});

        assert.strictEqual(result.learned.length, 0);
        assert.match(result.skipped[0].why, /not distinguishable from a constant/);
    } finally { world.cleanup(); }
});

test('a value that varies with the request becomes a parameter', () => {
    const world = scratch();
    try {
        TWO_GOALS.forEach(searchRun);
        const [learned] = distiller.distil({}).learned;

        assert.ok(learned, 'two agreeing runs should distil');
        assert.strictEqual(learned.goal_template, 'what does the bookshop say about {title}');
        assert.deepStrictEqual(Object.keys(learned.parameters), ['title']);

        const fill = learned.steps.find(step => step.action === 'fill');
        assert.strictEqual(fill.slot, 'title');
        assert.strictEqual(fill.text, undefined, 'a slot must not also carry a literal');
    } finally { world.cleanup(); }
});

test('a learned capability is named something the planner can type', () => {
    const world = scratch();
    try {
        TWO_GOALS.forEach(entry => searchRun({ ...entry, surface: '127.0.0.1' }));
        const [learned] = distiller.distil({}).learned;

        assert.ok(!/\d/.test(learned.name), `"${learned.name}" should not carry an IP address`);
        assert.ok(learned.name.split('-').length <= 4, `"${learned.name}" is too long to copy`);
        assert.match(learned.description, /127\.0\.0\.1/);
    } finally { world.cleanup(); }
});

test('a hostname with words in it keeps them, and drops the ones that are not', () => {
    assert.strictEqual(distiller.procedureName('www.bl.uk', 'opening times', new Set()), 'bl-opening-times');
    assert.strictEqual(distiller.procedureName('10.0.0.4', 'opening times', new Set()), 'opening-times');
});

test('a value that stays the same across runs is a constant of the site', () => {
    const world = scratch();
    try {
        searchRun({ goal: 'check the bookshop for new arrivals', typed: 'new arrivals' });
        searchRun({ goal: 'check the bookshop for new arrivals', typed: 'new arrivals' });

        const [learned] = distiller.distil({}).learned;

        assert.deepStrictEqual(learned.parameters, {});
        assert.strictEqual(learned.steps.find(step => step.action === 'fill').text, 'new arrivals');
    } finally { world.cleanup(); }
});

test('requests that differ in a way the actions ignore are not one procedure', () => {
    const world = scratch();
    try {
        searchRun({ goal: 'when does the bookshop cafe close', typed: 'opening times' });
        searchRun({ goal: 'when does the bookshop shop close', typed: 'opening times' });

        const result = distiller.distil({});
        assert.strictEqual(result.learned.length, 0);
        assert.match(result.skipped[0].why, /differ in a way the actions do not account for/);
    } finally { world.cleanup(); }
});

test('two requests with almost nothing in common are not one procedure', () => {
    const world = scratch();
    try {
        searchRun({ goal: 'price of The Long Field', typed: 'The Long Field' });
        searchRun({ goal: 'find Wild Places', typed: 'Wild Places' });

        const result = distiller.distil({});
        assert.strictEqual(result.learned.length, 0);
        assert.match(result.skipped[0].why, /word\(s\) in common/);
    } finally { world.cleanup(); }
});

test('a typed value that varies for some other reason is not a parameter', () => {
    const world = scratch();
    try {
        searchRun({ goal: 'what does the bookshop say about The Long Field', typed: 'gardening' });
        searchRun({ goal: 'what does the bookshop say about Wild Places', typed: 'cookery' });

        const result = distiller.distil({});
        assert.strictEqual(result.learned.length, 0);
        assert.match(result.skipped[0].why, /varied without varying with the request/);
    } finally { world.cleanup(); }
});


test('a run in which anything was refused is never promoted', () => {
    const world = scratch();
    try {
        const withRefusal = [
            { capability: 'web.click', status: 'blocked',
              inputs: { role: 'button', name: 'Place order' }, error: 'spends money' },
            { capability: 'web.fill', status: 'success',
              inputs: { role: 'textbox', name: 'Title or author', text: 'The Long Field' } },
            { capability: 'web.click', status: 'success', inputs: { role: 'button', name: 'Search' } },
            { capability: 'web.done', status: 'success' }
        ];

        searchRun({ ...TWO_GOALS[0], steps: withRefusal });
        searchRun({ ...TWO_GOALS[1], steps: withRefusal });

        const result = distiller.distil({});
        assert.strictEqual(result.learned.length, 0);
        assert.match(result.skipped[0].why, /refused/);
    } finally { world.cleanup(); }
});

test('a typed value that did not come from the user is never baked into a recipe', () => {
    const world = scratch();
    try {
        TWO_GOALS.forEach(entry => searchRun({ ...entry, typed: '(text)' }));

        const result = distiller.distil({});
        assert.strictEqual(result.learned.length, 0);
        assert.match(result.skipped[0].why, /not the user's own/);
    } finally { world.cleanup(); }
});

test('a run traced before elements were recorded by name cannot be replayed', () => {
    const world = scratch();
    try {
        const oldShape = [
            { capability: 'web.click', status: 'success', inputs: { ref: 'e4' } },
            { capability: 'web.done', status: 'success' }
        ];
        searchRun({ ...TWO_GOALS[0], steps: oldShape });
        searchRun({ ...TWO_GOALS[1], steps: oldShape });

        const result = distiller.distil({});
        assert.strictEqual(result.learned.length, 0);
        assert.match(result.skipped[0].why, /traced before elements were recorded by name/);
    } finally { world.cleanup(); }
});

test('a run that did not reach its goal is not a procedure for reaching it', () => {
    const world = scratch();
    try {
        const gaveUp = [
            { capability: 'web.click', status: 'success', inputs: { role: 'link', name: 'Opening hours' } },
            { capability: 'web.give_up', status: 'skipped', error: 'not on this site' }
        ];
        searchRun({ ...TWO_GOALS[0], steps: gaveUp, status: 'gap' });
        searchRun({ ...TWO_GOALS[1], steps: gaveUp, status: 'gap' });

        assert.strictEqual(traceStore.procedures({}).length, 0);
        assert.strictEqual(distiller.distil({}).learned.length, 0);
    } finally { world.cleanup(); }
});

test('the run\'s mistakes are not part of the procedure it found', () => {
    const world = scratch();
    try {
        const fumbled = typed => [
            { capability: 'web.decide', status: 'failed', error: 'reply was not JSON' },
            { capability: 'web.click', status: 'failed', inputs: { role: 'link', name: 'Search' }, error: 'bad ref' },
            { capability: 'web.fill', status: 'success',
              inputs: { role: 'textbox', name: 'Title or author', text: typed } },
            { capability: 'web.click', status: 'success', inputs: { role: 'button', name: 'Search' } },
            { capability: 'web.done', status: 'success' }
        ];

        searchRun({ ...TWO_GOALS[0], steps: fumbled('The Long Field') });
        searchRun(TWO_GOALS[1]);

        const [learned] = distiller.distil({}).learned;
        assert.ok(learned, 'a clean run and a fumbled one describe the same procedure');
        assert.strictEqual(learned.steps.length, 2);
    } finally { world.cleanup(); }
});

test('runs that started on different pages are different procedures', () => {
    const world = scratch();
    try {
        searchRun({ ...TWO_GOALS[0], start: 'https://books.example/' });
        searchRun({ ...TWO_GOALS[1], start: 'https://books.example/search' });

        const result = distiller.distil({});
        assert.strictEqual(result.learned.length, 0);
        assert.strictEqual(result.groups, 2, 'where a replay begins is part of what it does');
    } finally { world.cleanup(); }
});

test('distilling twice does not learn the same thing twice', () => {
    const world = scratch();
    try {
        TWO_GOALS.forEach(searchRun);
        assert.strictEqual(distiller.distil({}).learned.length, 1);

        const second = distiller.distil({});
        assert.strictEqual(second.learned.length, 0);
        assert.match(second.skipped[0].why, /already known/);
        assert.strictEqual(procedureStore.all().length, 1);
    } finally { world.cleanup(); }
});


test('a fill step with neither a value nor a slot is not a procedure', () => {
    const base = {
        name: 'x', surface: 'a.example', start_url: 'https://a.example/',
        description: 'd', parameters: {}
    };
    assert.strictEqual(
        procedureStore.validate({ ...base, steps: [{ action: 'fill', name: 'Q' }] }).valid, false);
    assert.strictEqual(
        procedureStore.validate({ ...base, steps: [{ action: 'fill', name: 'Q', text: 'a', slot: 'b' }] }).valid,
        false);
});

test('a slot that is not a declared parameter is rejected', () => {
    const result = procedureStore.validate({
        name: 'x', surface: 'a.example', start_url: 'https://a.example/', description: 'd',
        parameters: {}, steps: [{ action: 'fill', name: 'Q', slot: 'title' }]
    });
    assert.strictEqual(result.valid, false);
    assert.match(result.errors.join(' '), /not a declared parameter/);
});

test('an address can carry an argument, and only a declared one', () => {
    const base = {
        name: 'x', surface: 'a.example', start_url: 'https://a.example/', description: 'd',
        parameters: { date: { type: 'string', required: true, description: 'the day' } }
    };

    assert.strictEqual(procedureStore.validate({
        ...base, steps: [{ action: 'navigate', url: 'https://a.example/day/{date}' }]
    }).valid, true);

    const undeclared = procedureStore.validate({
        ...base, steps: [{ action: 'navigate', url: 'https://a.example/day/{month}' }]
    });
    assert.strictEqual(undeclared.valid, false);
    assert.match(undeclared.errors.join(' '), /not a declared parameter/);

    assert.strictEqual(procedureStore.validate({
        ...base, steps: [{ action: 'navigate', url: 'https://a.example/today' }]
    }).valid, true);

    assert.strictEqual(
        procedureStore.fillSlots('https://a.example/day/{date}', { date: '2026/8/15' }),
        'https://a.example/day/2026/8/15');

    assert.strictEqual(
        procedureStore.fillSlots('https://a.example/day/{date}', {}),
        'https://a.example/day/{date}');
});

test('a procedure that fails twice running stops being offered', () => {
    const world = scratch();
    try {
        TWO_GOALS.forEach(searchRun);
        const [learned] = distiller.distil({}).learned;

        procedureStore.recordReplay(learned.name, { ok: false, error: 'gone' });
        assert.strictEqual(procedureStore.list().length, 1, 'once is the network');

        procedureStore.recordReplay(learned.name, { ok: false, error: 'gone' });
        assert.strictEqual(procedureStore.list().length, 0, 'twice is the site having changed');

        assert.strictEqual(procedureStore.all().length, 1);
        assert.strictEqual(procedureStore.get(learned.name).health.last_error, 'gone');
    } finally { world.cleanup(); }
});

test('a success clears the failure that preceded it', () => {
    const world = scratch();
    try {
        TWO_GOALS.forEach(searchRun);
        const [learned] = distiller.distil({}).learned;

        procedureStore.recordReplay(learned.name, { ok: false, error: 'timed out' });
        procedureStore.recordReplay(learned.name, { ok: true });
        procedureStore.recordReplay(learned.name, { ok: false, error: 'timed out' });

        assert.strictEqual(procedureStore.list().length, 1);
        assert.strictEqual(procedureStore.get(learned.name).health.consecutive_failures, 1);
    } finally { world.cleanup(); }
});

test('health survives a restart, because a broken recipe must not be re-learned as healthy', () => {
    const world = scratch();
    try {
        TWO_GOALS.forEach(searchRun);
        const [learned] = distiller.distil({}).learned;
        procedureStore.recordReplay(learned.name, { ok: false, error: 'gone' });
        procedureStore.recordReplay(learned.name, { ok: false, error: 'gone' });

        procedureStore.reload();
        assert.strictEqual(procedureStore.list().length, 0);
    } finally { world.cleanup(); }
});


test('a learned procedure enters the catalogue at the recipe tier', () => {
    const world = scratch();
    try {
        TWO_GOALS.forEach(searchRun);
        const [learned] = distiller.distil({}).learned;

        capabilityGraph.reset();
        const capability = capabilityGraph.get(`procedure.${learned.name}`);

        assert.ok(capability, 'the planner should be able to see what the system taught itself');
        assert.strictEqual(capability.tier, capabilityGraph.TIER.RECIPE);
        assert.strictEqual(capability.inputs.title.required, true);
        assert.ok(capability.effects.includes(capabilityGraph.EFFECT.NETWORK));

        assert.ok(capability.disclosurePolicy);
        assert.strictEqual(capability.disclosurePolicy(USER).decision, 'allow');
    } finally { world.cleanup(); }
});

test('a retired procedure is not in the catalogue', () => {
    const world = scratch();
    try {
        TWO_GOALS.forEach(searchRun);
        const [learned] = distiller.distil({}).learned;

        procedureStore.recordReplay(learned.name, { ok: false, error: 'gone' });
        procedureStore.recordReplay(learned.name, { ok: false, error: 'gone' });

        capabilityGraph.reset();
        assert.strictEqual(capabilityGraph.get(`procedure.${learned.name}`), null);
    } finally { world.cleanup(); }
});


test('identically named controls are told apart by position, which a ref cannot do', () => {
    const observation = {
        elements: [
            { ref: 'e1', role: 'button', name: 'Add to basket' },
            { ref: 'e2', role: 'button', name: 'Add to basket' },
            { ref: 'e3', role: 'button', name: 'Checkout' }
        ]
    };

    assert.strictEqual(webAgent.anchorFor(observation.elements[1], observation).nth, 1);
    assert.strictEqual(webAgent.anchorFor(observation.elements[2], observation).nth, undefined);
});

test('a recorded action is matched by what it acted on, not by its ref', () => {
    const observation = {
        url: 'https://a.example/',
        elements: [
            { ref: 'e9', role: 'button', name: 'Search' },
            { ref: 'e4', role: 'link', name: 'search' }
        ]
    };

    assert.strictEqual(
        procedureRunner.match(observation, { action: 'click', role: 'button', name: 'Search' }).element.ref,
        'e9');

    const missing = procedureRunner.match(observation, { action: 'click', role: 'button', name: 'Buy' });
    assert.strictEqual(missing.element, null);
    assert.match(missing.why, /no button called "Buy"/);
});

test('a name that is a prefix of another name is not a match for it', () => {
    const observation = {
        url: 'https://a.example/',
        elements: [{ ref: 'e1', role: 'button', name: 'Search all archived orders' }]
    };
    assert.strictEqual(
        procedureRunner.match(observation, { action: 'click', role: 'button', name: 'Search' }).element,
        null);
});

test('the typed text is only kept when the trace already holds every word of it', () => {
    const goal = 'find the price of The Long Field';
    assert.strictEqual(webAgent.recordableText('The Long Field', goal), 'The Long Field');
    assert.strictEqual(webAgent.recordableText('promo code SPRING24', goal), '(text)');
});


test('a learned procedure replays with a value it has never seen', async () => {
    const world = scratch();
    const site = await fixture.start();
    try {
        TWO_GOALS.forEach(entry => searchRun({
            ...entry, surface: '127.0.0.1', start: `${site.origin}/search`
        }));
        const [learned] = distiller.distil({}).learned;

        const result = await procedureRunner.replay(learned, { title: 'Wild Places' }, {
            label: USER, allowPrivate: true, trace: false
        });

        assert.strictEqual(result.status, 'success', result.reason || '');
        assert.match(result.url, /\/results\?/);
        assert.ok(site.requests.some(url => /\/results\?.*Wild\+Places/.test(url)),
            `expected a search for the new value, saw ${JSON.stringify(site.requests)}`);
    } finally {
        await browser.close();
        await site.close();
        world.cleanup();
    }
});

test('replay is recorded at tier 1 on the same surface the loop ran at tier 2', async () => {
    const world = scratch();
    const site = await fixture.start();
    try {
        TWO_GOALS.forEach(entry => searchRun({
            ...entry, surface: '127.0.0.1', start: `${site.origin}/search`
        }));
        const [learned] = distiller.distil({}).learned;

        const result = await procedureRunner.replay(learned, { title: 'The Long Field' }, {
            label: USER, allowPrivate: true
        });

        const recorded = traceStore.getPlan(result.planId);
        assert.strictEqual(recorded.surface, '127.0.0.1');
        assert.ok(recorded.steps.length);
        assert.ok(recorded.steps.every(step => step.tier === 1));
    } finally {
        await browser.close();
        await site.close();
        world.cleanup();
    }
});

test('a procedure whose page has changed fails loudly instead of clicking something else', async () => {
    const world = scratch();
    const site = await fixture.start();
    try {
        const stale = procedureStore.save({
            name: 'fixture-moved-on',
            surface: '127.0.0.1',
            start_url: `${site.origin}/search`,
            goal_template: 'search for {title}',
            description: 'a procedure describing a page that no longer looks like this',
            parameters: { title: { type: 'string', required: true, description: '' } },
            steps: [
                { action: 'fill', role: 'textbox', name: 'Title or author', slot: 'title' },
                { action: 'click', role: 'button', name: 'Find it now' }
            ]
        });

        const result = await procedureRunner.replay(stale, { title: 'Wild Places' }, {
            label: USER, allowPrivate: true, trace: false
        });

        assert.strictEqual(result.status, 'stale');
        assert.match(result.reason, /no button called "Find it now"/);
        assert.ok(!site.requests.some(url => url.startsWith('/results')));
        assert.strictEqual(procedureStore.get('fixture-moved-on').health.consecutive_failures, 1);
    } finally {
        await browser.close();
        await site.close();
        world.cleanup();
    }
});

test('ATTACK: a recipe is not permitted to do what the loop was refused', async () => {
    const world = scratch();
    const site = await fixture.start();
    try {
        const forged = procedureStore.save({
            name: 'fixture-sign-in',
            surface: '127.0.0.1',
            start_url: `${site.origin}/account`,
            goal_template: 'sign in with {password}',
            description: 'a procedure that should not be able to exist',
            parameters: { password: { type: 'string', required: true, description: '' } },
            steps: [{ action: 'fill', role: 'textbox', name: 'Password', slot: 'password' }]
        });

        const result = await procedureRunner.replay(forged, { password: 'hunter2' }, {
            label: USER, allowPrivate: true, trace: false
        });

        assert.strictEqual(result.status, 'blocked');
        assert.match(result.reason, /never fills these/);

        assert.strictEqual(procedureStore.get('fixture-sign-in').health.replays, 0);
    } finally {
        await browser.close();
        await site.close();
        world.cleanup();
    }
});

test('a procedure pointed at a private address is refused like any other navigation', async () => {
    const world = scratch();
    try {
        const inward = procedureStore.save({
            name: 'fixture-inward',
            surface: '127.0.0.1',
            start_url: 'http://127.0.0.1:8787/v1/models',
            goal_template: 'read the model list',
            description: 'a procedure aimed at this machine',
            parameters: {},
            steps: [{ action: 'click', role: 'link', name: 'anything' }]
        });

        const result = await procedureRunner.replay(inward, {}, { label: USER, trace: false });

        assert.strictEqual(result.status, 'blocked');
        assert.match(result.reason, /private|loopback|this machine/i);
    } finally { world.cleanup(); }
});


const FAMILY_BASE = {
    surface: 'mail.example', start_url: 'https://mail.example/',
    family: 'post', parameters: {}
};

function member(name, action, steps, parameters = {}) {
    return {
        ...FAMILY_BASE, name, action, parameters, steps,
        description: `${action} something`
    };
}

test('recipes that do one kind of thing are offered as one capability', () => {
    const world = scratch();
    try {
        procedureStore.save(member('post-read', 'read',
            [{ action: 'navigate', url: 'https://mail.example/in' }]));
        procedureStore.save(member('post-send', 'send',
            [{ action: 'fill', name: 'Body', slot: 'words' }],
            { words: { type: 'string', required: true, description: 'what to say' } }));

        capabilityGraph.reset();
        const family = capabilityGraph.get('procedure.post');

        assert.ok(family, 'the family is in the graph');
        assert.ok('action' in family.inputs, 'and the choice between them is an argument');
        assert.match(family.description, /action "read"/);
        assert.match(family.description, /action "send"/);

        assert.ok(capabilityGraph.get('procedure.post-read'), 'members are still addressable');
        assert.strictEqual(capabilityGraph.get('procedure.post-read').family, 'post');
    } finally { capabilityGraph.reset(); world.cleanup(); }
});

test('a lone recipe is not folded into a family of one', () => {
    const world = scratch();
    try {
        procedureStore.save(member('post-read', 'read',
            [{ action: 'navigate', url: 'https://mail.example/in' }]));

        capabilityGraph.reset();
        assert.strictEqual(capabilityGraph.get('procedure.post'), null,
            'one member is not a choice, so there is nothing to choose between');
    } finally { capabilityGraph.reset(); world.cleanup(); }
});

test('what a step does is read from the action it was given, not the family', () => {
    const world = scratch();
    try {
        procedureStore.save(member('post-read', 'read',
            [{ action: 'navigate', url: 'https://mail.example/in' }]));
        procedureStore.save(member('post-send', 'send',
            [{ action: 'fill', name: 'Body', slot: 'words' }],
            { words: { type: 'string', required: true, description: 'what to say' } }));

        capabilityGraph.reset();
        const family = capabilityGraph.get('procedure.post');

        assert.ok(family.effects.includes(capabilityGraph.EFFECT.WEB_WRITE));
        assert.deepStrictEqual(
            capabilityGraph.effectsFor(family, { action: 'read' }),
            [capabilityGraph.EFFECT.NETWORK]);
        assert.ok(capabilityGraph.effectsFor(family, { action: 'send' })
            .includes(capabilityGraph.EFFECT.WEB_WRITE));
    } finally { capabilityGraph.reset(); world.cleanup(); }
});

test('typing into a page is doing something; clicking through to it is not', () => {
    assert.deepStrictEqual(
        capabilityGraph.procedureEffects({ steps: [{ action: 'navigate', url: 'u' }] }),
        [capabilityGraph.EFFECT.NETWORK]);

    assert.ok(capabilityGraph
        .procedureEffects({ steps: [{ action: 'fill', name: 'Body', slot: 'w' }] })
        .includes(capabilityGraph.EFFECT.WEB_WRITE));
});

test('a name is not a correspondent', async () => {
    const world = scratch();
    try {
        const recipe = procedureStore.save({
            ...FAMILY_BASE, name: 'post-send', action: 'send',
            description: 'send something',
            parameters: {
                person: { type: 'string', required: true, format: 'email', description: 'who' }
            },
            steps: [{ action: 'fill', name: 'To', slot: 'person' }]
        });

        await assert.rejects(
            () => procedureRunner.replay(recipe, { person: 'Sandhya' }, { label: USER, trace: false }),
            err => err.notApplicable && /full email address/.test(err.message));
    } finally { world.cleanup(); }
});

test('an address the user never said is refused even though it is well formed', async () => {
    const world = scratch();
    try {
        const recipe = procedureStore.save({
            ...FAMILY_BASE, name: 'post-send', action: 'send',
            description: 'send something',
            parameters: {
                person: { type: 'string', required: true, format: 'email', description: 'who' }
            },
            steps: [{ action: 'fill', name: 'To', slot: 'person' }]
        });

        await assert.rejects(
            () => procedureRunner.replay(recipe, { person: 'sandhya@example.com' }, {
                label: USER, trace: false,
                request: 'draft a reply to Sandhya saying "Sounds good to me"'
            }),
            err => err.notApplicable && /made up/.test(err.message));

        const allowed = await procedureRunner.replay(recipe, { person: 'sandhya@example.com' }, {
            label: USER, trace: false,
            request: 'reply to sandhya@example.com saying hello'
        }).catch(err => err);
        assert.ok(!(allowed instanceof Error) || !allowed.notApplicable,
            'an address the user named is not refused');
    } finally { world.cleanup(); }
});

test('refusing the arguments does not count against the recipe', async () => {
    const world = scratch();
    try {
        const recipe = procedureStore.save({
            ...FAMILY_BASE, name: 'post-send', action: 'send',
            description: 'send something',
            parameters: {
                person: { type: 'string', required: true, format: 'email', description: 'who' }
            },
            steps: [{ action: 'fill', name: 'To', slot: 'person' }]
        });

        await procedureRunner.replay(recipe, { person: 'Sandhya' }, { label: USER, trace: false })
            .catch(() => {});

        const after = procedureStore.get('post-send');
        assert.strictEqual(after.health.replays, 0);
        assert.strictEqual(after.health.consecutive_failures, 0);
    } finally { world.cleanup(); }
});

test('a format nothing knows how to check is not a constraint', () => {
    const result = procedureStore.validate({
        name: 'x', surface: 'a.example', start_url: 'https://a.example/', description: 'd',
        parameters: { who: { type: 'string', format: 'phone-number', description: 'who' } },
        steps: [{ action: 'navigate', url: 'https://a.example/' }]
    });
    assert.strictEqual(result.valid, false);
    assert.match(result.errors.join(' '), /not a format this can check/);
});

test('an action without a family, or a family member without an action, is rejected', () => {
    const base = {
        name: 'x', surface: 'a.example', start_url: 'https://a.example/', description: 'd',
        parameters: {}, steps: [{ action: 'navigate', url: 'https://a.example/' }]
    };
    assert.strictEqual(procedureStore.validate({ ...base, action: 'read' }).valid, false);
    assert.strictEqual(procedureStore.validate({ ...base, family: 'post' }).valid, false);
    assert.strictEqual(procedureStore.validate({ ...base, family: 'post', action: 'read' }).valid, true);
});

test('a recipe that declines hands the request back to the loop', async () => {
    const world = scratch();
    try {
        procedureStore.save({
            ...FAMILY_BASE, name: 'post-read', action: 'read',
            description: 'read something',
            steps: [{ action: 'navigate', url: 'https://mail.example/in' }]
        });
        procedureStore.save({
            ...FAMILY_BASE, name: 'post-send', action: 'send',
            description: 'send something',
            parameters: {
                person: { type: 'string', required: true, format: 'email', description: 'who' }
            },
            steps: [{ action: 'fill', name: 'To', slot: 'person' }]
        });

        const asked = [];
        capabilityGraph.reset();
        capabilityGraph.register(capabilityGraph.define({
            id: 'web.browse',
            tier: capabilityGraph.TIER.PERCEPTION,
            description: 'stand-in for the loop',
            inputs: { goal: { type: 'string', required: true, description: 'what to do' } },
            outputs: { text: { type: 'string', description: 'what it found' } },
            effects: [capabilityGraph.EFFECT.NETWORK],
            produces: USER,
            async run(bound) { asked.push(bound.goal); return { text: 'the loop did it', passages: [] }; }
        }));

        const family = capabilityGraph.get('procedure.post');
        const result = await family.run(
            { action: 'send', person: 'sandhya@example.com' },
            { label: USER, request: 'draft a reply to Sandhya saying "Sounds good to me"' }
        );

        assert.strictEqual(result.text, 'the loop did it');
        assert.deepStrictEqual(asked, ['draft a reply to Sandhya saying "Sounds good to me"']);
    } finally { capabilityGraph.reset(); world.cleanup(); }
});

test('a request for a draft does not run the recipe that sends', async () => {
    const world = scratch();
    try {
        const sends = procedureStore.save({
            ...FAMILY_BASE, name: 'post-reply', action: 'reply',
            description: 'reply and send it',
            parameters: {
                person: { type: 'string', required: true, format: 'email', description: 'who' },
                words: { type: 'string', required: true, description: 'what to say' }
            },
            steps: [
                { action: 'fill', name: 'Message Body', slot: 'words' },
                { action: 'click', role: 'button', name: 'Send' }
            ]
        });

        await assert.rejects(
            () => procedureRunner.replay(sends, { person: 'sandhya@example.com', words: 'Sounds good' }, {
                label: USER, trace: false,
                request: 'draft a reply to sandhya@example.com saying "Sounds good"'
            }),
            err => err.notApplicable && /asked for a draft/.test(err.message));

        const allowed = await procedureRunner.replay(sends, { person: 'sandhya@example.com', words: 'Sounds good' }, {
            label: USER, trace: false,
            request: 'reply to sandhya@example.com saying "Sounds good"'
        }).catch(err => err);
        assert.ok(!(allowed instanceof Error) || !allowed.notApplicable);
    } finally { world.cleanup(); }
});

test('a recorded Reply is pressed when the user asked to reply, and not otherwise', async () => {
    const webPolicy = require('../security/webPolicy');
    const element = { name: 'Reply', role: 'button' };
    const home = 'mail.google.com';
    const shared = { element, label: USER, home, destination: 'https://mail.google.com' };

    assert.strictEqual(webPolicy.checkClick(shared).allowed, false);

    const asked = webPolicy.mandateFrom(
        'reply to sandhyapandey31@gmail.com saying "Hello, thank you for sending that over!"', USER);
    assert.ok(asked.has('compose') && asked.has('send'));
    assert.strictEqual(webPolicy.checkClick({ ...shared, mandate: asked }).allowed, true);

    const read = webPolicy.mandateFrom('what did Sandhya ask me about in her latest email?', USER);
    assert.strictEqual(webPolicy.checkClick({ ...shared, mandate: read }).allowed, false);

    assert.strictEqual(
        webPolicy.checkClick({ ...shared, mandate: asked, destination: 'https://github.com' }).allowed,
        false);
});

test('a keyboard shortcut in a control name is not part of what it is called', () => {
    const perception = require('../services/pagePerception');
    const observation = { url: 'https://mail.google.com', elements: [
        { role: 'button', name: 'Send ‪(⌘Enter)‬', ref: 'e1' },
        { role: 'button', name: 'More send options', ref: 'e2' },
        { role: 'link', name: 'Inbox (24)', ref: 'e3' },
        { role: 'button', name: 'Search all archived orders', ref: 'e4' }
    ]};

    assert.strictEqual(perception.find(observation, { role: 'button', name: 'Send' }).element.ref, 'e1');

    assert.strictEqual(
        perception.find(observation, { role: 'button', name: 'More send options' }).element.ref, 'e2');
    assert.strictEqual(perception.find(observation, { role: 'link', name: 'Inbox (24)' }).element.ref, 'e3');
    assert.strictEqual(perception.find(observation, { role: 'button', name: 'Search' }).element, null);
});


function retiredSearch({ family } = {}) {
    const procedure = procedureStore.save({
        name: 'bookshop-search',
        surface: 'books.example',
        start_url: 'https://books.example/search',
        description: 'Search the bookshop catalogue for a title.',
        goal_template: 'what does the bookshop say about {title}',
        ...(family ? { family: 'bookshop', action: 'search' } : {}),
        parameters: { title: { type: 'string', required: true, description: 'the title' } },
        steps: [
            { action: 'fill', role: 'textbox', name: 'Title or author', slot: 'title' },
            { action: 'click', role: 'button', name: 'Search' }
        ]
    });
    procedureStore.recordReplay('bookshop-search', { ok: false, error: 'element gone' });
    procedureStore.recordReplay('bookshop-search', { ok: false, error: 'element gone' });
    assert.strictEqual(procedureStore.isOffered(procedureStore.get('bookshop-search')), false,
        'the recipe must start this test retired');
    return procedure;
}

test('the same steps proving out again revive a retired recipe', () => {
    const world = scratch();
    try {
        TWO_GOALS.forEach(searchRun);
        const first = distiller.distil({});
        assert.strictEqual(first.learned.length, 1);
        const name = first.learned[0].name;

        procedureStore.recordReplay(name, { ok: false, error: 'flaky network' });
        procedureStore.recordReplay(name, { ok: false, error: 'flaky network' });
        assert.strictEqual(procedureStore.isOffered(procedureStore.get(name)), false);

        const second = distiller.distil({});
        assert.strictEqual(second.learned.length, 0);
        assert.strictEqual(second.revived.length, 1);
        assert.strictEqual(second.revived[0].name, name);

        const back = procedureStore.get(name);
        assert.strictEqual(procedureStore.isOffered(back), true);
        assert.strictEqual(back.health.consecutive_failures, 0);
        assert.ok(back.relearned_at, 'revival must be stamped');
    } finally { world.cleanup(); }
});

test('a drifted site re-learns the recipe in place: same name, new steps', () => {
    const world = scratch();
    try {
        retiredSearch({ family: true });

        const drifted = ({ goal, typed }) => searchRun({
            goal, typed,
            steps: [
                { capability: 'web.fill', status: 'success',
                  inputs: { role: 'searchbox', name: 'Search books', ref: 'e1', text: typed } },
                { capability: 'web.click', status: 'success',
                  inputs: { role: 'button', name: 'Go', ref: 'e2' } },
                { capability: 'web.done', status: 'success', summary: 'found it' }
            ]
        });
        TWO_GOALS.forEach(drifted);

        const result = distiller.distil({});
        assert.strictEqual(result.learned.length, 1);

        const healed = result.learned[0];
        assert.strictEqual(healed.name, 'bookshop-search',
            'the capability keeps its name across the drift');
        assert.strictEqual(healed.family, 'bookshop');
        assert.strictEqual(healed.action, 'search');
        assert.strictEqual(healed.steps[0].name, 'Search books',
            'the steps are the new page, not the old one');
        assert.ok(healed.relearned_at);
        assert.strictEqual(procedureStore.isOffered(procedureStore.get('bookshop-search')), true);
    } finally { world.cleanup(); }
});

test('a stale replay hands the goal to the slow path mid-request', async () => {
    const world = scratch();
    const realReplay = procedureRunner.replay;
    const realBrowse = webAgent.browse;
    try {
        const procedure = retiredSearch();

        procedureRunner.replay = async () => ({
            status: 'stale', reason: 'the page has no "Title or author" any more'
        });
        let browsedFor = null;
        webAgent.browse = async goal => {
            browsedFor = goal;
            return { status: 'success', answer: 'It is in stock.', passages: [],
                     url: 'https://books.example/results', files: [] };
        };

        const capability = capabilityGraph.fromProcedure(procedure);
        const out = await capability.run({ title: 'The Long Field' }, {
            request: 'what does the bookshop say about The Long Field'
        });

        assert.strictEqual(out.text, 'It is in stock.');
        assert.match(browsedFor, /The Long Field/);
    } finally {
        procedureRunner.replay = realReplay;
        webAgent.browse = realBrowse;
        world.cleanup();
    }
});

test('a policy refusal is not drift: it surfaces instead of being retried', async () => {
    const world = scratch();
    const realReplay = procedureRunner.replay;
    try {
        const procedure = retiredSearch();
        procedureRunner.replay = async () => ({
            status: 'blocked', reason: 'that control spends money, and nothing asked for it'
        });

        const capability = capabilityGraph.fromProcedure(procedure);
        await assert.rejects(
            () => capability.run({ title: 'x' }, { request: 'buy it' }),
            /spends money/);
    } finally {
        procedureRunner.replay = realReplay;
        world.cleanup();
    }
});

test('failures from before a re-learn do not block the rebuilt recipe', async () => {
    const world = scratch();
    const negativeMemory = require('../services/negativeMemory');
    try {
        retiredSearch();

        const plan = traceStore.beginPlan({ request: 'old world', status: 'running' });
        ['a1', 'a2'].forEach((key, ordinal) => traceStore.recordStep(plan, {
            ordinal, key, capability: 'procedure.bookshop-search', tier: 1,
            status: 'failed', error: 'element gone'
        }));
        traceStore.finishPlan(plan, { status: 'failed', runMs: 100 });

        assert.strictEqual(negativeMemory.isBlocked('procedure.bookshop-search'), true,
            'two dead runs block the recipe');

        await new Promise(beat => setTimeout(beat, 15));
        procedureStore.revive('bookshop-search');

        assert.strictEqual(negativeMemory.isBlocked('procedure.bookshop-search'), false,
            'the record starts over at the re-learn');
    } finally { world.cleanup(); }
});
