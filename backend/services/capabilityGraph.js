const path = require('path');

const skillRegistry = require('./skillRegistry');
const labels = require('../security/labels');
const { ORIGIN, SENSITIVITY } = labels;

const TIER = {
    PROGRAMMATIC: 0,
    RECIPE: 1,
    PERCEPTION: 2,
    PIXELS: 3
};

const EFFECT = {
    FILESYSTEM_WRITE: 'filesystem.write',
    NETWORK: 'network',
    PROCESS: 'process',
    SETTING: 'setting',
    MESSAGE: 'message',
    WEB_WRITE: 'web.write'
};

const ACCOMPLISHING = new Set([
    EFFECT.FILESYSTEM_WRITE,
    EFFECT.PROCESS,
    EFFECT.SETTING,
    EFFECT.MESSAGE,
    EFFECT.WEB_WRITE
]);


function define(spec) {
    const errors = [];

    if (!spec.id) errors.push('missing "id"');
    if (!spec.description) errors.push('missing "description" — the planner reads it');
    if (typeof spec.run !== 'function') errors.push('missing "run"');
    if (spec.tier === undefined) errors.push('missing "tier"');
    if (!spec.produces) errors.push('missing "produces" — the label its output carries');

    const inputs = spec.inputs || {};
    for (const [name, io] of Object.entries(inputs)) {
        if (!io || !io.type) errors.push(`inputs.${name}: missing "type"`);
    }

    const outputs = spec.outputs || {};
    if (!Object.keys(outputs).length) {
        errors.push('missing "outputs" — a step with no named output cannot be referenced');
    }

    if (errors.length) {
        throw new Error(`capability "${spec.id || '(unnamed)'}" is invalid: ${errors.join('; ')}`);
    }

    return Object.freeze({
        id: spec.id,
        kind: spec.kind || 'builtin',
        tier: spec.tier,
        description: spec.description,
        inputs,
        outputs,
        effects: Object.freeze([...(spec.effects || [])]),
        produces: spec.produces,
        consent: spec.consent || null,
        disclosurePolicy: spec.disclosurePolicy || null,
        run: spec.run,
        dispatch: spec.dispatch || null,
        source: spec.source || null,
        family: spec.family || null,
        surfaces: Object.freeze([...(spec.surfaces || [])])
    });
}


function skillOutputLabel(skill) {
    const declared = skill.capabilities || {};

    if (declared.network) return labels.label(ORIGIN.WEB, SENSITIVITY.PERSONAL);
    if (declared.filesystem === undefined || (declared.filesystem || []).length) {
        return labels.label(ORIGIN.FILE, SENSITIVITY.PERSONAL);
    }
    return labels.label(ORIGIN.GENERATED, SENSITIVITY.PUBLIC);
}

function skillEffects(skill) {
    const declared = skill.capabilities || {};
    const effects = [];

    if ((declared.filesystem || []).length) effects.push(EFFECT.FILESYSTEM_WRITE);
    if (declared.network) effects.push(EFFECT.NETWORK);
    if (declared.exec) effects.push(EFFECT.PROCESS);

    return effects;
}

function fromSkill(skill, execute) {
    const inputs = {};
    for (const [name, spec] of Object.entries(skill.parameters || {})) {
        inputs[name] = {
            type: spec.type === 'enum' ? `enum(${(spec.values || []).join('|')})` : spec.type,
            required: !!spec.required,
            description: spec.description || ''
        };
    }

    return define({
        id: `skill.${skill.name}`,
        kind: 'skill',
        tier: TIER.RECIPE,
        description: skill.description,
        inputs,
        outputs: { text: { type: 'string', description: 'what the skill reported' } },
        effects: skillEffects(skill),
        produces: skillOutputLabel(skill),
        source: skill.name,
        async run(bound) {
            const result = await execute(skill, bound);
            if (result.status === 'needs_approval' && result.proposal) {
                const held = new Error(result.response);
                held.proposal = result.proposal;
                throw held;
            }
            if (result.status !== 'success') {
                throw new Error(result.response || `${skill.name} failed`);
            }
            return { text: result.response };
        }
    });
}

function procedureEffects(procedure) {
    const steps = procedure.steps || [];
    const effects = [EFFECT.NETWORK];
    if (steps.some(step => step.action === 'fill')) effects.push(EFFECT.WEB_WRITE);
    return effects;
}

