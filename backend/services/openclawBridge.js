const { execFile } = require('child_process');
const router = require('./router');
const skillRegistry = require('./skillRegistry');
const skillExecutor = require('./skillExecutor');
const skillGenerator = require('./skillGenerator');
const answerService = require('./answerService');
const planner = require('./planner');
const planExecutor = require('./planExecutor');
const traceStore = require('./traceStore');
const routerTraces = require('./routerTraces');
const proposals = require('./proposals');
const activityBus = require('./activityBus');
const profile = require('./profile');

const OPENCLAW_TIMEOUT_MS = 900000;
const MAX_OPENCLAW_OUTPUT_BYTES = 16 * 1024 * 1024;

async function initialize() {
    const skills = skillRegistry.list();
    const rejected = skillRegistry.errors();

    console.log(`[Bridge] Execution layer ready: ${skills.length} skill(s) available.`);
    if (rejected.length) {
        console.warn(`[Bridge] ${rejected.length} skill(s) failed validation and are unavailable.`);
    }
    return true;
}

function callOpenClawAgent(userMessage) {
    return new Promise((resolve, reject) => {
        const argv = [
            'agent',
            '--agent', 'main',
            '--session-key', `agent:main:jarvis-${Date.now()}`,
            '--message', userMessage,
            '--thinking', 'off',
            '--json'
        ];

        execFile('openclaw', argv, {
            timeout: OPENCLAW_TIMEOUT_MS,
            maxBuffer: MAX_OPENCLAW_OUTPUT_BYTES
        }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error(`OpenClaw execution failed: ${err.message}`));
                return;
            }
            try {
                const json = JSON.parse(stdout);
                let text = '';
                const payloads = json.result?.payloads || json.payloads;
                if (Array.isArray(payloads)) {
                    text = payloads.map(p => p.text).filter(Boolean).join('\n');
                }
                if (!text && json.result) {
                    text = typeof json.result === 'string' ? json.result : JSON.stringify(json.result);
                }
                resolve(text.trim() || stdout.trim() || 'Completed via OpenClaw.');
            } catch {
                resolve(stdout.trim() || stderr.trim() || 'Completed via OpenClaw.');
            }
        });
    });
}

async function executeSkill(decision, originalText, options = {}) {
    const { target_skill, parameters } = decision;

    const skill = skillRegistry.get(target_skill);
    if (!skill) {
        console.log(`[Bridge] Skill "${target_skill}" is not registered; offering the general executor.`);
        return maybeDelegate(originalText, options,
            `"${target_skill}" is not installed`);
    }

    const result = await skillExecutor.execute(skill, parameters);

    return {
        status: result.status === 'success' ? 'success' : result.status,
        response: result.response,
        action: 'skill',
        skill: result.skill,
        skillVersion: result.version,
        skillDurationMs: result.durationMs,
        ...(result.artifacts ? { artifacts: result.artifacts } : {})
    };
}

function maybeDelegate(text, options = {}, why = 'nothing installed covers this') {
    if (!options.interactive) return runOpenClaw(text, null);

    const offer = proposals.create('delegate', {
        request: text,
        why,
        will: 'hand this request to the general executor (OpenClaw) on this '
            + 'machine. It can use its full toolset, but outside this app\'s '
            + 'guarantees: its outcomes are not independently verified, and '
            + 'its actions are not mandate-checked'
    }, () => runOpenClaw(text, null));

    activityBus.publish('bridge', 'proposal', { kind: 'delegate', id: offer.id, why });

    return {
        status: 'needs_approval',
        action: 'proposed_delegation',
        proposal: offer,
        response: `I can't do that myself (${why}). The general executor on this `
            + `machine might — but it works outside my safety checks, so I'd `
            + `rather ask: hand it over?`
    };
}

async function runOpenClaw(text, attemptedSkill) {
    try {
        const response = await callOpenClawAgent(text);
        return {
            status: 'success',
            response,
            action: 'openclaw_agent',
            skill: attemptedSkill || null
        };
    } catch (err) {
        return {
            status: 'error',
            response: `I could not complete that. The general executor failed: ${err.message}`,
            action: 'openclaw_failed',
            skill: attemptedSkill || null
        };
    }
}

function isRealComposition(plan) {
    if (!plan.steps.length) return false;
    if (plan.steps.length === 1 && plan.steps[0].capability === 'answer') return false;
    return true;
}

