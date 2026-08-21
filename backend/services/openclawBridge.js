const { execFile } = require('child_process');
const router = require('./router');
const skillRegistry = require('./skillRegistry');
const skillExecutor = require('./skillExecutor');
const skillGenerator = require('./skillGenerator');
const answerService = require('./answerService');
const planner = require('./planner');
const planExecutor = require('./planExecutor');
const skillCare = require('./skillCare');
const traceStore = require('./traceStore');
const routerTraces = require('./routerTraces');
const proposals = require('./proposals');
const activityBus = require('./activityBus');
const profile = require('./profile');
const llmClient = require('./llmClient');
const securityStore = require('../security/store');
const os = require('os');
const path = require('path');

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

function callOpenClawAgent(userMessage, signal) {
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
            maxBuffer: MAX_OPENCLAW_OUTPUT_BYTES,
            ...(signal ? { signal } : {})
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

// A follow-up is resolved into the standalone request it means — "check the
// official website" becomes a sentence naming the site — before anything
// routes on it. The raw exchange travels no further than this call: fed
// onward whole, it turned greetings into web plans and put assistant prose
// into browse goals.
// The rubric tag and its monologue belong in the trace; the user gets one
// plain sentence about the request itself.
function plainRefusal(reasoning) {
    const text = String(reasoning || '').replace(/^\s*R\d+\s*[:.—-]?\s*/, '').trim();
    const sentence = (text.match(/^.{10,240}?\./s) || [text.slice(0, 240)])[0].trim();
    if (!sentence) return 'I can\'t help with that request.';
    return `I won't do that: ${sentence.replace(/\.?$/, '.')}`;
}

async function resolveFollowUp(text, history) {
    if (!Array.isArray(history) || history.length === 0) return text;
    // Asking the same thing again is a retry, not a follow-up: it already
    // stands alone, and a rewrite can only make it worse.
    if (history.some(m => m.role === 'user' && m.text.trim() === text.trim())) {
        return text;
    }
    const exchange = history
        .map(m => `${m.role === 'user' ? 'user' : 'assistant'}: ${m.text}`)
        .join('\n');
    try {
        const raw = await llmClient.complete([
            { role: 'system', content:
                'A user is mid-conversation with their assistant. Rewrite their '
                + 'newest message as ONE standalone request meaning the same '
                + 'thing, resolved against the exchange: fill in what "it", '
                + '"that" or "the website" refer to — "build a skill for '
                + 'that" after asking about memory usage becomes "build a '
                + 'skill to check how much memory my computer is using". '
                + 'If the newest message '
                + 'already stands alone, or is not a request at all — a '
                + 'greeting, thanks, chit-chat — return it EXACTLY as written. '
                + 'You speak AS the user, in their words: never describe them '
                + '("The user wants") and never answer the request. Reply with '
                + 'that one line only, no quotes, no commentary; when in doubt, '
                + 'return it unchanged.' },
            { role: 'user', content: `${exchange}\n\nNewest message: ${text}` }
        ], { tier: 'guard', temperature: 0, max_tokens: 120, timeout_ms: 20000 });
        const resolved = String(raw || '').trim()
            .replace(/^["']|["']$/g, '').trim();
        if (!resolved || resolved.length > 300) return text;
        if (/\bthe user\b/i.test(resolved)) return text;
        if (resolved !== text) {
            console.log(`[Bridge] Follow-up resolved (${text.length} -> ${resolved.length} chars)`);
        }
        return resolved;
    } catch {
        return text;
    }
}

// The asks that sound like they mean a file this chat has already seen.
const REFERENCES_FILES =
    /\b(pdf|file|document|docx?|report|attachment|image|photo|picture|schedule|spreadsheet|that one|it back)\b/i;

// Verbs that make a short utterance a job rather than conversation.
const SMALL_ACTION =
    /^(send|open|find|build|make|check|read|write|search|email|mail|book|play|show|list|run|create|delete|remove|convert|download|upload|save|schedule|set|turn|call|text|browse|visit|go|fetch|get|give|share|attach|summari[sz]e|translate|extract|count|rename|move|copy|stop|pause|resume)\b/i;

function isSmallTalk(text) {
    const plain = String(text || '').trim();
    return plain.split(/\s+/).length <= 4
        && !/\d/.test(plain)
        && !SMALL_ACTION.test(plain);
}

// An attached file's indexed chunks, pinned as answer context so the reply
// grounds on what the user just handed over, not on retrieval's best guess.
function attachmentPassages(attached) {
    const corpusIndexer = require('./corpusIndexer');
    const passages = [];
    for (const file of attached.slice(0, 3)) {
        try {
            for (const record of corpusIndexer.recordsForFile(file.path)) {
                passages.push({
                    text: record.meta.text,
                    cite: `file: ${path.basename(file.path)}`
                });
            }
        } catch { /* an unindexed attachment answers like any other ask */ }
    }
    return passages;
}

// A reply that only disclaims reach into the live web is not an answer;
// the planner's browse lane has that reach, so the ask goes there instead.
const DISCLAIMS_THE_WEB =
    /\b(?:unable to|cannot|can't|do(?:es)?\s*n[o']t have|lack)\b[^.]{0,60}\b(?:internet|real[- ]?time|live|browse|browsing|web|current (?:information|data)|system information|your (?:computer|mac|machine|device|files))\b/i;

async function executeSkill(decision, originalText, options = {}) {
    const { target_skill, parameters } = decision;

    const skill = skillRegistry.get(target_skill);
    if (!skill) {
        console.log(`[Bridge] Skill "${target_skill}" is not registered; offering the general executor.`);
        return maybeDelegate(originalText, options,
            `"${target_skill}" is not installed`);
    }

    const result = await skillCare.run(skill, parameters,
        { request: originalText, signal: options.signal });

    return {
        status: result.status === 'success' ? 'success' : result.status,
        response: result.response,
        action: 'skill',
        skill: result.skill,
        skillVersion: result.version,
        skillDurationMs: result.durationMs,
        ...(result.proposal ? { proposal: result.proposal } : {}),
        ...(result.artifacts ? { artifacts: result.artifacts } : {})
    };
}

function maybeDelegate(text, options = {}, why = 'nothing installed covers this') {
    if (!options.interactive) return runOpenClaw(text, null, options.signal);

    const offer = proposals.create('delegate', {
        request: text,
        why,
        will: 'hand this request to the general executor (OpenClaw) on this '
            + 'machine. It can use its full toolset, but outside this app\'s '
            + 'guarantees: its outcomes are not independently verified, and '
            + 'its actions are not mandate-checked'
    }, (context = {}) => runOpenClaw(text, null, context.signal));

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

async function runOpenClaw(text, attemptedSkill, signal) {
    try {
        const response = await callOpenClawAgent(text, signal);
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

// The consent gate speaks approval, not shell. When a plan blocks on an
// ungranted folder and the request names a well-known one, the grant becomes
// a yes/no in whichever surface asked — never a command line.
function wellKnownFolder(text) {
    const named = String(text).toLowerCase()
        .match(/\b(downloads|documents|desktop|pictures|movies|music)\b/);
    if (!named) return null;
    const name = named[1][0].toUpperCase() + named[1].slice(1);
    return path.join(os.homedir(), name);
}

function proposeFolderAccess(intentText, folder, collection, options) {
    const offer = proposals.create('folder_access', {
        request: intentText,
        summary: `Let Jarvis read ${folder}?`,
        will: `remember ${folder} as a granted ${collection} folder and `
            + 'finish this request with it',
        estimate: 'a few seconds'
    }, (context = {}) => {
        securityStore.grantRoot(folder, collection);
        return executeIntent(intentText, { ...options, signal: context.signal });
    });
    activityBus.publish('bridge', 'proposal',
        { kind: 'folder_access', id: offer.id, folder });
    return {
        status: 'needs_approval',
        action: 'proposed',
        response: `I found what I need in ${folder}, but that folder has not `
            + 'been opened to me. Want me to remember it as one I may read, '
            + 'and finish the request?',
        proposal: offer
    };
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
        const gate = execution.status !== 'success' && options.interactive
            && String(execution.text || '').match(/no folder has been granted for (\w+)/);
        if (gate) {
            const offered = wellKnownFolder(intentText);
            if (offered) return proposeFolderAccess(intentText, offered, gate[1], options);
        }
        return {
            status: execution.status === 'success' ? 'success' : execution.status,
            response: execution.text,
            action: 'composed',
            ...(execution.artifacts ? { artifacts: execution.artifacts } : {}),
            ...(execution.proposal ? { proposal: execution.proposal } : {}),
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

    // A plan that reduces to "just answer" with nothing missing is the
    // planner agreeing this was conversation all along. If the answer layer
    // already replied, that reply wins; if the router skipped it, answer now.
    // The skill factory is for capability gaps, not small talk.
    if (plan.status === 'planned' && !gaps.length) {
        if (options.fallbackAnswer) {
            console.log('[Bridge] The planner calls it an answer; keeping the one we had.');
            return options.fallbackAnswer;
        }
        console.log('[Bridge] The planner calls it an answer; answering instead.');
        const answered = await answerService.answer(intentText);
        return {
            status: answered.is_successful ? 'success' : 'error',
            response: answered.text,
            action: 'answered',
            grounded: answered.grounded,
            sources: answered.sources
        };
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
            const execution = await skillCare.run(existing, parameters,
                { request: intentText, signal: options.signal });
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
    const execution = await skillCare.run(skill, parameters,
        { request: intentText, signal: options.signal });

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
    console.log(`[Bridge] Processing intent (${intentText.length} chars)`);

    if (options.signal && options.signal.aborted) {
        return { status: 'aborted', response: 'Stopped.', action: 'aborted',
                 durationMs: Date.now() - startedAt };
    }

    if (options.executor === 'openclaw') {
        const delegated = await runOpenClaw(intentText, null, options.signal);
        return { ...delegated, decision: { action: 'openclaw' }, durationMs: Date.now() - startedAt };
    }

    let asked = await resolveFollowUp(intentText, options.history);
    // Attachments ride options, not the text, so the follow-up resolver can
    // never strip them; they rejoin the request here, after resolution.
    const attached = Array.isArray(options.attachments) ? options.attachments : [];
    if (attached.length) {
        asked += `\n\n(The user attached: ${attached.map(a => a.path).join(', ')})`;
    }
    // "That PDF" from three messages ago is still in the room: files that
    // crossed this conversation earlier come back into view whenever the
    // ask sounds like it means one of them.
    const recent = Array.isArray(options.recentFiles) ? options.recentFiles : [];
    const wantsFiles = !attached.length && recent.length > 0
        && REFERENCES_FILES.test(asked);
    if (wantsFiles) {
        asked += `\n\n(Files earlier in this chat: ${recent.map(f => f.path).join(', ')})`;
    }
    // A tiny conversational ask never deserves the skill factory: no digits,
    // no action verb, no file in hand — it goes straight to the answer path
    // before triage can dream bigger.
    if (!attached.length && isSmallTalk(asked)) {
        console.log('[Bridge] Small ask; answering directly.');
        const answered = await answerService.answer(asked);
        return {
            status: answered.is_successful ? 'success' : 'error',
            response: answered.text,
            action: 'answered',
            grounded: answered.grounded,
            sources: answered.sources,
            durationMs: Date.now() - startedAt
        };
    }
    const decision = await router.route(asked);
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
                response: plainRefusal(decision.reasoning),
                action: 'refused'
            };
            break;

        case router.ACTIONS.CLARIFY:
            outcome = {
                status: 'needs_clarification',
                response: decision.is_successful
                    ? 'I\'m not confident I understood that. Could you rephrase it?'
                    : decision.intent_type === 'timeout'
                        ? 'The model answered too slowly just now — the machine may be '
                            + 'busy. Give it a moment and ask again.'
                        : 'I couldn\'t reach the local models. If they are still '
                            + 'starting, the light in the corner turns green when '
                            + 'they are ready.',
                action: 'clarify'
            };
            break;

        case router.ACTIONS.ANSWER: {
            // An attached file IS the context: its indexed text is pinned
            // straight into the answer, no retrieval lottery in between.
            // A question that sounds like it means an earlier file pins
            // those the same way.
            const pinned = attachmentPassages(attached.length ? attached
                : (wantsFiles ? recent : []));
            const answered = await answerService.answer(asked,
                pinned.length ? { passages: pinned } : {});
            if (answered.is_successful
                && (answered.refused || DISCLAIMS_THE_WEB.test(answered.text || ''))) {
                // The disclaimer may be the whole point ("what's the weather")
                // or an aside in a perfectly good reply ("who are you"). Carry
                // the reply along: if the planner finds no capability gap
                // either, this answer stands instead of a skill build.
                outcome = await composeThenGenerate(asked, {
                    ...options,
                    fallbackAnswer: {
                        status: 'success',
                        response: answered.text,
                        action: 'answered',
                        grounded: answered.grounded,
                        sources: answered.sources
                    }
                });
                break;
            }
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
            // Refused here, before a card promises a build this machine's
            // memory class cannot hold.
            if (!llmClient.modelForTier('smith')) {
                outcome = {
                    status: 'refused',
                    response: 'This machine doesn\'t run a builder model — its '
                        + 'memory class is too small to write new skills. '
                        + 'Everything already installed keeps working.',
                    action: 'no_builder'
                };
                break;
            }
            outcome = await composeThenGenerate(asked, options);
            break;

        case router.ACTIONS.EXECUTE:
            outcome = await executeSkill(decision, asked, options);
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
        const result = await proposals.approve(id, context);
        if (result && result.status !== 'unknown_proposal') {
            activityBus.publish('bridge', 'proposal_approved', { id });
        }
        return result;
    }
    const result = proposals.decline(id);
    if (result && result.status !== 'unknown_proposal') {
        activityBus.publish('bridge', 'proposal_declined', { id });
    }
    return result;
}

module.exports = {
    initialize, executeIntent, isConnected, disconnect, callOpenClawAgent,
    answerProposal,
    composeThenGenerate, isRealComposition, maybeProposeGeneration, maybeDelegate
};