async function descend(procedure, bound, context, why) {
    console.warn(`[Procedures] ${procedure.name} declined: ${why.message}. Browsing instead.`);

    const browse = ensureBuilt().get('web.browse');
    if (!browse) throw why;

    // A declined mail recipe must not hand browsing its own start page: the
    // recipe belongs to the site it was learned on, while the browse goes to
    // whatever mailbox the request steers to.
    const mailProvider = require('./mailProvider');
    const url = mailProvider.MAIL_HOSTS.has(procedure.surface)
        ? mailProvider.forRequest(context.request || '',
            require('../utils/configReader').readConfig()).url
        : procedure.start_url;

    const goal = context.request || require('./procedureRunner').renderGoal(procedure, bound);
    const result = await browse.run({ goal, url }, context);

    return { passages: result.passages, url: result.url, title: null, text: result.text };
}

function fromProcedure(procedure) {
    const inputs = {};
    for (const [name, spec] of Object.entries(procedure.parameters || {})) {
        inputs[name] = {
            type: spec.type || 'string',
            required: !!spec.required,
            description: spec.description || ''
        };
    }

    return define({
        id: `procedure.${procedure.name}`,
        kind: 'procedure',
        tier: TIER.RECIPE,
        description: procedure.description,
        inputs,
        outputs: {
            passages: { type: 'passage[]', description: 'the page it ended on, in citable chunks' },
            url: { type: 'string', description: 'where it ended up' },
            title: { type: 'string', description: 'the title of that page' }
        },
        effects: procedureEffects(procedure),
        produces: labels.label(ORIGIN.WEB, SENSITIVITY.PERSONAL),
        disclosurePolicy: (label, channel) =>
            require('../security/webPolicy').mayLeaveUnattended(label, channel),
        source: procedure.name,
        family: procedure.family || null,
        surfaces: procedure.surface ? [procedure.surface] : [],
        async run(bound, context = {}) {
            const procedureRunner = require('./procedureRunner');

            let result;
            try {
                result = await procedureRunner.replay(procedure, bound, {
                    label: context.label,
                    request: context.request || '',
                    given: context.step ? context.step.inputs : null,
                    parentPlanId: context.planId ?? null,
                    parentStep: context.step ? context.step.id : null,
                    signal: context.signal
                });
            } catch (err) {
                if (!err.notApplicable) throw err;
                return descend(procedure, bound, context, err);
            }

            if (result.status === 'aborted') {
                const stopped = new Error(result.reason || 'stopped by the user');
                stopped.aborted = true;
                throw stopped;
            }

            // Site drift is not the user's problem: a recipe whose page moved
            // underneath it hands the goal to the slow path mid-request, and
            // the successful slow runs are what re-learns the recipe. Only a
            // policy refusal surfaces — retrying a refusal is not a fallback.
            if (result.status === 'stale' || result.status === 'failed') {
                return descend(procedure, bound, context,
                    new Error(result.reason || `procedure ${result.status}`));
            }
            if (result.status !== 'success') {
                throw new Error(result.reason || `procedure ${result.status}`);
            }
            return { passages: result.passages, url: result.url, title: result.title };
        }
    });
}

function fromFamily(family, procedures) {
    const members = new Map(procedures.map(p => [String(p.action), fromProcedure(p)]));
    const actions = [...members.keys()].sort();

    const inputs = {
        action: {
            type: 'string',
            required: true,
            description: `which one of: ${actions.join(', ')}`
        }
    };
    for (const procedure of procedures) {
        for (const [name, spec] of Object.entries(procedure.parameters || {})) {
            if (inputs[name]) continue;
            inputs[name] = {
                type: spec.type || 'string',
                required: false,
                description: spec.description || ''
            };
        }
    }

    const lines = actions.map(action => `  action "${action}": ${members.get(action).description}`);
    const description = [`${FAMILY_LEAD[family] || `Act on ${family}.`} Choose with "action":`, ...lines].join('\n');

    const first = members.get(actions[0]);

    const effects = [...new Set(procedures.flatMap(p => procedureEffects(p)))];

    const chosen = (bound = {}) => members.get(String(bound.action || '').trim().toLowerCase()) || null;

    return define({
        id: `procedure.${family}`,
        kind: 'procedure',
        tier: TIER.RECIPE,
        description,
        inputs,
        outputs: first.outputs,
        effects,
        produces: first.produces,
        disclosurePolicy: first.disclosurePolicy,
        source: family,
        surfaces: [...new Set(procedures.map(p => p.surface).filter(Boolean))],
        dispatch: chosen,
        async run(bound, context = {}) {
            const member = chosen(bound);
            if (!member) {
                const asked = String((bound || {}).action || '') || '(none)';
                const why = new Error(`"${asked}" is not one of: ${actions.join(', ')}`);
                return descend(procedures[0], bound, context, why);
            }
            const { action, ...args } = bound || {};
            return member.run(args, context);
        }
    });
}