async function composeThenGenerate(intentText, options = {}) {
    let plan;
    try {
        plan = await planner.plan(intentText);
    } catch (err) {
        console.warn(`[Bridge] Planning failed (${err.message}); generating instead.`);
        return maybeProposeGeneration(intentText, [], options);
    }

    if (plan.status === 'planned' && isRealComposition(plan)) {
        const execution = await planExecutor.run(plan, { request: intentText, signal: options.signal });
        return {
            status: execution.status === 'success' ? 'success' : execution.status,
            response: execution.text,
            action: 'composed',
            plan: {
                goal: execution.goal,
                steps: execution.steps.map(s => ({
                    id: s.id, capability: s.capability, status: s.status, reason: s.reason
                })),
                completed: execution.completed,
                total: execution.total,
                planId: execution.planId,
                missing: execution.missing
            }
        };
    }

    const gaps = plan.missing || [];
    try {
        traceStore.finishPlan(
            traceStore.beginPlan({
                request: intentText,
                goal: plan.goal || null,
                status: 'planned',
                planMs: plan.latency_ms ?? null,
                detail: { missing: gaps, errors: plan.errors || [] }
            }),
            { status: 'rejected', error: gaps.join('; ') || plan.reason || 'no plan' }
        );
    } catch (err) {
        console.warn(`[Bridge] Could not record the gap: ${err.message}`);
    }

    console.log(
        `[Bridge] Nothing composes for this (${plan.status})` +
        `${gaps.length ? `: ${gaps.join('; ')}` : ''}; generating a skill.`
    );
    return maybeProposeGeneration(intentText, gaps, options);
}

function maybeProposeGeneration(intentText, gaps, options = {}) {
    if (!options.interactive) return generateThenExecute(intentText, gaps, options);

    const missing = gaps.length
        ? gaps.join('; ')
        : 'no installed skill or plan covers this';

    const offer = proposals.create('build_skill', {
        request: intentText,
        missing,
        will: 'write a new skill with the local coding model, test it in a '
            + 'sandbox against generated cases, install it only if the tests '
            + 'pass, then run it to answer this request',
        estimate: 'one to three minutes'
    }, (context = {}) => generateThenExecute(intentText, gaps, { ...options, signal: context.signal }));

    activityBus.publish('bridge', 'proposal', { kind: 'build_skill', id: offer.id, missing });

    return {
        status: 'needs_approval',
        action: 'proposed_skill_build',
        proposal: offer,
        response: `I don't have a skill for that (${missing}). I can build one — `
            + `I'd write it with the local coding model, test it, and install it `
            + `only if the tests pass. Want me to?`
    };
}

async function generateThenExecute(intentText, gaps = [], options = {}) {
    if (options.signal && options.signal.aborted) {
        return { status: 'aborted', response: 'Stopped.', action: 'aborted' };
    }
    const result = await skillGenerator.generate(intentText, { gaps });

    if (result.status === 'duplicate') {
        const existing = skillRegistry.get(result.skill);
        if (existing) {
            const parameters = await router.extractParameters(existing, intentText);
            const execution = await skillExecutor.execute(existing, parameters);
            return {
                status: execution.status === 'success' ? 'success' : execution.status,
                response: execution.response,
                action: 'reused_existing_skill',
                skill: result.skill,
                ...(execution.artifacts ? { artifacts: execution.artifacts } : {}),
                generation: { status: 'duplicate', attempts: result.attempts }
            };
        }
    }

    if (result.status !== 'registered') {
        console.log(`[Bridge] Generation did not produce a skill (${result.status}); offering the general executor.`);
        const fallback = await maybeDelegate(intentText, options,
            `I tried to build a skill for it and the build did not pass its tests`);
        if (fallback.status === 'needs_approval') return fallback;
        return {
            ...fallback,
            action: 'generation_failed_fallback',
            generation: { status: result.status, reason: result.reason, attempts: result.attempts }
        };
    }

    const skill = skillRegistry.get(result.skill);

    const parameters = await router.extractParameters(skill, intentText);
    const execution = await skillExecutor.execute(skill, parameters);

    return {
        status: execution.status === 'success' ? 'success' : execution.status,
        response: `I didn't have a skill for that, so I built one (${result.skill}) and verified it against ${result.testsPassed} test case(s).\n\n${execution.response}`,
        action: 'generated_and_executed',
        skill: result.skill,
        ...(execution.artifacts ? { artifacts: execution.artifacts } : {}),
        generation: {
            status: 'registered',
            attempts: result.attempts,
            testsPassed: result.testsPassed,
            durationMs: result.durationMs
        }
    };
}

