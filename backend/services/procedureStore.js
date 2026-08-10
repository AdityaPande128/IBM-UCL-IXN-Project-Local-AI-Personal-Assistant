const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, '..', 'data', 'procedures');

const RETIRE_AFTER_CONSECUTIVE_FAILURES = 2;

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const SLOT = /\{([a-z0-9_]+)\}/gi;

function slotsIn(url) {
    return [...String(url || '').matchAll(SLOT)].map(found => found[1]);
}

function fillSlots(url, args = {}) {
    return String(url || '').replace(SLOT, (whole, name) =>
        (args && args[name] !== undefined && args[name] !== null ? String(args[name]) : whole));
}

let directory = DEFAULT_DIR;
let cache = null;

function open(target = DEFAULT_DIR) {
    if (target !== directory) cache = null;
    directory = target;
    return directory;
}

function fileFor(name) {
    return path.join(directory, `${name}.json`);
}


const ACTIONS = new Set(['click', 'fill', 'navigate', 'back']);

const FORMATS = new Set(['email']);

function validate(procedure) {
    const errors = [];

    if (!procedure || typeof procedure !== 'object') return { valid: false, errors: ['not an object'] };
    if (!procedure.name) errors.push('missing "name"');
    else if (!NAME.test(procedure.name)) errors.push(`"name" must be kebab-case (got "${procedure.name}")`);

    if (!procedure.surface) errors.push('missing "surface" — a procedure is only valid on the site it was learned on');
    if (!procedure.start_url) errors.push('missing "start_url"');
    if (!procedure.description) errors.push('missing "description" — the planner reads it');

    if (procedure.family !== undefined) {
        if (!NAME.test(String(procedure.family || ''))) {
            errors.push(`"family" must be kebab-case (got "${procedure.family}")`);
        }
        if (!procedure.action) errors.push('a procedure in a family needs an "action" naming which one it is');
        else if (!NAME.test(String(procedure.action))) {
            errors.push(`"action" must be kebab-case (got "${procedure.action}")`);
        }
    } else if (procedure.action !== undefined) {
        errors.push('"action" means nothing without a "family"');
    }

    const parameters = procedure.parameters || {};
    if (typeof parameters !== 'object' || Array.isArray(parameters)) {
        errors.push('"parameters" must be a mapping');
    } else {
        for (const [name, spec] of Object.entries(parameters)) {
            if (spec && spec.format && !FORMATS.has(spec.format)) {
                errors.push(`parameters.${name}: "${spec.format}" is not a format this can check`);
            }
        }
    }

    const steps = procedure.steps;
    if (!Array.isArray(steps) || !steps.length) {
        errors.push('"steps" must be a non-empty array');
    } else {
        steps.forEach((step, index) => {
            const where = `steps[${index}]`;
            if (!ACTIONS.has(step.action)) {
                errors.push(`${where}: "${step.action}" is not a replayable action`);
                return;
            }
            if (step.action === 'navigate') {
                if (!step.url) errors.push(`${where}: navigate needs a "url"`);

                for (const slot of slotsIn(step.url)) {
                    if (!parameters[slot]) {
                        errors.push(`${where}: "{${slot}}" in the url is not a declared parameter`);
                    }
                }
            }
            if (step.action === 'click' && !step.name && !step.first) {
                errors.push(`${where}: click needs the element's name, or "first"`);
            }
            if (step.first && step.first !== 'row') {
                errors.push(`${where}: "first" is only understood as "row"`);
            }
            if (step.action === 'fill') {
                if (!step.name) errors.push(`${where}: fill needs the element's name`);
                const literal = typeof step.text === 'string';
                const slot = typeof step.slot === 'string';
                if (literal === slot) errors.push(`${where}: fill needs either "text" or "slot", not both or neither`);
                if (slot && !parameters[step.slot]) {
                    errors.push(`${where}: slot "${step.slot}" is not a declared parameter`);
                }
            }
        });
    }

    return { valid: errors.length === 0, errors };
}


function freshHealth() {
    return {
        replays: 0,
        successes: 0,
        failures: 0,
        consecutive_failures: 0,
        last_error: null,
        last_used: null
    };
}