function effectsFor(capability, inputs = {}) {
    if (!capability) return [];
    const member = capability.dispatch ? capability.dispatch(inputs) : null;
    return member ? member.effects : capability.effects;
}

const FAMILY_LEAD = {
    mail: "Act on the user's own email. The actions that name a person need their "
        + "FULL EMAIL ADDRESS; if the request only gives a name, use web.browse instead. "
        + "Whether someone has REPLIED or written back is also not one of these — that is "
        + "a comparison of what they sent against what the user sent, and web.browse does it."
};


function signedInSuffix() {
    let sites = [];
    try {
        sites = require('../security/store').grantedSites();
    } catch {
        return '';
    }
    if (!sites.length) return '';

    const listed = sites
        .map(site => `https://${site.host}${site.label ? ` (${site.label})` : ''}`)
        .join(', ');

    return ` The user is already signed in, in their own browser, to: ${listed} —`
        + ` their account on those sites can be reached by starting there.`;
}

function builtins() {
    const fileIndex = require('./fileIndex');
    const corpusIndexer = require('./corpusIndexer');
    const securityStore = require('../security/store');
    const answerService = require('./answerService');

    return [
        define({
            id: 'files.search',
            tier: TIER.PROGRAMMATIC,
            description:
                'Find files anywhere on this Mac by name, extension, folder or modification ' +
                'date. Returns paths and metadata only — it never opens a file. Use this ' +
                'first whenever a request refers to a file without giving its full path.',
            inputs: {
                text: { type: 'string', required: false, description: 'words from the filename' },
                ext: { type: 'string', required: false, description: 'extension, e.g. pdf' },
                dir: { type: 'path', required: false, description: 'full path of a folder to restrict to' },
                limit: { type: 'number', required: false, description: 'how many to return' }
            },
            outputs: {
                files: { type: 'file[]', description: 'matching files, best first' },
                paths: { type: 'string[]', description: 'just their paths' },
                best: {
                    type: 'path',
                    description: 'the single strongest match — wire THIS into a later step '
                        + 'when the user means one particular file ("the PDF", "my report")'
                }
            },
            produces: labels.label(ORIGIN.FILE, SENSITIVITY.PERSONAL),
            run(bound) {
                const files = fileIndex.search({
                    text: bound.text,
                    ext: bound.ext,
                    dir: bound.dir ? corpusIndexer.expandHome(bound.dir) : undefined,
                    limit: Math.min(Number(bound.limit) || 20, 50)
                });
                return {
                    files,
                    paths: files.map(f => f.path),
                    best: files.length ? files[0].path : null
                };
            }
        }),

        define({
            id: 'files.read',
            tier: TIER.PROGRAMMATIC,
            description:
                'Read the text of specific files that files.search has already located, ' +
                'returning them as passages. Only works inside folders the user has granted, ' +
                'and never opens credentials.',
            inputs: {
                paths: { type: 'path[]', required: true, description: 'full file paths to open' }
            },
            outputs: {
                passages: { type: 'passage[]', description: 'the text, in citable chunks' }
            },
            consent: 'documents',
            produces: labels.label(ORIGIN.FILE, SENSITIVITY.PERSONAL),
            run(bound) {
                const requested = Array.isArray(bound.paths) ? bound.paths : [bound.paths];
                const passages = [];

                for (const target of requested.slice(0, MAX_READ_FILES)) {
                    const file = String(target || '');
                    if (!file) continue;

                    if (!securityStore.isWithinGrantedRoot(file, 'documents')) {
                        passages.push({
                            text: '',
                            cite: path.basename(file),
                            refused: 'not inside a granted folder'
                        });
                        continue;
                    }

                    for (const record of corpusIndexer.recordsForFile(file)) {
                        passages.push({
                            text: record.meta.text,
                            cite: `file: ${path.basename(file)}`,
                            label: record.meta.label
                                ? labels.deserialise(record.meta.label)
                                : labels.UNKNOWN
                        });
                    }
                }

                return { passages: passages.filter(p => p.text || p.refused) };
            }
        }),

        define({
            id: 'files.deliver',
            tier: TIER.PROGRAMMATIC,
            description:
                'Hand specific files to the user as downloadable attachments on whatever ' +
                'surface they are speaking from — the phone app, the chat, anywhere. This ' +
                'IS how a file gets sent, shared or given to the user: pair it with ' +
                'files.search when they say "send me", "share" or "give me" a file.',
            inputs: {
                paths: {
                    type: 'path[]', required: true,
                    description: 'full paths to hand over — for "send me the X" wire '
                        + 'files.search\'s "best" here, not every match it found'
                }
            },
            outputs: {
                delivered: { type: 'file[]', description: 'the files now attached to the reply' },
                message: { type: 'string', description: 'a line naming what went across' }
            },
            consent: 'documents',
            produces: labels.label(ORIGIN.FILE, SENSITIVITY.PERSONAL),
            run(bound) {
                const fs = require('fs');
                const requested = (Array.isArray(bound.paths) ? bound.paths : [bound.paths])
                    .map(p => String(p || '')).filter(Boolean).slice(0, 3);
                const delivered = [];
                const skipped = [];
                for (const target of requested) {
                    const full = corpusIndexer.expandHome(target);
                    if (!securityStore.isWithinGrantedRoot(full, 'documents')) {
                        skipped.push(`${path.basename(full)} (not inside a granted folder)`);
                        continue;
                    }
                    let stat;
                    try { stat = fs.statSync(full); } catch { stat = null; }
                    if (!stat || !stat.isFile()) {
                        skipped.push(`${path.basename(full)} (no such file)`);
                        continue;
                    }
                    delivered.push({ name: path.basename(full), path: full });
                }
                const message = delivered.length
                    ? `Attached ${delivered.map(f => f.name).join(', ')}.`
                    : `Nothing could be attached${skipped.length ? `: ${skipped.join('; ')}` : '.'}`;
                return { delivered, message };
            }
        }),

        define({
            id: 'web.read',
            tier: TIER.PERCEPTION,
            description:
                'Open one web page and read it, returning its text as passages. Use this ' +
                'only when the named page IS where the answer lives — a URL the user gave, ' +
                'or a page needing no finding. Naming a site is not naming the page: a ' +
                'price, a rate, an opening time or any fact that lives somewhere ON a site ' +
                'has to be found first, and finding is web.browse. It reads only the page ' +
                'given; it does not follow links or search.',
            inputs: {
                url: { type: 'url', required: true, description: 'full https:// address' }
            },
            outputs: {
                passages: { type: 'passage[]', description: 'the page text, in citable chunks' },
                title: { type: 'string', description: 'the page title' }
            },
            effects: [EFFECT.NETWORK],
            produces: labels.label(ORIGIN.WEB, SENSITIVITY.PERSONAL),
            disclosurePolicy: (label, channel) =>
                require('../security/webPolicy').mayLeaveUnattended(label, channel),
            async run(bound, context = {}) {
                const browser = require('./browser');
                const perception = require('./pagePerception');
                const webPolicy = require('../security/webPolicy');

                const verdict = webPolicy.checkNavigation({
                    url: bound.url,
                    label: context.label || labels.UNKNOWN
                });
                if (!verdict.allowed) throw new Error(verdict.reason);

                const page = await browser.current();
                const landed = await browser.goto(verdict.url);
                const observation = await perception.observe(page);

                return {
                    passages: perception.passages(observation),
                    title: landed.title || observation.title
                };
            }
        }),

        define({
            id: 'web.browse',
            tier: TIER.PERCEPTION,
            description:
                'Pursue a goal on a website by looking at pages and acting on them — ' +
                'following links, filling search boxes, pressing buttons — until the goal ' +
                'is met. Use this when the answer needs more than one page, or needs a ' +
                'search or a form. It never fills password or payment fields.' +
                signedInSuffix(),
            inputs: {
                goal: { type: 'string', required: true, description: 'what to achieve, in one sentence' },
                url: { type: 'url', required: false, description: 'where to start' }
            },
            outputs: {
                text: { type: 'string', description: 'what it found' },
                passages: { type: 'passage[]', description: 'the final page, in citable chunks' },
                url: { type: 'string', description: 'where it ended up' },
                files: { type: 'file[]', description: 'files it was asked to save, now on disk' }
            },
            effects: [EFFECT.NETWORK],
            produces: labels.label(ORIGIN.WEB, SENSITIVITY.PERSONAL),
            disclosurePolicy: (label, channel) =>
                require('../security/webPolicy').mayLeaveUnattended(label, channel),
            async run(bound, context = {}) {
                const webAgent = require('./webAgent');

                const result = await webAgent.browse(String(bound.goal), {
                    url: bound.url || undefined,
                    label: context.label,
                    request: context.request || '',
                    parentPlanId: context.planId ?? null,
                    parentStep: context.step ? context.step.id : null,
                    signal: context.signal
                });

                if (result.status === 'success') {
                    return { text: result.answer, passages: result.passages, url: result.url,
                             files: result.files || [] };
                }
                if (result.status === 'aborted') {
                    const stopped = new Error(result.reason || 'stopped by the user');
                    stopped.aborted = true;
                    throw stopped;
                }
                // A browse that stopped to offer a card is not a failure —
                // the card rides up so the executor can hold the plan on it.
                if (result.status === 'needs_approval' && result.proposal) {
                    const held = new Error(result.reason || 'this needs your approval first');
                    held.proposal = result.proposal;
                    throw held;
                }
                throw new Error(result.reason || `browsing ${result.status}`);
            }
        }),

        define({
            id: 'answer',
            tier: TIER.RECIPE,
            description:
                'Answer a question in words. Given passages it answers strictly from them ' +
                'and cites them; given none it retrieves what it can itself. This is how a ' +
                'plan turns gathered material into something the user can read.',
            inputs: {
                question: { type: 'string', required: true, description: 'what to answer' },
                passages: { type: 'passage[]', required: false, description: 'material to answer from' }
            },
            outputs: {
                text: { type: 'string', description: 'the answer' },
                grounded: { type: 'boolean', description: 'whether it rests on retrieved material' }
            },
            produces: labels.label(ORIGIN.GENERATED, SENSITIVITY.PUBLIC),
            async run(bound) {
                const result = await answerService.answer(String(bound.question), {
                    passages: bound.passages
                });
                if (!result.is_successful) throw new Error(result.text);
                return {
                    text: result.text,
                    grounded: result.grounded,
                    refused: result.refused,
                    sources: result.sources
                };
            }
        })
    ];
}

