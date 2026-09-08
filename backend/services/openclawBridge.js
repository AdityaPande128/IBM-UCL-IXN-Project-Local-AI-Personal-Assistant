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

const DEPENDENT_FRAGMENT =
    /^(?:and|also|then|plus|same (?:for|with|in)|what about|how about)\b[^.?!]{0,60}[.?!]?$|^[^.?!]{0,40}\btoo[.!]?$/i;

async function resolveFollowUp(text, history) {
    if (!Array.isArray(history) || history.length === 0) return text;
    // Asking the same thing again is a retry, not a follow-up: it already
    // stands alone, and a rewrite can only make it worse.
    const textOf = (m) => String((m && (m.text ?? m.content)) || '');
    if (history.some(m => m.role === 'user' && textOf(m).trim() === text.trim())) {
        return text;
    }
    const sameFor = /^(?:now\s+|and\s+|then\s+)?(?:do\s+|try\s+)?(?:the\s+)?same\s+(?:thing\s+|one\s+)?(?:for|with|on|to)\s+(.+?)\s*[.!?]?$/i.exec(text.trim());
    const lastUser = [...history].reverse().find(m => m.role === 'user');
    if (sameFor && lastUser) {
        const FILE_TOKEN = /(?:~?\/[^\s"']+|[\w.-]+\.[a-z0-9]{1,5})/gi;
        const previous = [...textOf(lastUser).matchAll(FILE_TOKEN)].map(m => m[0]);
        const swap = sameFor[1].replace(/^["']|["']$/g, '');
        if (previous.length) {
            const old = previous[previous.length - 1];
            const keepsDir = /\//.test(old) && !/\//.test(swap);
            const replacement = keepsDir ? old.slice(0, old.lastIndexOf('/') + 1) + swap : swap;
            const rewritten = textOf(lastUser).replace(old, replacement);
            console.log(`[Bridge] Follow-up resolved by swap (${text.length} -> ${rewritten.length} chars)`);
            return rewritten;
        }
    }
    const exchange = history
        .map(m => `${m.role === 'user' ? 'user' : 'assistant'}: ${textOf(m)}`)
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
        if (/^(null|none|undefined|n\/a)$/i.test(resolved)) return text;
        const tokens = (t) => new Set((String(t).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []));
        const userWords = tokens([text, ...history.filter(m => m.role === 'user').map(textOf)].join(' '));
        const shared = [...tokens(resolved)].some(w => userWords.has(w));
        if (!shared) return text;
        if (resolved !== text) {
            console.log(`[Bridge] Follow-up resolved (${text.length} -> ${resolved.length} chars)`);
        }
        return resolved;
    } catch {
        return text;
    }
}


function calendarTemplate(text) {
    const time = /from\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:to|until|-|\u2013)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i
        .exec(text);
    if (!time) return null;
    let h1 = Number(time[1]), min1 = Number(time[2] || 0);
    let h2 = Number(time[4]), min2 = Number(time[5] || 0);
    const ap1 = time[3], ap2 = time[6];
    if (ap1) {
        if (/pm/i.test(ap1) && h1 < 12) h1 += 12;
        if (/am/i.test(ap1) && h1 === 12) h1 = 0;
    }
    if (ap2) {
        if (/pm/i.test(ap2) && h2 < 12) h2 += 12;
        if (/am/i.test(ap2) && h2 === 12) h2 = 0;
    } else if (ap1) {
        if (h2 <= (h1 % 12)) h2 += Math.floor(h1 / 12) * 12;
        if (h2 <= h1) h2 += 12;
    }
    if (!ap1 && !ap2) {
        if (h2 <= h1) h2 += 12;
        if (h1 < 8) { h1 += 12; h2 += 12; }
    }
    if ((h2 * 60 + min2) <= (h1 * 60 + min1) || h2 >= 24) return null;
    const day = new Date();
    if (/\btomorrow\b/i.test(text)) day.setDate(day.getDate() + 1);
    const stamp = (h, m) => day.getFullYear()
        + String(day.getMonth() + 1).padStart(2, '0')
        + String(day.getDate()).padStart(2, '0')
        + 'T' + String(h).padStart(2, '0') + String(m).padStart(2, '0') + '00';
    const titled = /:\s*(.+?)\s+from\s/i.exec(text);
    const title = (titled ? titled[1] : 'New event').trim().slice(0, 80);
    const label = (h, m) => {
        const ap = h >= 12 ? 'pm' : 'am';
        const hh = h % 12 === 0 ? 12 : h % 12;
        return hh + (m ? ':' + String(m).padStart(2, '0') : '') + ap;
    };
    return {
        title,
        titled: Boolean(titled),
        when: `${label(h1, min1)} to ${label(h2, min2)}`,
        url: 'https://calendar.google.com/calendar/render?action=TEMPLATE'
            + '&text=' + encodeURIComponent(title)
            + '&dates=' + stamp(h1, min1) + '/' + stamp(h2, min2),
        dayUrl: 'https://calendar.google.com/calendar/u/0/r/day/'
            + day.getFullYear() + '/' + (day.getMonth() + 1) + '/' + day.getDate()
    };
}

function sourceArtifacts(sources) {
    try {
        const fileIndex = require('./fileIndex');
        const names = [...new Set((sources || [])
            .map(c => (/^file[^:]*:\s*(.+)$/.exec(String(c)) || [])[1])
            .filter(Boolean).map(n => n.trim()))].slice(0, 1);
        const files = names.map(name => {
            const hit = fileIndex.search({ text: name, limit: 5 })
                .find(r => String(r.name).toLowerCase() === name.toLowerCase());
            return hit && { name: hit.name, path: hit.path };
        }).filter(Boolean);
        console.log(`[Bridge] source files: ${JSON.stringify(names)} -> `
            + JSON.stringify(files.map(f => f.name)));
        return files.length ? { artifacts: { files } } : {};
    } catch {
        return {};
    }
}

// The asks that sound like they mean a file this chat has already seen.
const REFERENCES_FILES =
    /\b(pdf|file|document|docx?|report|attachment|image|photo|picture|spreadsheet|that one|it back|csv|tsv|xlsx?|json|txt|md|markdown|epub|folder|letter)\b/i;

// The shapes of a question about content, and of an ask to move a file
// somewhere; the first answers from the file, the second stays routable.
const CONTENT_QUESTION =
    /^(what|who|when|where|why|how|does|do|is|are|can|could|summari[sz]e|read|tell|explain)\b|\b(say|says|said|contain|contains|about|mean|means|inside|summar)/i;
const WANTS_DELIVERY =
    /^(send|share|give|deliver|forward|email|mail|attach|save|copy|move|rename|delete|remove|open|print)\b/i;
const DELIVERY_ASK = /^(send|share|give|deliver|forward|attach)\b/i;
const NAMES_A_RECIPIENT = /@|\bto\s+(?!me\b|my\b|this\b|the\s+phone\b)[a-z]/i;
const MUTATES_FILE =
    /\b(delete|remove|rename|move|copy|save|print|open|email|mail|send|share|forward|attach|deliver)\b/i;

// Verbs that make a short utterance a job rather than conversation.
const SMALL_ACTION =
    /^(send|open|find|build|make|check|read|write|search|email|mail|book|play|show|list|run|create|delete|remove|convert|download|upload|save|schedule|set|turn|call|text|browse|visit|go|fetch|get|give|share|attach|summari[sz]e|translate|extract|count|rename|move|copy|stop|pause|resume|remind|wipe|cancel|clear|forget|start|launch|close|quit|update|enable|disable|add|mute|unmute|lower|raise|take|capture|toggle|dim|brighten|lock|unlock|skip|next|previous|kill|restart|reboot|sleep|empty|zip|unzip|pay|buy|purchase|order|transfer|wire|withdraw|deposit|export|import|install|uninstall|format|erase|shut|shutdown|sign|log|login|logout|post|publish|submit|reply|change|edit|modify|reset|hack|crack|bypass|encrypt|decrypt|dump|leak|share)\b|\b(volume|screenshot|wifi|bluetooth|brightness|screen|desktop|disk|ram|memory|password|passwords|bill|bills|money|card|bank|account|accounts|key|keys|credential|credentials|trash|firewall|security|settings|drive|payment|invoice)\b/i;

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
            let texts = corpusIndexer.recordsForFile(file.path)
                .map(record => record.meta.text);
            if (!texts.length) {
                // Not indexed yet: read the file itself, in citable chunks.
                const documentExtract = require('./documentExtract');
                const extension = path.extname(file.path).toLowerCase();
                const raw = documentExtract.extract(file.path, extension);
                for (let at = 0; raw && at < raw.length && texts.length < 4;
                    at += 1600) {
                    texts.push(raw.slice(at, at + 1600));
                }
            }
            for (const text of texts.slice(0, 4)) {
                passages.push({
                    text: String(text).slice(0, 1600),
                    cite: `file: ${path.basename(file.path)}`
                });
            }
        } catch { /* an unreadable attachment answers like any other ask */ }
    }
    return passages.slice(0, 8);
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

    const planner = require('./planner');
    const described = `${skill.name} ${skill.description || ''}`;
    if (!planner.carriesMutation(originalText, described)) {
        console.log(`[Bridge] ${skill.name} does not speak of what "${originalText.slice(0, 60)}" asks to change; not running it.`);
        return composeThenGenerate(originalText, options);
    }
    const result = await skillCare.run(skill, parameters,
        { request: originalText, signal: options.signal });

    if (result.status === 'error' && result.mismatch) {
        console.log(`[Bridge] ${skill.name} does not fit this request (${result.reason}); offering to build.`);
        return maybeProposeGeneration(originalText,
            [`${skill.name} could not do that: ${result.reason}`], options);
    }

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
    if (!options.interactive) {
        return {
            status: 'error',
            action: 'delegation_requires_approval',
            response: `I couldn't do that myself (${why}). The general executor on this `
                + 'machine might, but handing a request over needs your approval, and nobody is here to give it.'
        };
    }

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

    if (plan.status === 'planned' && isRealComposition(plan) && !(plan.missing || []).length) {
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

const DELIVERY_NOISE = new Set(['send', 'share', 'give', 'deliver', 'forward', 'attach', 'me', 'my', 'the',
    'to', 'phone', 'file', 'files', 'please', 'both', 'all', 'two', 'and', 'of', 'over', 'this', 'that', 'a', 'an', 'onto', 'device', 'mobile']);
const NEEDS_THE_BROWSER =
    /\b(e-?mails?|my (?:mailbox|inbox)|gmail|outlook|my calendar|attachments? from|website|web ?page|browser|online)\b/i;
const NOTE_ASK = /^(?:please\s+)?(?:note that|note:|remember that|remember,? we|remember,? i|remember:|for the record|keep in mind|just so you know|fyi)\b/i;
const WHERE_IS = /^(?:where(?:'s| is| are| did i (?:save|put|download|leave))|find(?: me)? (?:the )?(?:path|location)(?: of| to)?)\b/i;
const CREDENTIAL_ASK =
    /\b(?:log(?:\s*in)?(?:to)?|login|sign(?:\s*in)?(?:to)?)\b[^.]{0,50}\b(?:account|bank|banking|balance|monzo|password|credentials?)\b|\b(?:my|the)\s+(?:bank|banking)\s+(?:account|balance|app)\b|\bcheck my (?:bank )?balance\b|\b(?:enter|type|fill in|use) my (?:password|pin|card (?:number|details)|credentials)\b/i;
const MAIL_QUESTION = /\b(?:e-?mails?|inbox|mailbox|gmail|outlook)\b/i;
const MAIL_CHECK =
    /^(?:please\s+)?(?:check|look (?:in|at|through)|see|search|go through|scan)\b[^.]{0,40}\b(?:e-?mails?|inbox|mailbox|gmail|outlook)\b/i;
const ORDER_STATUS =
    /\b(?:order|parcel|package|delivery|shipment|refund)\b[^.]{0,60}\b(?:shipped|dispatched|arrived|delivered|on its way|status|refunded|been sent)\b|\bhas my (?:order|parcel|package|delivery)\b/i;
const MAIL_MUTATION =
    /^(?:please\s+)?(?:send|email|e-mail|mail|tell|message|text|reply|respond|draft|compose|write|forward|delete|archive|mark|unsubscribe)\b|\b(?:reply|respond|forward|draft|compose|send)\s+(?:to|a|an|the|it|him|her|them)\b/i;
const CALENDAR_WEEK =
    /\b(?:calendar|agenda|schedule|diary)\b[^.]*\b(?:this|next|the|coming) week\b|\b(?:this|next|the|coming) week\b[^.]*\b(?:calendar|agenda|diary)\b/i;
const CALENDAR_WRITE_SHAPE = /\b(?:create|book|schedule|add|put|set\s+up|delete|remove|cancel|move|clear)\b/i;
const OWN_MAIL_ASK =
    /^(?:please\s+)?(?:tell|email|e-mail|mail|message|write to|reply to|respond to|draft)\b(?![^.]*\b(?:his|her|their|someone else'?s?|\w+'s)\s+(?:e-?mail|account|inbox|mailbox|machine|computer|phone|password|credentials))/i;

function mailSearchTerms(text) {
    const quoted = /["\u201c]([^"\u201d]{3,80})["\u201d]/.exec(text);
    if (quoted) return quoted[1].trim();
    const body = String(text).replace(/^\s*\S+/, '');
    const runs = body.match(/\b[A-Z][\w'&-]*(?:\s+(?:of|the|and|for|de|du|von)\s+[A-Z][\w'&-]*|\s+[A-Z][\w'&-]*)*/g) || [];
    const best = runs.map(r => r.trim()).sort((a, b) => b.length - a.length)[0];
    return best && best.length >= 3 ? best : null;
}

function locateByName(text) {
    const fileIndex = require('./fileIndex');
    const noise = new Set([...DELIVERY_NOISE, 'where', 'is', 'are', 'did', 'save', 'put', 'download', 'leave',
        'find', 'path', 'location', 'letter', 'document', 'doc', 'folder']);
    const words = String(text).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 2 && !noise.has(w));
    if (!words.length) return [];
    let rows = [];
    try { rows = fileIndex.search({ text: words.join(' '), limit: 30 }); } catch { return []; }
    const need = words.length === 1 ? 1 : Math.ceil(words.length * 0.6);
    const carrying = rows.filter(row => {
        const name = String(row.name || '').toLowerCase();
        return words.filter(w => name.includes(w)).length >= need;
    });
    return carrying.slice(0, 3).map(row => ({ name: row.name, path: row.path }));
}

const withoutPaths = (text) => String(text).replace(/(?:~|\/)[^\s"']*/g, ' ');

function deliverByName(intentText) {
    const fileIndex = require('./fileIndex');
    const classifier = require('../security/classifier');
    const words = intentText.toLowerCase().split(/[^a-z0-9.]+/).filter(w => w.length >= 2 && !DELIVERY_NOISE.has(w));
    const ask = () => ({ status: 'needs_clarification', action: 'clarify',
        response: 'I could not tell which file you mean. Which file should I send?', decision: { action: 'clarify' } });
    if (!words.length) return ask();
    let hits = [];
    try {
        const share = (f) => words.filter(w => String(f.name).toLowerCase().includes(w)).length / words.length;
        const enough = (f) => words.length === 1 ? share(f) === 1 : (share(f) >= 0.6 && share(f) * words.length >= 2);
        hits = fileIndex.search({ text: words.join(' '), limit: 12 })
            .filter(enough)
            .filter(f => securityStore.isWithinGrantedRoot(f.path, 'documents'));
    } catch { hits = []; }
    const secret = hits.find(f => classifier.secretCheck(f.path).secret);
    if (secret) {
        return { status: 'refused', action: 'refused',
            response: `I won't send ${secret.name}: it looks like credential material.` };
    }
    if (!hits.length) return ask();
    const plural = /\b(both|all|every|two|these|those|each)\b/i.test(intentText) || /\b\w+s\b/.test(words.join(' ')) && hits.length === 2;
    const chosen = plural ? hits.slice(0, 3) : (hits.length === 1 ? hits : []);
    if (!chosen.length) {
        const names = hits.slice(0, 5).map(f => f.name).join(', ');
        return { status: 'needs_clarification', action: 'clarify',
            response: `Which one do you mean: ${names}?`, decision: { action: 'clarify' } };
    }
    console.log(`[Bridge] Delivering by name: ${chosen.map(f => f.name).join(', ')}`);
    const files = chosen.map(f => ({ name: f.name, path: f.path }));
    return { status: 'success', action: 'delivered', response: `Attached ${files.map(f => f.name).join(', ')}.`, artifacts: { files } };
}

function maybeProposeGeneration(intentText, gaps, options = {}) {
    if (DELIVERY_ASK.test(intentText.trim()) && !NAMES_A_RECIPIENT.test(intentText)) {
        return deliverByName(intentText);
    }
    if (NEEDS_THE_BROWSER.test(withoutPaths(intentText))) {
        const why = gaps.length ? gaps.join('; ') : 'the browse lane could not finish it';
        return { status: 'error', action: 'web',
            response: `I could not do that in the browser: ${why}.` };
    }
    if (!profile.improvementEnabled()) {
        return { status: 'refused', action: 'generation_off',
            response: 'Building new skills is switched off. Turn on self-improvement in settings if you want me to learn this.' };
    }
    if (!llmClient.modelForTier('smith')) {
        return { status: 'refused', action: 'no_builder',
            response: 'This machine doesn\'t run a builder model — its memory class is too small to write new skills. Everything already installed keeps working.' };
    }
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

function executeIntent(intentText, options = {}) {
    if (!options.private) return executeIntentRecorded(intentText, options);
    return require('./incognito').privately(() => executeIntentRecorded(intentText, options));
}

async function executeIntentRecorded(intentText, options = {}) {
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
    if (Array.isArray(options.history) && options.history.length
        && asked === intentText && DEPENDENT_FRAGMENT.test(intentText.trim())) {
        return {
            status: 'needs_clarification',
            action: 'clarify',
            response: 'I am not sure what that refers to. Which file or folder do you mean?',
            decision: { action: 'clarify' },
            durationMs: Date.now() - startedAt
        };
    }
    // The resolved ask before any notes join it: the gates below match on
    // what the user actually said, not on appended file paths.
    const plainAsk = asked;
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
    // "What does it say?" after a delivery means the file, even though no
    // file-word survives the sentence: a content question with a bare
    // pronoun counts when the chat has files in hand.
    const asksAboutIt = CONTENT_QUESTION.test(plainAsk)
        && /\b(it|this|that|these|those)\b/i.test(plainAsk);
    const wantsFiles = !attached.length && recent.length > 0
        && (REFERENCES_FILES.test(asked) || asksAboutIt);
    if (wantsFiles) {
        asked += `\n\n(Files earlier in this chat: ${recent.map(f => f.path).join(', ')})`;
    }
    // A tiny conversational ask never deserves the skill factory: no digits,
    // no action verb, no file in hand — it goes straight to the answer path
    // before triage can dream bigger.
    // A question about a file already in this conversation is answered from
    // that file's own text, with the chat as context. It never reaches
    // triage: the skill factory cannot read anything the corpus cannot.
    const inHand = attached.length ? attached : (wantsFiles ? recent : []);
    const pronounOnly = /\b(that|it|this)\b/i.test(plainAsk)
        && plainAsk.trim().split(/\s+/).length <= 5;
    if (DELIVERY_ASK.test(plainAsk) && !NAMES_A_RECIPIENT.test(plainAsk) && recent.length
        && (REFERENCES_FILES.test(plainAsk) || pronounOnly)) {
        const generic = new Set(['report', 'pdf', 'file', 'document', 'the']);
        const askTokens = plainAsk.toLowerCase().split(/[^a-z0-9]+/)
            .filter(t => t.length >= 3 && !generic.has(t));
        const named = recent.filter(f => askTokens.some(t =>
            String(f.name || '').toLowerCase().includes(t)));
        const pronouny = /\b(that|it|this)\b/i.test(plainAsk);
        const targets = named.length ? named.slice(-2)
            : (pronouny ? [recent[recent.length - 1]] : []);
        const fsNode = require('fs');
        const deliverable = targets.filter(f => {
            try {
                return f && f.path
                    && securityStore.isWithinGrantedRoot(f.path, 'documents')
                    && fsNode.statSync(f.path).isFile();
            } catch { return false; }
        });
        if (deliverable.length) {
            console.log('[Bridge] Delivering the file in hand directly.');
            const files = deliverable.map(f =>
                ({ name: f.name || path.basename(f.path), path: f.path }));
            return {
                status: 'success',
                response: `Attached ${files.map(f => f.name).join(', ')}.`,
                action: 'delivered',
                artifacts: { files },
                durationMs: Date.now() - startedAt
            };
        }
    }
    if (inHand.length && CONTENT_QUESTION.test(plainAsk)
        && !MUTATES_FILE.test(plainAsk)) {
        const pinned = attachmentPassages(inHand);
        if (pinned.length) {
            console.log('[Bridge] Question about a file in hand; answering from it.');
            let answered = await answerService.answer(asked,
                { passages: pinned, history: options.history });
            if (answered.is_successful && answered.refused) {
                const named = inHand[0] && (inHand[0].name || path.basename(inHand[0].path));
                const spelled = named
                    ? asked.replace(/\b(it|this|that)\b/i, `the file "${named}"`) : asked;
                const again = await answerService.answer(spelled,
                    { passages: pinned, history: options.history, temperature: 0 });
                if (again.is_successful && !again.refused) answered = again;
            }
            if (answered.is_successful) {
                return {
                    status: 'success',
                    response: answered.text,
                    action: 'answered',
                    grounded: answered.grounded,
                    refused: Boolean(answered.refused),
                    sources: answered.sources,
                    artifacts: { files: inHand.slice(0, 2).map(f =>
                        ({ name: f.name || path.basename(f.path),
                           path: f.path })) },
                    durationMs: Date.now() - startedAt
                };
            }
        }
    }
    const conversationStore = require('./conversationStore');
    if (!inHand.length && conversationStore.RECALL_SHAPE.test(plainAsk)
        && !MUTATES_FILE.test(plainAsk)) {
        let recalled = await answerService.answer(asked, { history: options.history });
        if (recalled.is_successful && recalled.grounded && recalled.refused) {
            const again = await answerService.answer(
                `${asked}\n\n(The retrieved passages are things I said in earlier chats with you. Tell me what I said there, quoting the detail I am asking about.)`,
                { history: options.history, temperature: 0 });
            if (again.is_successful && again.grounded && !again.refused) recalled = again;
        }
        if (recalled.is_successful && recalled.grounded && !recalled.refused) {
            console.log('[Bridge] Recall question; answered from earlier chats.');
            return {
                status: 'success',
                response: recalled.text,
                action: 'answered',
                grounded: true,
                sources: recalled.sources,
                durationMs: Date.now() - startedAt
            };
        }
        if (recalled.is_successful) {
            const best = (recalled.passages || []).find(p => /^The user said: /.test(p.text));
            console.log(`[Bridge] Recall question; ${best ? 'quoting the earlier chat' : 'nothing found in earlier chats'}.`);
            return {
                status: 'success',
                response: best
                    ? `Here is what you said in an earlier chat: "${best.text.replace(/^The user said: /, '')}" (${best.cite}).`
                    : 'I have nothing from our earlier chats about that.',
                action: 'answered',
                grounded: Boolean(best),
                sources: best ? [best.cite] : [],
                durationMs: Date.now() - startedAt
            };
        }
    }
    if (!inHand.length && CONTENT_QUESTION.test(plainAsk) && /\?\s*$/.test(plainAsk.trim())
        && !MUTATES_FILE.test(plainAsk) && !MAIL_QUESTION.test(plainAsk)
        && !conversationStore.RECALL_SHAPE.test(plainAsk)) {
        let remembered = [];
        try { remembered = await conversationStore.answerSource.retrieve(plainAsk); } catch { remembered = []; }
        if (remembered.some(p => /^The user said: /.test(p.text))) {
            const answered = await answerService.answer(asked,
                { passages: remembered, history: options.history, temperature: 0 });
            if (answered.is_successful && answered.grounded && !answered.refused) {
                console.log('[Bridge] Question answered from an earlier chat.');
                return {
                    status: 'success',
                    response: answered.text,
                    action: 'answered',
                    grounded: true,
                    sources: answered.sources,
                    durationMs: Date.now() - startedAt
                };
            }
        }
    }
    if (!inHand.length && NOTE_ASK.test(plainAsk) && !/\?\s*$/.test(plainAsk)) {
        console.log('[Bridge] A note for the record; acknowledged.');
        return {
            status: 'success',
            response: 'Noted.',
            action: 'answered',
            grounded: true,
            durationMs: Date.now() - startedAt
        };
    }
    if (!inHand.length && WHERE_IS.test(plainAsk) && !MUTATES_FILE.test(plainAsk)) {
        const located = locateByName(plainAsk);
        if (located.length) {
            console.log('[Bridge] Location question; answered from the index.');
            return {
                status: 'success',
                response: located.length === 1
                    ? `It is at ${located[0].path}.`
                    : `I found ${located.length}:\n${located.map(f => `- ${f.path}`).join('\n')}`,
                action: 'answered',
                grounded: true,
                sources: located.map(f => `file: ${f.name}`),
                artifacts: { files: located.map(f => ({ name: f.name, path: f.path })) },
                durationMs: Date.now() - startedAt
            };
        }
    }
    if (CREDENTIAL_ASK.test(plainAsk)) {
        console.log('[Bridge] Credential boundary; refusing.');
        return {
            status: 'refused',
            response: 'I won\'t log into an account for you: signing in needs your password, and I never handle credentials or payment details. Open it yourself and I can help from there.',
            action: 'refused',
            decision: { action: 'refuse', reasoning: 'credential boundary' },
            durationMs: Date.now() - startedAt
        };
    }
    const mailQuestion = !inHand.length
        && ((CONTENT_QUESTION.test(plainAsk) && MAIL_QUESTION.test(plainAsk))
            || MAIL_CHECK.test(plainAsk) || ORDER_STATUS.test(plainAsk))
        && !MAIL_MUTATION.test(plainAsk)
        && !conversationStore.RECALL_SHAPE.test(plainAsk);
    const calendarWeek = !inHand.length && CALENDAR_WEEK.test(plainAsk)
        && !MAIL_MUTATION.test(plainAsk) && !CALENDAR_WRITE_SHAPE.test(plainAsk);
    if (mailQuestion || calendarWeek) {
        const mailProvider = require('./mailProvider');
        const account = mailProvider.forRequest(plainAsk, require('../utils/configReader').readConfig());
        const terms = calendarWeek ? null : mailSearchTerms(plainAsk);
        const url = calendarWeek
            ? (/google/.test(account.calendar) ? 'https://calendar.google.com/calendar/u/0/r/week' : account.calendar)
            : ((terms && mailProvider.searchUrl(account.url, terms)) || account.url);
        console.log(`[Bridge] ${calendarWeek ? 'Calendar week' : `Mail question (${terms || 'inbox'})`}; reading the signed-in site.`);
        const webAgent = require('./webAgent');
        const browsed = await webAgent.browse(plainAsk,
            { url, request: plainAsk, readOnly: true, ...(options.signal ? { signal: options.signal } : {}) });
        const unanswered = /\b(?:found nothing|does not (?:display|show|contain)|no (?:e-?mail|message|event)s?\b[^.]{0,30}\b(?:content|found|visible|shown))\b/i;
        if (browsed.status === 'success' && browsed.answer && !unanswered.test(browsed.answer)) {
            return {
                status: 'success',
                response: browsed.answer,
                action: 'web',
                durationMs: Date.now() - startedAt
            };
        }
        return {
            status: 'error',
            response: `I could not read that from ${calendarWeek ? 'the calendar' : 'your mail'}`
                + (browsed.reason ? `: ${browsed.reason}` : '') + '.',
            action: 'web',
            durationMs: Date.now() - startedAt
        };
    }
    if (!inHand.length && CONTENT_QUESTION.test(plainAsk)
        && REFERENCES_FILES.test(plainAsk) && !MUTATES_FILE.test(plainAsk)) {
        const answered = await answerService.answer(asked,
            { history: options.history });
        if (answered.is_successful && answered.grounded && !answered.refused
            && !DISCLAIMS_THE_WEB.test(answered.text || '')) {
            console.log('[Bridge] Content question; grounded answer stands.');
            return {
                status: 'success',
                response: answered.text,
                action: 'answered',
                grounded: true,
                sources: answered.sources,
                ...sourceArtifacts(answered.sources),
                durationMs: Date.now() - startedAt
            };
        }
    }
    const CALENDAR_WRITE =
        /\b(create|book|schedule|add|put|set\s+up)\s+(?:a|an|the|new|this|that|my)?\s*(?:calendar\s+)?(event|meeting|appointment)\b|\b(add|put)\b[^.]{0,40}\b(?:to|on|in)\s+(?:my\s+)?calendar\b/i;
    const calendarAsk = CALENDAR_WRITE.test(intentText) ? intentText
        : (CALENDAR_WRITE.test(plainAsk) ? plainAsk : null);
    if (calendarAsk
        && !/\b(delete|remove|cancel|clear)\b/i.test(calendarAsk)) {
        console.log('[Bridge] Calendar write; sending the browse lane.');
        const webAgent = require('./webAgent');
        const plan = calendarTemplate(calendarAsk);
        console.log(`[Bridge] calendar ask: "${calendarAsk}" -> `
            + (plan ? plan.url : 'no template'));
        const browsed = await webAgent.browse(
            plan
                ? `Book this event onto my calendar: ${plan.title}, `
                    + `${plan.when}. The form is already filled in; save it.`
                : asked,
            {
                url: plan ? plan.url : 'https://calendar.google.com/calendar/u/0/r',
                ...(options.signal ? { signal: options.signal } : {})
            });
        if (plan) {
            const chipEvidence = browsed.status === 'success' && plan.titled
                && String(browsed.answer || '').toLowerCase().includes(plan.title.toLowerCase());
            if (chipEvidence) {
                console.log('[Bridge] booking confirmed by the grid chip.');
                return {
                    status: 'success',
                    response: `Booked: ${plan.title}, ${plan.when}. `
                        + `It is on the calendar.`,
                    action: 'web',
                    durationMs: Date.now() - startedAt
                };
            }
            const check = await webAgent.browse(
                `Is there an event called ${plan.title} in my calendar `
                    + `between ${plan.when.replace(' to ', ' and ')} today?`,
                { url: plan.dayUrl,
                  ...(options.signal ? { signal: options.signal } : {}) });
            const answerText = String(check.answer || '');
            const seen = check.status === 'success'
                && (/\byes\b/i.test(answerText)
                    || answerText.toLowerCase()
                        .includes(plan.title.toLowerCase()));
            console.log(`[Bridge] booking verify: ${check.status} / `
                + String(check.answer || check.reason || '').slice(0, 120));
            return {
                status: seen ? 'success' : 'error',
                response: seen
                    ? `Booked: ${plan.title}, ${plan.when}. I checked the `
                        + `calendar and it is there.`
                    : `I tried to book "${plan.title}" but could not confirm `
                        + `it on the calendar afterwards`
                        + (browsed.reason ? ` (${browsed.reason})` : '') + '.',
                action: 'web',
                durationMs: Date.now() - startedAt
            };
        }
        return {
            status: browsed.status === 'success' ? 'success' : 'error',
            response: browsed.answer
                || (browsed.status === 'success'
                    ? 'Done.' : browsed.reason || 'The calendar could not be updated.'),
            action: 'web',
            durationMs: Date.now() - startedAt
        };
    }
    if (!attached.length && isSmallTalk(asked)) {
        console.log('[Bridge] Small ask; answering directly.');
        const answered = await answerService.answer(asked, { history: options.history });
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
    const routeTraceId = routerTraces.record(asked, decision);
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
            if (OWN_MAIL_ASK.test(plainAsk) && !CREDENTIAL_ASK.test(plainAsk)) {
                console.log('[Bridge] Router refused a message from the user\'s own mailbox; composing instead.');
                outcome = await composeThenGenerate(asked, options);
                break;
            }
            outcome = {
                status: 'refused',
                response: plainRefusal(decision.reasoning),
                action: 'refused'
            };
            break;

        case router.ACTIONS.CLARIFY:
            outcome = {
                status: 'needs_clarification',
                response: decision.missing_parameters && decision.missing_parameters.length
                    ? `I can do that with ${decision.target_skill}, but I need one more thing: `
                        + decision.missing_parameters.map(e => String(e).split(' — ')[1] || String(e)).join('; ') + '.'
                    : decision.is_successful
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
            const answered = await answerService.answer(asked, {
                ...(pinned.length ? { passages: pinned } : {}),
                history: options.history
            });
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
    composeThenGenerate, isRealComposition, maybeProposeGeneration, maybeDelegate,
    calendarTemplate,
    mailSearchTerms,
    GATES: { NOTE_ASK, WHERE_IS, CREDENTIAL_ASK, MAIL_QUESTION, MAIL_CHECK, ORDER_STATUS, MAIL_MUTATION, CALENDAR_WEEK, OWN_MAIL_ASK }
};
