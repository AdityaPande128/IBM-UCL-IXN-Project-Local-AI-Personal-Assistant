const browser = require('./browser');
const configReader = require('../utils/configReader');
const mailProvider = require('./mailProvider');
const perception = require('./pagePerception');
const procedureStore = require('./procedureStore');
const traceStore = require('./traceStore');
const webPolicy = require('../security/webPolicy');
const labels = require('../security/labels');
const securityStore = require('../security/store');

const RECIPE_TIER = 1;

const FORMATS = {
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/
};

function matchesFormat(value, format) {
    const pattern = FORMATS[format];
    return pattern ? pattern.test(value) : true;
}

function decline(message) {
    const err = new Error(message);
    err.notApplicable = true;
    return err;
}

const SAYS_DRAFT = /\b(draft|drafts|drafting|don'?t send|do not send|without sending|leave it unsent)\b/i;

function pressesSend(procedure) {
    return (procedure.steps || []).some(step =>
        step.action === 'click' && /^send$/i.test(String(step.name || '').trim()));
}

const REFERENCE = /^\$[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/i;


function match(observation, step) {
    return perception.find(observation, step);
}


async function replay(target, args = {}, options = {}) {
    const startedAt = Date.now();
    const procedure = typeof target === 'string' ? procedureStore.get(target) : target;

    if (!procedure) {
        throw new Error(`no procedure called "${target}"`);
    }

    const tracing = options.trace !== false;
    const label = options.label || labels.label(labels.ORIGIN.USER, labels.SENSITIVITY.PERSONAL);

    const missing = Object.entries(procedure.parameters || {})
        .filter(([name, spec]) => spec.required && !String(args[name] ?? '').trim())
        .map(([name]) => name);
    if (missing.length) {
        throw decline(`${procedure.name} needs ${missing.join(', ')}`);
    }

    const malformed = Object.entries(procedure.parameters || {})
        .filter(([name, spec]) => spec.format && String(args[name] ?? '').trim())
        .filter(([name, spec]) => !matchesFormat(String(args[name]).trim(), spec.format))
        .map(([name, spec]) => `${name} must be ${spec.format === 'email' ? 'a full email address' : spec.format}`);
    if (malformed.length) {
        throw decline(`${procedure.name}: ${malformed.join('; ')}`);
    }

    const invented = Object.entries(procedure.parameters || {})
        .filter(([name, spec]) => spec.format === 'email' && String(args[name] ?? '').trim())
        .filter(([name]) => {
            if (!options.request) return false;
            if (REFERENCE.test(String((options.given || {})[name] ?? ''))) return false;
            return !String(options.request).toLowerCase().includes(String(args[name]).trim().toLowerCase());
        })
        .map(([name]) => name);
    if (invented.length) {
        throw decline(`${procedure.name}: ${invented.join(', ')} is not in the request — it was made up`);
    }

    if (options.request && SAYS_DRAFT.test(options.request) && pressesSend(procedure)) {
        throw decline(`${procedure.name} sends, and the request asked for a draft`);
    }

    const config = configReader.readConfig();
    if (!mailProvider.surfaceApplies(procedure.surface, options.request || '', config)) {
        const chosen = mailProvider.forRequest(options.request || '', config);
        throw decline(`${procedure.name} was learned on ${procedure.surface}, `
            + `and this request's mail lives on ${chosen.label}`);
    }

    const mandate = webPolicy.mandateFrom(options.request || '', label);

    let planId = null;
    const performed = [];
    let observation = null;
    let status = 'success';
    let failure = null;

    const carriesSession = securityStore.isGrantedSite(procedure.start_url)
        && await browser.attachAvailable();
    options = { ...options, grantedOnly: options.grantedOnly ?? carriesSession };

    const opening = webPolicy.checkNavigation({
        url: procedure.start_url,
        label,
        allowPrivate: options.allowPrivate,
        grantedOnly: options.grantedOnly
    });
    if (!opening.allowed) {
        return finish({
            procedure, status: 'blocked', failure: opening.reason,
            performed, observation: null, planId, startedAt, tracing
        });
    }

    try {
        const page = await browser.current(
            carriesSession ? { mode: browser.MODE.ATTACHED } : {});
        const landed = await browser.goto(opening.url);

        const arrival = webPolicy.checkArrival(landed.url,
            { allowPrivate: options.allowPrivate, grantedOnly: options.grantedOnly });
        if (!arrival.allowed) {
            return finish({
                procedure, status: 'blocked', failure: arrival.reason,
                performed, observation: null, planId, startedAt, tracing
            });
        }

        observation = await perception.observe(page);

        if (tracing) {
            planId = traceStore.beginPlan({
                request: renderGoal(procedure, args),
                goal: renderGoal(procedure, args),
                status: 'running',
                parentPlanId: options.parentPlanId ?? null,
                parentStep: options.parentStep ?? null,
                surface: procedure.surface,
                detail: { procedure: procedure.name, start: procedure.start_url, tier: RECIPE_TIER }
            });
        }

        for (const [ordinal, step] of (procedure.steps || []).entries()) {
            if (options.signal && options.signal.aborted) {
                throw decline('stopped by the user');
            }
            const stepStartedAt = Date.now();
            browser.touch();
            const outcome = await perform(page, step, observation,
                { args, label, options, mandate, home: safeHost(procedure.start_url) });

            performed.push({ ...outcome, action: step.action, name: step.name || step.url || null });

            if (tracing && planId !== null) {
                traceStore.recordStep(planId, {
                    ordinal,
                    key: `r${ordinal + 1}`,
                    capability: `web.${step.action}`,
                    tier: RECIPE_TIER,
                    status: outcome.ok ? 'success' : (outcome.stale ? 'failed' : 'blocked'),
                    label,
                    inputs: { role: step.role, name: step.name, url: step.url, slot: step.slot },
                    summary: outcome.detail,
                    error: outcome.ok ? null : outcome.detail,
                    durationMs: Date.now() - stepStartedAt
                });
            }

            if (!outcome.ok) {
                status = outcome.stale ? 'stale' : 'blocked';
                failure = outcome.detail;
                break;
            }

            await browser.settle(page);
            observation = await perception.observe(page);
        }
    } catch (err) {
        status = 'failed';
        failure = err.message;
    }

    return finish({ procedure, status, failure, performed, observation, planId, startedAt, tracing });
}

async function perform(page, step, observation, { args, label, options, mandate, home }) {
    if (step.action === 'navigate') {
        const url = procedureStore.fillSlots(step.url, args);

        const verdict = webPolicy.checkNavigation({
            url, label, allowPrivate: options.allowPrivate,
            grantedOnly: options.grantedOnly,
            from: home
        });
        if (!verdict.allowed) return { ok: false, detail: verdict.reason };

        const landed = await browser.goto(verdict.url);
        const arrival = webPolicy.checkArrival(landed.url, { allowPrivate: options.allowPrivate });
        if (!arrival.allowed) return { ok: false, detail: arrival.reason };

        return { ok: true, detail: `navigated to ${url}` };
    }

    if (step.action === 'back') {
        await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
        return { ok: true, detail: `went back to ${page.url()}` };
    }

    const { topRow } = require('./webAgent');
    const { element, why } = step.first === 'row'
        ? { element: topRow(observation), why: 'no message rows on this page' }
        : match(observation, step);
    if (!element) return { ok: false, stale: true, detail: why };

    if (step.action === 'fill') {
        const text = step.slot ? String(args[step.slot] ?? '') : String(step.text ?? '');

        const verdict = webPolicy.checkFill({
            element, text, label, mandate, destination: safeOrigin(observation.url)
        });
        if (!verdict.allowed) return { ok: false, detail: verdict.reason };

        const { target, why } = await perception.reacquire(page, element.ref, step);
        if (!target) return { ok: false, stale: true, detail: why };

        try {
            await target.fill(text);
        } catch (err) {
            return { ok: false, stale: true, detail: `"${element.name}" could not be typed into` };
        }
        return { ok: true, detail: `typed into "${element.name}"` };
    }

    if (step.action === 'click') {
        const verdict = webPolicy.checkClick({
            element, label, mandate, home, destination: safeOrigin(observation.url)
        });
        if (!verdict.allowed) return { ok: false, detail: verdict.reason };

        const { target, why } = await perception.reacquire(page, element.ref, step);
        if (!target) return { ok: false, stale: true, detail: why };

        try {
            await target.click({ timeout: browser.ACTION_TIMEOUT_MS });
        } catch (err) {
            return { ok: false, stale: true, detail: `"${element.name}" could not be pressed` };
        }
        await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
        return { ok: true, detail: `clicked "${element.name}"` };
    }

    return { ok: false, detail: `${step.action} is not replayable` };
}

function finish({ procedure, status, failure = null, performed, observation, planId, startedAt, tracing }) {
    const runMs = Date.now() - startedAt;

    if (tracing && planId !== null) {
        traceStore.finishPlan(planId, { status: status === 'success' ? 'success' : status, runMs, error: failure });
    }
    if (status !== 'blocked') {
        procedureStore.recordReplay(procedure.name, { ok: status === 'success', error: failure, ms: runMs });
    }

    return {
        status,
        procedure: procedure.name,
        reason: failure,
        actions: performed,
        url: observation ? observation.url : null,
        title: observation ? observation.title : null,
        passages: observation ? perception.passages(observation) : [],
        planId,
        run_ms: runMs
    };
}

function renderGoal(procedure, args) {
    return String(procedure.goal_template || procedure.name)
        .replace(/\{([a-z][a-z0-9_]*)\}/gi, (whole, name) =>
            (args[name] !== undefined ? String(args[name]) : whole));
}

function safeHost(url) {
    try { return new URL(url).hostname; } catch { return null; }
}

function safeOrigin(url) {
    try { return new URL(url).origin; } catch { return null; }
}

module.exports = { replay, match, renderGoal, RECIPE_TIER };