const MAX_READ_FILES = 5;


let graph = null;
let extra = new Map();

function build() {
    const skillExecutor = require('./skillExecutor');
    const procedureStore = require('./procedureStore');
    const loaded = new Map();

    for (const capability of builtins()) {
        loaded.set(capability.id, capability);
    }
    for (const skill of skillRegistry.list()) {
        const capability = fromSkill(skill, (s, p) => require('./skillCare').run(s, p));
        loaded.set(capability.id, capability);
    }
    const families = new Map();
    for (const procedure of procedureStore.list()) {
        const capability = fromProcedure(procedure);
        loaded.set(capability.id, capability);
        if (!procedure.family) continue;
        if (!families.has(procedure.family)) families.set(procedure.family, []);
        families.get(procedure.family).push(procedure);
    }
    for (const [family, members] of families) {
        if (members.length < 2) continue;
        const capability = fromFamily(family, members);
        loaded.set(capability.id, capability);
    }
    for (const [id, capability] of extra) {
        loaded.set(id, capability);
    }

    graph = loaded;
    return loaded;
}

function ensureBuilt() {
    if (graph === null) build();
    return graph;
}

function list() {
    return Array.from(ensureBuilt().values());
}

function get(id) {
    return ensureBuilt().get(resolveId(id)) || null;
}

