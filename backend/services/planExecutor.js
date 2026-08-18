const capabilityGraph = require('./capabilityGraph');
const traceStore = require('./traceStore');
const labels = require('../security/labels');
const egress = require('../security/egress');
const securityStore = require('../security/store');

const { ORIGIN, SENSITIVITY } = labels;
const { EFFECT } = capabilityGraph;

const DISCLOSURE_CHANNEL = {
    [EFFECT.NETWORK]: egress.CHANNEL.NETWORK,
    [EFFECT.MESSAGE]: egress.CHANNEL.MESSAGE
};

function baseLabel() {
    return labels.label(ORIGIN.USER, SENSITIVITY.PERSONAL);
}


const REFERENCE = /^\$([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$/i;

function bind(value, environment, track) {
    if (typeof value === 'string') {
        const match = value.match(REFERENCE);
        if (!match) return value;

        const [, step, output] = match;
        const produced = environment.get(step);
        if (!produced) return value;

        const resolved = produced.values[output];
        track.labels.push(produced.label);
        track.resolved.push({ raw: value, step, output, value: resolved });
        return resolved;
    }
    if (Array.isArray(value)) {
        return value.map(item => bind(item, environment, track));
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            out[key] = bind(item, environment, track);
        }
        return out;
    }
    return value;
}

function isEmpty(value) {
    if (value === undefined || value === null) return true;
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === 'string') return value.trim() === '';
    return false;
}

function starvation(resolved) {
    return resolved.find(reference => isEmpty(reference.value)) || null;
}


