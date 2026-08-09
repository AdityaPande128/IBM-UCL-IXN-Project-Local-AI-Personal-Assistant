const configReader = require('../utils/configReader');
const traceStore = require('./traceStore');
const procedureStore = require('./procedureStore');

const config = configReader.readConfig();
const distillConfig = config.distillation || {};

const MIN_RUNS = distillConfig.min_runs ?? 2;

const MIN_SHARED_WORDS = distillConfig.min_shared_words ?? 3;

const MAX_STEPS = distillConfig.max_steps ?? 8;

const REPLAYABLE = {
    'web.click': 'click',
    'web.fill': 'fill',
    'web.navigate': 'navigate',
    'web.back': 'back'
};

const STOPWORDS = new Set([
    'a', 'an', 'the', 'of', 'for', 'to', 'in', 'on', 'at', 'by', 'with', 'from',
    'your', 'my', 'me', 'is', 'are', 'was', 'and', 'or', 'it', 'this', 'that',
    'please', 'enter', 'type', 'search', 'find', 'what', 'does', 'do', 'say', 'says'
]);


function words(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter(Boolean);
}

function normalise(run) {
    const steps = run.steps || [];

    if (!steps.length) return { ok: false, why: 'no steps recorded' };

    const last = steps[steps.length - 1];
    if (last.capability !== 'web.done' || last.status !== 'success') {
        return { ok: false, why: 'the run did not end in a completed goal' };
    }

    if (steps.some(step => step.status === 'blocked')) {
        return { ok: false, why: 'an action in this run was refused' };
    }

    const actions = [];
    for (const step of steps) {
        const action = REPLAYABLE[step.capability];
        if (!action || step.status !== 'success') continue;

        const inputs = step.inputs || {};

        if (action === 'navigate') {
            if (!inputs.url) return { ok: false, why: 'a navigation was recorded without its URL' };
            actions.push({ action, url: inputs.url });
            continue;
        }
        if (action === 'back') {
            actions.push({ action });
            continue;
        }

        if (!inputs.name && !inputs.role) {
            return { ok: false, why: 'this run was traced before elements were recorded by name' };
        }

        const entry = { action, role: inputs.role || null, name: inputs.name || '' };

        if (action === 'fill') {
            if (typeof inputs.text !== 'string' || inputs.text === '(text)') {
                return { ok: false, why: 'a typed value was not the user\'s own and was not recorded' };
            }
            entry.text = inputs.text;
        }
        actions.push(entry);
    }

    if (!actions.length) return { ok: false, why: 'the goal was met without doing anything' };
    if (actions.length > MAX_STEPS) return { ok: false, why: `${actions.length} actions is too long to replay` };

    return { ok: true, actions };
}

function signature(actions) {
    return actions.map(entry => {
        if (entry.action === 'navigate') return `navigate:${entry.url}`;
        if (entry.action === 'back') return 'back';
        return `${entry.action}:${entry.role || ''}:${entry.name}`;
    }).join(' > ');
}


function align(goals) {
    const tokenised = goals.map(goal => String(goal || '').trim().split(/\s+/).filter(Boolean));
    const shortest = Math.min(...tokenised.map(t => t.length));

    const same = (index, from) => {
        const at = list => from === 'end' ? list[list.length - 1 - index] : list[index];
        const first = (at(tokenised[0]) || '').toLowerCase();
        return tokenised.every(list => (at(list) || '').toLowerCase() === first);
    };

    let prefix = 0;
    while (prefix < shortest && same(prefix, 'start')) prefix++;

    let suffix = 0;
    while (suffix < shortest - prefix && same(suffix, 'end')) suffix++;

    return {
        prefix: tokenised[0].slice(0, prefix),
        suffix: suffix ? tokenised[0].slice(tokenised[0].length - suffix) : [],
        middles: tokenised.map(list => list.slice(prefix, list.length - suffix)),
        shared: prefix + suffix
    };
}


function slug(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'x';
}

function slotName(fieldName, taken) {
    const candidates = words(fieldName).filter(word => !STOPWORDS.has(word));
    let base = candidates.length ? candidates[0] : 'value';
    if (!/^[a-z][a-z0-9_]*$/.test(base)) base = 'value';

    let name = base;
    let n = 2;
    while (taken.has(name)) name = `${base}${n++}`;
    taken.add(name);
    return name;
}

function procedureName(surface, template, taken) {
    const meaningful = words(template.replace(/\{[^}]*\}/g, ' '))
        .filter(word => !STOPWORDS.has(word))
        .slice(0, 3);

    const label = String(surface || '').split('.')
        .find(part => /^[a-z][a-z0-9-]*$/i.test(part) && part.toLowerCase() !== 'www');

    const base = slug([label, ...meaningful].filter(Boolean).join('-') || 'procedure');
    let name = base;
    let n = 2;
    while (taken.has(name)) name = `${base}-${n++}`;
    return name;
}