function has(id) {
    return resolveId(id) !== null;
}

function resolveId(id) {
    if (!id || typeof id !== 'string') return null;

    const catalogue = ensureBuilt();
    if (catalogue.has(id)) return id;
    if (catalogue.has(`skill.${id}`)) return `skill.${id}`;

    const normalise = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const target = normalise(id);
    if (!target) return null;

    for (const capability of catalogue.values()) {
        if (normalise(capability.id) === target) return capability.id;
        if (capability.kind === 'skill' && normalise(capability.source) === target) {
            return capability.id;
        }
    }
    return null;
}

function describe(capabilities = list()) {
    return capabilities.map(capability => {
        const inputs = Object.entries(capability.inputs)
            .map(([name, io]) => `${name}:${io.type}${io.required ? '!' : ''}`)
            .join(', ');
        const outputs = Object.keys(capability.outputs).join(', ');

        const description = String(capability.description)
            .split('\n')
            .map(line => `    ${line}`)
            .join('\n');

        return `- ${capability.id}(${inputs}) -> {${outputs}}\n${description}`;
    }).join('\n');
}

function register(spec) {
    const capability = spec.id && spec.run ? define(spec) : spec;
    extra.set(capability.id, capability);
    if (graph) graph.set(capability.id, capability);
    return capability;
}

function reset() {
    extra = new Map();
    graph = null;
}

function reload() {
    graph = null;
    return list();
}

module.exports = {
    TIER, EFFECT, ACCOMPLISHING,
    define, list, get, has, resolveId, describe, register, reset, reload, build, effectsFor,
    fromSkill, fromProcedure, fromFamily, procedureEffects, skillOutputLabel, skillEffects
};