function isOffered(procedure) {
    const health = procedure.health || freshHealth();
    return health.consecutive_failures < RETIRE_AFTER_CONSECUTIVE_FAILURES;
}


function load() {
    const loaded = new Map();

    let entries = [];
    try {
        entries = fs.readdirSync(directory).filter(name => name.endsWith('.json'));
    } catch {
        cache = loaded;
        return loaded;
    }

    for (const entry of entries) {
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(path.join(directory, entry), 'utf8'));
        } catch (err) {
            console.warn(`[Procedures] Could not read ${entry}: ${err.message}`);
            continue;
        }

        const { valid, errors } = validate(parsed);
        if (!valid) {
            console.warn(`[Procedures] REJECTED ${entry}: ${errors.join('; ')}`);
            continue;
        }
        parsed.health = { ...freshHealth(), ...(parsed.health || {}) };
        loaded.set(parsed.name, parsed);
    }

    cache = loaded;
    return loaded;
}

function ensureLoaded() {
    if (cache === null) load();
    return cache;
}

function save(procedure) {
    const { valid, errors } = validate(procedure);
    if (!valid) {
        throw new Error(`procedure "${procedure && procedure.name}" is invalid: ${errors.join('; ')}`);
    }

    const record = { health: freshHealth(), ...procedure };
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(fileFor(record.name), `${JSON.stringify(record, null, 2)}\n`, 'utf8');

    ensureLoaded().set(record.name, record);
    return record;
}

// Fresh evidence that the same steps still work: the failures were noise,
// not drift, and the recipe is offered again with a clean slate.
function revive(name) {
    const procedure = get(name);
    if (!procedure) return null;

    procedure.health = freshHealth();
    procedure.relearned_at = new Date().toISOString();
    try {
        fs.writeFileSync(fileFor(name), `${JSON.stringify(procedure, null, 2)}\n`, 'utf8');
    } catch (err) {
        console.warn(`[Procedures] Could not revive ${name}: ${err.message}`);
    }
    return procedure;
}

// Re-learning keeps the name: the capability id, the family and the place in
// plans all survive the site having moved underneath the old steps. The old
// shape is remembered, so traces from before the drift cannot re-distil the
// dead steps as though they were a new discovery.
function replace(name, next, { supersededSignature = null } = {}) {
    const old = get(name);
    if (!old) return save(next);

    const record = { ...next, name, health: freshHealth(),
                     relearned_at: new Date().toISOString() };
    if (record.family === undefined && old.family !== undefined) {
        record.family = old.family;
        record.action = old.action;
    }
    record.superseded_signatures = [
        ...(old.superseded_signatures || []),
        supersededSignature
    ].filter(Boolean);
    return save(record);
}

function recordReplay(name, { ok, error = null, ms = null } = {}) {
    const procedure = get(name);
    if (!procedure) return null;

    const health = { ...freshHealth(), ...(procedure.health || {}) };
    health.replays += 1;
    health.last_used = new Date().toISOString();
    health.last_ms = ms;

    if (ok) {
        health.successes += 1;
        health.consecutive_failures = 0;
        health.last_error = null;
    } else {
        health.failures += 1;
        health.consecutive_failures += 1;
        health.last_error = error;
    }

    procedure.health = health;
    try {
        fs.writeFileSync(fileFor(name), `${JSON.stringify(procedure, null, 2)}\n`, 'utf8');
    } catch (err) {
        console.warn(`[Procedures] Could not update ${name}: ${err.message}`);
    }
    return procedure;
}


function all() {
    return Array.from(ensureLoaded().values()).sort((a, b) => a.name.localeCompare(b.name));
}

function list() {
    return all().filter(isOffered);
}

function get(name) {
    return ensureLoaded().get(name) || null;
}

function has(name) {
    return ensureLoaded().has(name);
}

function remove(name) {
    ensureLoaded().delete(name);
    try { fs.unlinkSync(fileFor(name)); } catch {  }
}

function reload() {
    cache = null;
    return list();
}

module.exports = {
    open, load, reload, all, list, get, has, save, remove, recordReplay,
    revive, replace,
    validate, isOffered, freshHealth, slotsIn, fillSlots,
    DEFAULT_DIR, RETIRE_AFTER_CONSECUTIVE_FAILURES,
    get directory() { return directory; }
};