function checkDisclosure(capability, label, step, request) {
    const channels = [...new Set((capability.effects || [])
        .map(effect => DISCLOSURE_CHANNEL[effect])
        .filter(Boolean))];
    if (!channels.length) return null;

    // The summary is the grant's redemption key, so it carries only what a
    // regenerated plan reproduces verbatim: the capability and the user's own
    // words. The request scopes the grant — approving one ask must not open
    // the same channel to a different ask — while the planner's phrasing
    // rides in the preview, where the user reads it and nothing matches on it.
    const asked = String(request || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    const flowFor = (channel) => ({
        channel,
        action: capability.id,
        inputs: [label],
        summary: `a plan step disclosing through ${capability.id}`
            + (asked ? ` for "${asked}"` : ''),
        preview: step.reason ? `${step.id}: ${step.reason}` : step.id,
        policy: capability.disclosurePolicy || undefined
    });

    // With several channels, consuming a single-use grant for one before
    // another blocks would burn it; redeem nothing until all are known to pass.
    if (channels.length > 1) {
        for (const channel of channels) {
            const flow = flowFor(channel);
            const { decision } = (flow.policy || egress.evaluate)(label, channel);
            if (decision === egress.DECISION.DENY) return egress.guard(flow);
            if (decision === egress.DECISION.APPROVE
                && !securityStore.peekGrant({
                    channel, action: capability.id,
                    destination: null, summary: flow.summary
                })) {
                return egress.guard(flow);
            }
        }
    }

    let verdict = null;
    for (const channel of channels) {
        verdict = egress.guard(flowFor(channel));
        if (!verdict.allowed) return verdict;
    }
    return verdict && verdict.allowed ? verdict : null;
}

function checkConsent(capability) {
    if (!capability.consent) return null;

    let granted = [];
    try {
        granted = securityStore.grantedRoots(capability.consent);
    } catch (err) {
        return `consent could not be checked: ${err.message}`;
    }
    if (granted.length) return null;

    return `no folder has been granted for ${capability.consent}. ` +
        `Grant one with: node tools/index-corpus.js ${capability.consent} <folder>`;
}

function recordMutation(capability, label, step) {
    const mutating = capability.effects.filter(e => !DISCLOSURE_CHANNEL[e]);
    if (!mutating.length) return null;

    try {
        return securityStore.recordDecision({
            channel: 'mutation',
            action: capability.id,
            decision: 'allow',
            label,
            summary: `plan step ${step.id}: ${capability.id}`,
            detail: { effects: mutating, reason: step.reason || null }
        });
    } catch (err) {
        console.warn(`[PlanExecutor] Could not record mutation: ${err.message}`);
        return null;
    }
}


async function run(plan, options = {}) {
    const startedAt = Date.now();
    const graph = options.graph || capabilityGraph;
    const tracing = options.trace !== false;

    const planId = tracing
        ? traceStore.beginPlan({
            request: options.request || plan.goal || '',
            goal: plan.goal || null,
            status: 'running',
            stepCount: plan.steps.length,
            planMs: plan.latency_ms ?? null,
            detail: { missing: plan.missing || [], attempts: plan.attempts ?? null }
        })
        : null;

    const environment = new Map();
    const record = [];
    let failure = null;

    for (const [ordinal, step] of plan.steps.entries()) {
        if (options.signal && options.signal.aborted) {
            failure = { step: step.id, error: 'stopped before this step', aborted: true };
            record.push({ ...step, status: 'skipped', error: failure.error, durationMs: 0 });
            if (tracing) {
                traceStore.recordStep(planId, {
                    ordinal, key: step.id, capability: step.capability,
                    status: 'skipped', error: failure.error, durationMs: 0
                });
            }
            break;
        }

        const capability = graph.get(step.capability);
        const stepStartedAt = Date.now();

        if (!capability) {
            failure = { step: step.id, error: `capability "${step.capability}" is no longer available` };
            record.push({ ...step, status: 'failed', error: failure.error, durationMs: 0 });
            if (tracing) {
                traceStore.recordStep(planId, {
                    ordinal, key: step.id, capability: step.capability,
                    status: 'failed', error: failure.error, durationMs: 0
                });
            }
            break;
        }

        const track = { labels: [baseLabel()], resolved: [] };
        const bound = bind(step.inputs, environment, track);
        const inputLabel = labels.join(...track.labels);

        const starved = starvation(track.resolved);
        if (starved) {
            const producer = plan.steps.find(s => s.id === starved.step);
            const error = `${starved.step} (${producer ? producer.capability : 'earlier step'}) ` +
                `found no ${starved.output}, so there is nothing to ${step.reason || 'continue with'}`;

            record.push({ ...step, status: 'skipped', error, durationMs: 0 });
            if (tracing) {
                traceStore.recordStep(planId, {
                    ordinal, key: step.id, capability: capability.id, tier: capability.tier,
                    status: 'skipped', label: inputLabel, inputs: bound,
                    error, durationMs: 0
                });
            }
            failure = { step: step.id, sourceStep: starved.step, error, starved: true };
            break;
        }

        const blocked = checkConsent(capability)
            || describeDisclosure(checkDisclosure(capability, inputLabel, step, options.request));

        if (blocked) {
            record.push({
                ...step, status: 'blocked', error: blocked,
                durationMs: Date.now() - stepStartedAt
            });
            if (tracing) {
                traceStore.recordStep(planId, {
                    ordinal, key: step.id, capability: capability.id, tier: capability.tier,
                    status: 'blocked', label: inputLabel, inputs: bound,
                    error: blocked, durationMs: Date.now() - stepStartedAt
                });
            }
            failure = { step: step.id, error: blocked, blocked: true };
            break;
        }

        recordMutation(capability, inputLabel, step);

        let values;
        try {
            values = await capability.run(bound, {
                label: inputLabel, step, planId, request: options.request || '',
                signal: options.signal
            });
        } catch (err) {
            const durationMs = Date.now() - stepStartedAt;
            // A step that stopped to offer a card holds the plan rather than
            // failing it: the card carries its own continuation. A step the
            // user stopped is no failure either — recorded as one, it would
            // count against the very recipe the Stop interrupted.
            const held = err.proposal ? 'needs_approval'
                : err.aborted ? 'aborted' : 'failed';
            failure = { step: step.id, error: err.message,
                        ...(err.proposal ? { proposal: err.proposal } : {}),
                        ...(err.aborted ? { aborted: true } : {}) };
            record.push({ ...step, status: held, error: err.message, durationMs });
            if (tracing) {
                traceStore.recordStep(planId, {
                    ordinal, key: step.id, capability: capability.id, tier: capability.tier,
                    status: held, label: inputLabel, inputs: bound,
                    error: err.message, durationMs
                });
            }
            break;
        }

        const outputLabel = labels.join(inputLabel, capability.produces);
        environment.set(step.id, { values: values || {}, label: outputLabel });

        const durationMs = Date.now() - stepStartedAt;
        record.push({
            ...step, status: 'success', values, label: outputLabel, durationMs
        });

        if (tracing) {
            traceStore.recordStep(planId, {
                ordinal, key: step.id, capability: capability.id, tier: capability.tier,
                status: 'success', label: outputLabel, inputs: bound,
                value: values, durationMs
            });
        }
    }

    const runMs = Date.now() - startedAt;
    const last = [...environment.values()].pop() || null;

    const status = failure
        ? (failure.proposal ? 'needs_approval'
            : failure.aborted ? 'aborted'
            : failure.blocked ? 'blocked' : failure.starved ? 'empty' : 'failed')
        : 'success';

    if (tracing) {
        traceStore.finishPlan(planId, {
            status: status === 'success' ? 'success' : status,
            runMs,
            error: failure ? failure.error : null
        });
    }

    return {
        status,
        planId,
        goal: plan.goal || null,
        text: failure && failure.proposal ? failure.error : render(plan, record, failure),
        ...(failure && failure.proposal ? { proposal: failure.proposal } : {}),
        steps: record,
        label: last ? last.label : baseLabel(),
        completed: record.filter(s => s.status === 'success').length,
        total: plan.steps.length,
        missing: plan.missing || [],
        failure,
        run_ms: runMs
    };
}

function describeDisclosure(verdict) {
    if (!verdict || verdict.allowed) return null;
    if (verdict.decision === egress.DECISION.DENY) return verdict.reason;
    return `${verdict.reason} Waiting on your approval (#${verdict.approvalId}).`;
}


function clause(step) {
    const reason = (step && step.reason ? step.reason : '').trim().replace(/[.;,]+$/, '');
    if (!reason) return null;
    return reason.charAt(0).toLowerCase() + reason.slice(1);
}

function sentence(clauses) {
    const parts = clauses.filter(Boolean);
    if (!parts.length) return '';

    const joined = parts.length === 1
        ? parts[0]
        : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
    return `${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`;
}

function render(plan, record, failure) {
    const succeeded = record.filter(s => s.status === 'success');
    const lines = [];

    if (failure && failure.starved) {
        const what = clause(plan.steps.find(s => s.id === failure.sourceStep));

        lines.push(what
            ? `I found nothing. The step to ${what} came back empty, so the rest had nothing to work on.`
            : 'I found nothing matching that, so I stopped rather than answer without it.');
    } else {
        const spoken = [...succeeded].reverse()
            .find(s => s.values && typeof s.values.text === 'string' && s.values.text.trim());

        if (spoken) {
            lines.push(spoken.values.text.trim());
        } else if (succeeded.length) {
            lines.push(sentence(succeeded.map(clause)) || 'Done.');
        }

        if (failure && failure.aborted) {
            lines.push(succeeded.length
                ? `Stopped after ${succeeded.length} of ${plan.steps.length} steps.`
                : 'Stopped.');
        } else if (failure) {
            const where = plan.steps.findIndex(s => s.id === failure.step) + 1;
            lines.push(
                succeeded.length
                    ? `I got ${succeeded.length} of ${plan.steps.length} steps done. Step ${where} ` +
                      `(${plan.steps[where - 1]?.capability}) ` +
                      `${failure.blocked ? 'is blocked' : 'failed'}: ${failure.error}`
                    : `I couldn't do that. ${failure.error}`
            );
        }
    }

    for (const gap of plan.missing || []) {
        lines.push(`I have no way to do this part: ${gap}`);
    }

    return lines.join('\n\n').trim() || 'Done.';
}

module.exports = { run, bind, baseLabel, render, DISCLOSURE_CHANNEL };