async function executeIntent(intentText, options = {}) {
    const startedAt = Date.now();
    console.log(`[Bridge] Processing: "${intentText.substring(0, 80)}"`);

    if (options.signal && options.signal.aborted) {
        return { status: 'aborted', response: 'Stopped.', action: 'aborted',
                 durationMs: Date.now() - startedAt };
    }

    if (options.executor === 'openclaw') {
        const delegated = await runOpenClaw(intentText, null);
        return { ...delegated, decision: { action: 'openclaw' }, durationMs: Date.now() - startedAt };
    }

    const decision = await router.route(intentText);
    const routeTraceId = routerTraces.record(intentText, decision);
    activityBus.publish('router', 'decision', {
        action: decision.action, skill: decision.target_skill || null,
        confidence: decision.confidence ?? null
    });

    if (options.signal && options.signal.aborted) {
        return { status: 'aborted', response: 'Stopped.', action: 'aborted',
                 durationMs: Date.now() - startedAt };
    }
    let outcome;

    switch (decision.action) {
        case router.ACTIONS.REFUSE:
            outcome = {
                status: 'refused',
                response: decision.reasoning || 'I can\'t help with that request.',
                action: 'refused'
            };
            break;

        case router.ACTIONS.CLARIFY:
            outcome = {
                status: 'needs_clarification',
                response: decision.is_successful
                    ? 'I\'m not confident I understood that. Could you rephrase it?'
                    : 'I couldn\'t process that request. Check that the inference server is running.',
                action: 'clarify'
            };
            break;

        case router.ACTIONS.ANSWER: {
            const answered = await answerService.answer(intentText);
            outcome = {
                status: answered.is_successful ? 'success' : 'error',
                response: answered.text,
                action: 'answered',
                grounded: answered.grounded,
                sources: answered.sources
            };
            break;
        }

        case router.ACTIONS.GENERATE:
            // The improvement loop is the user's choice, made at onboarding
            // and changeable in settings; off means no new skills, ever.
            if (!profile.improvementEnabled()) {
                outcome = {
                    status: 'refused',
                    response: 'Building new skills is switched off. Turn on '
                        + 'self-improvement in settings if you want me to learn this.',
                    action: 'generation_off'
                };
                break;
            }
            outcome = await composeThenGenerate(intentText, options);
            break;

        case router.ACTIONS.EXECUTE:
            outcome = await executeSkill(decision, intentText, options);
            break;

        default:
            outcome = {
                status: 'error',
                response: `Unknown routing action: ${decision.action}`,
                action: 'error'
            };
    }

    // A decision is verified by its outcome: only what succeeded can teach
    // the guard. Refusals stay recorded but unconfirmed.
    if (outcome.status === 'success' && decision.action !== router.ACTIONS.REFUSE) {
        routerTraces.confirm(routeTraceId, outcome.action);
    } else {
        routerTraces.note(routeTraceId, outcome.status);
    }

    return {
        ...outcome,
        executionTimeMs: Date.now() - startedAt,
        routing: {
            intent_type: decision.intent_type,
            confidence: decision.confidence,
            reasoning: decision.reasoning,
            target_skill: decision.target_skill,
            parameters: decision.parameters,
            attempts: decision.attempts,
            latency_ms: decision.latency_ms,
            schema_valid: decision.schema_valid
        }
    };
}

let openclawAvailable = null;

function isConnected() {
    if (openclawAvailable === null) {
        try {
            require('child_process').execFileSync('/usr/bin/which', ['openclaw'],
                { stdio: ['ignore', 'ignore', 'ignore'] });
            openclawAvailable = true;
        } catch {
            openclawAvailable = false;
        }
    }
    return openclawAvailable;
}

function disconnect() { }

async function answerProposal(id, decision, context = {}) {
    if (decision === 'yes') {
        activityBus.publish('bridge', 'proposal_approved', { id });
        return proposals.approve(id, context);
    }
    activityBus.publish('bridge', 'proposal_declined', { id });
    return proposals.decline(id);
}

module.exports = {
    initialize, executeIntent, isConnected, disconnect, callOpenClawAgent,
    answerProposal,
    composeThenGenerate, isRealComposition, maybeProposeGeneration, maybeDelegate
};