function induce(runs, { surface, startUrl, taken = new Set() }) {
    const template = align(runs.map(run => run.goal || run.request));

    if (template.shared < MIN_SHARED_WORDS) {
        return { ok: false, why: `the goals have only ${template.shared} word(s) in common` };
    }

    const actions = runs[0].actions;
    const parameters = {};
    const slots = new Set();
    const steps = [];
    let usedVariation = false;

    for (let index = 0; index < actions.length; index++) {
        const entry = actions[index];

        if (entry.action !== 'fill') {
            steps.push({ ...entry });
            continue;
        }

        const typed = runs.map(run => run.actions[index].text);
        const constant = typed.every(text => text === typed[0]);

        if (constant) {
            steps.push({ ...entry, text: typed[0] });
            continue;
        }

        const drawn = typed.every((text, run) => {
            const middle = new Set(words(template.middles[run].join(' ')));
            const typedWords = words(text);
            return typedWords.length > 0 && typedWords.every(word => middle.has(word));
        });

        if (!drawn) {
            return { ok: false, why: 'a typed value varied without varying with the request' };
        }

        const name = slotName(entry.name, slots);
        parameters[name] = {
            type: 'string',
            required: true,
            description: `what to type into "${entry.name}"`
        };
        steps.push({ action: 'fill', role: entry.role, name: entry.name, slot: name });
        usedVariation = true;
    }

    const varies = template.middles.some(middle => middle.length);
    if (varies && !usedVariation) {
        return { ok: false, why: 'the requests differ in a way the actions do not account for' };
    }

    const rendered = renderTemplate(template, steps);
    const name = procedureName(surface, rendered, taken);
    taken.add(name);

    const meanMs = Math.round(runs.reduce((total, run) => total + (run.run_ms || 0), 0) / runs.length);
    const modelCalls = Math.round(
        runs.reduce((total, run) => total + (run.steps || []).length, 0) / runs.length
    );

    return {
        ok: true,
        procedure: {
            name,
            surface,
            start_url: startUrl,
            goal_template: rendered,
            description:
                `${capitalise(rendered)} — on ${surface}. A procedure the system learned by ` +
                `doing this ${runs.length} times; it replays ${steps.length} recorded action(s) ` +
                'without a model. Use it in preference to web.browse for this site.',
            parameters,
            steps,
            learned: {
                at: new Date().toISOString(),
                from_plans: runs.map(run => run.id),
                runs: runs.length,
                tier2_mean_ms: meanMs,
                tier2_model_calls: modelCalls
            }
        }
    };
}

function renderTemplate(template, steps) {
    const slots = steps.filter(step => step.slot).map(step => `{${step.slot}}`);
    const middle = slots.length ? slots.join(' ') : '';
    return [...template.prefix, middle, ...template.suffix].filter(Boolean).join(' ');
}

function capitalise(text) {
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}


function distil({ limit = 200, surface = null, dryRun = false } = {}) {
    const runs = traceStore.procedures({ surface, limit });

    const groups = new Map();
    const skipped = [];

    for (const run of runs) {
        const reduced = normalise(run);
        if (!reduced.ok) {
            skipped.push({ plan: run.id, surface: run.surface, why: reduced.why });
            continue;
        }

        const startUrl = (run.detail && run.detail.start) || null;
        if (!startUrl) {
            skipped.push({ plan: run.id, surface: run.surface, why: 'no starting URL recorded' });
            continue;
        }

        const key = `${run.surface} ${startUrl} ${signature(reduced.actions)}`;
        if (!groups.has(key)) groups.set(key, { surface: run.surface, startUrl, runs: [] });
        groups.get(key).runs.push({ ...run, actions: reduced.actions });
    }

    const taken = new Set(procedureStore.all().map(procedure => procedure.name));
    const learned = [];

    for (const group of groups.values()) {
        if (group.runs.length < MIN_RUNS) {
            skipped.push({
                surface: group.surface,
                plans: group.runs.map(run => run.id),
                why: `seen ${group.runs.length} time(s); a parameter is not distinguishable ` +
                     `from a constant below ${MIN_RUNS}`
            });
            continue;
        }

        const result = induce(group.runs, { surface: group.surface, startUrl: group.startUrl, taken });
        if (!result.ok) {
            skipped.push({ surface: group.surface, plans: group.runs.map(run => run.id), why: result.why });
            continue;
        }

        const existing = procedureStore.all().find(procedure =>
            procedure.surface === group.surface
            && procedure.start_url === group.startUrl
            && signatureOf(procedure) === signature(group.runs[0].actions));

        if (existing) {
            skipped.push({
                surface: group.surface, plans: group.runs.map(run => run.id),
                why: `already known as "${existing.name}"`
            });
            continue;
        }

        learned.push(dryRun ? result.procedure : procedureStore.save(result.procedure));
    }

    return { learned, skipped, groups: groups.size, considered: runs.length };
}

function signatureOf(procedure) {
    return signature((procedure.steps || []).map(step => ({
        action: step.action, role: step.role, name: step.name, url: step.url
    })));
}

module.exports = {
    distil, normalise, signature, signatureOf, align, induce,
    slotName, procedureName,
    MIN_RUNS, MIN_SHARED_WORDS, MAX_STEPS
};
