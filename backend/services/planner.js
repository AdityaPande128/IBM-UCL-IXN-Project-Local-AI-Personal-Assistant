const configReader = require('../utils/configReader');
const llmClient = require('./llmClient');
const capabilityGraph = require('./capabilityGraph');
const skillRetriever = require('./skillRetriever');
const mailProvider = require('./mailProvider');
const negativeMemory = require('./negativeMemory');
const { extractJson } = require('../utils/jsonRepair');

const config = configReader.readConfig();
const plannerConfig = config.planner || {};

const MAIL_URL = mailProvider.current(config).url;
const CALENDAR_URL = mailProvider.current(config).calendar;

// When the user holds more than one mailbox, the request itself picks the
// account ("work mail" goes to the work account); everything else lands on
// the default. The chosen URL is what the prompt below steers messages at.
function mailUrlFor(request) {
    return mailProvider.forRequest(request, config).url;
}

// The calendar rides the mail account: whichever mailbox a request steers to
// is the account whose calendar "my calendar" means.
function calendarUrlFor(request) {
    return mailProvider.forRequest(request, config).calendar;
}

const TIER = 'engine';
const TEMPERATURE = plannerConfig.temperature ?? 0.0;
const MAX_TOKENS = plannerConfig.max_tokens ?? 700;
const TIMEOUT_MS = plannerConfig.timeout_ms ?? 60000;
const MAX_ATTEMPTS = plannerConfig.max_attempts ?? 2;

const retrievalConfig = config.retrieval || {};
const PROCEDURE_TOP_K = retrievalConfig.procedure_top_k ?? 2;
const PROCEDURE_MIN_SCORE = retrievalConfig.procedure_min_score ?? 0.5;

const MAX_STEPS = plannerConfig.max_steps ?? 6;

const STEP_ID = /^[a-z][a-z0-9_]*$/i;
const REFERENCE = /^\$([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$/i;

const PLACEHOLDER =
    /\$\(|\$\{|<[a-z_ ]+>|%[a-z_]+%|\byour[-_ ]|\busername\b|\/path\/to\/|\bexample\.com\b/i;

// The mailbox is not a phone and the calendar is not a booking desk. A model
// tempted by the one URL it knows will steer "text my sister" or "book me a
// table" at the mail provider; naming what went wrong teaches the retry to
// declare the gap instead. "text" counts only with a recipient after it —
// "the text of my speech" is a noun and mails fine.
const STEERED = new Set(Object.values(mailProvider.PROVIDERS)
    .flatMap(provider => [provider.url, provider.calendar])
    .map(url => new URL(url).hostname));
const OTHER_CHANNEL =
    /\btext(?:s|ing|ed)?\s+(?:me|him|her|them|us|(?:my|our|your|the)\s+\w+)\b|\b(?:sms|i-?message|whatsapp|telegram|slack|discord)\b/i;
const NOT_AN_EVENT =
    /\b(?:book|books|booking|reserve|reserves|reserving|reservation)\s+(?:me\s+|us\s+)?(?:a|an|the|some|two|three|\d+)?\s*(?:tables?|restaurants?|flights?|hotels?|taxis?|cabs?|seats?|tickets?)\b/i;

// Mirrors rule 7a: what a file's name and metadata already answer. Only a
// question of this shape lets a plan end at found paths.
const LOCATING =
    /\bwhere\b|\bwhich (?:folder|directory|drive)\b|\bwhether\b|\bexists?\b|\b(?:is|are) there\b|\bhow (?:many|big|large|old|recent)\b|\bwhen (?:did|was)\b[^?]{0,30}\b(?:chang|modif|creat|sav|updat|touch)/i;


function procedureRule(capabilities) {
    if (!capabilities.some(capability => capability.kind === 'procedure')) return '';

    return `7c. A "procedure." capability is one this system worked out for itself by doing
   the job the slow way more than once. It is much faster. Use it when it
   describes what is being asked; otherwise use web.browse.
`;
}

function today() {
    return new Date().toLocaleDateString('en-GB',
        { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function buildPlanPrompt(capabilities, mailUrl = MAIL_URL, calendarUrl = CALENDAR_URL) {
    return `You are the planner for a local macOS assistant. You are given a request and the complete list of operations this machine can perform. You produce a plan: an ordered list of steps that carries the request out.

WHO IS ASKING: the person making this request owns this Mac and is its only user.
You are software running on their own computer at their own request. A request to
look at their own files, mail or settings is authorised by being made.

TODAY IS ${today()}. Requests are full of "the 15th", "Saturday" and "tomorrow",
and a step that has to be given a date cannot be filled in without knowing which
day it is now.

You MUST respond with ONLY a valid JSON object matching this exact schema — no markdown fences, no commentary, no preamble:
{
  "goal": "<one sentence restating what the user wants, in your own words>",
  "steps": [
    {
      "id": "s1",
      "capability": "<exactly one id from the list below>",
      "inputs": { "<input name>": <value or reference> },
      "reason": "<short phrase: why this step>"
    }
  ],
  "missing": ["<description of anything the list below cannot do>"]
}

THE OPERATIONS AVAILABLE. You may use nothing else:

${capabilityGraph.describe(capabilities)}

HOW STEPS CONNECT

A step uses an earlier step's result by referring to it as a string of the form
"$<step id>.<output name>", using the output names shown in {braces} above.

  {"id":"s1","capability":"files.search","inputs":{"text":"boiler service"}}
  {"id":"s2","capability":"files.read","inputs":{"paths":"$s1.paths"}}
  {"id":"s3","capability":"answer","inputs":{"question":"When was the boiler serviced?","passages":"$s2.passages"}}

A reference must point at a step that comes BEFORE it. Referring forwards, or to
a step id that does not exist, is invalid.

RULES

1. Use only the capability ids listed above, copied exactly. Do not invent one,
   do not guess at one that "should" exist, and do not abbreviate.
2. If part of the request cannot be done with the list above, do NOT approximate
   it with something else. A capability that measures a different quantity of
   the same subject is an approximation, not a match: one that reports how much
   RAM is installed does not answer how much is in use right now, and one that
   reports a disk's total size does not answer what is filling it. Leave it out
   of "steps" and describe it in "missing".
   Saying you cannot do something is a correct answer; pretending is not.
3. Use the fewest steps that do the job, and no more. At most ${MAX_STEPS}. If a
   single operation does the whole thing, the plan is that one step. Never add a
   step to prepare, verify, double-check or tidy up first: these operations are
   reliable and do not need supervising, and every extra step is another chance
   to do something the user did not ask for.
4. Supply every input marked with "!" — those are required.
5. Only reference an output name that appears in {braces} for that capability.
6. If the request needs a file that the user did not give a full path for, find
   it with files.search first. Guessing a path is not a plan. Never write a
   placeholder path like "/Users/<username>/Documents" — you do not know the
   user's home directory, and a folder filter that matches nothing is worse than
   no filter at all. Only pass "dir" when the user actually named a folder.
7. The final step should produce something the user can read. When the request
   ends in a question, that is usually "answer" — but a skill reports its own
   result, so a skill that already does the whole job needs no files.search
   before it and no "answer" after it. Its output IS the reply.
7a. Open as little as possible. files.search already knows every file's name,
   folder, size and date, so questions about WHERE a file is, WHEN it changed,
   HOW BIG it is or WHETHER it exists need only files.search. Use files.read
   only when the answer depends on what is written INSIDE the file. Opening the
   user's documents to answer something their names already answer is an
   intrusion, not thoroughness.
7b. The web is for things that are ON the web. Use web.read when the user gives
   a URL or names a specific page. Use web.browse when reaching the answer needs
   searching a site, following links or filling in a form. Do NOT use either for
   files on this Mac, and do NOT use them to look up general knowledge — "answer"
   already knows ordinary facts, and opening a browser to confirm one is slow and
   pointless. A site web.browse lists as signed in is the user's own account
   there: their mail, their messages, their orders and their calendar live on it
   and not in their files, so "my inbox", "my account", "my orders" mean that
   site — plan a web.browse starting at the address it gives, and do not send
   files.search looking for them. Start it at the site the question is ABOUT:
   what the user is doing, where they have to be or what time something is on a
   date starts at their calendar, and who wrote what starts at their mail.
   PUTTING something on the calendar — "book a meeting", "schedule a call",
   "add it to my calendar", even an event whose details sit in an email —
   starts at the user's calendar, ${calendarUrl}, one web.browse whose goal is
   the user's request carried through unchanged: their exact words are what
   authorises saving the event, and a paraphrase loses that authority. An
   order, a delivery or a booking from a company starts at their MAIL too — the
   confirmation and the dispatch note were emailed to them — and not at that
   company's website, which nobody is signed in to and which the browser is
   refused. Only a company on the signed-in list above is a place to start.
   One browse either way — looking somewhere else as well is something it does
   for itself when the first place has nothing. Neither web operation will fill a password or
   payment field, so a goal needing an account nobody is signed in to is
   "missing". Sending or replying to a message on a signed-in site is NOT
   missing — carry the user's own words into the goal, because what they asked
   for is what authorises pressing Send.
7d. Whether a person has REPLIED or written back is never a search. It is a
   comparison — what they sent against what the user sent — and only web.browse
   does it. A search shows what matches a word; it cannot tell you that nothing
   newer arrived, which is the answer that question usually has. "has she
   replied", "did he get back to me", "any response from ..." are all web.browse
   on the signed-in mail site, whatever recipes are on offer.
7c. Saying something to a person is a message, and a message is web.browse on the
   signed-in site that carries the user's mail — ${mailUrl}. "Tell Ingrid ...", "let Sam
   know ...", "reply to ...", "respond to ...", "write back to ...", "draft a
   reply to ..." are all that one shape, whoever is named and whatever verb is
   used. Two wrong answers to avoid, both measured:
     "missing" — planned for "tell Ingrid to meet me at 9" on the grounds that
       nothing can send a message or arrange a meeting. Something can: the
       browser is signed in to the user's mail, and that is where a person
       writes to another person.
     an "answer" step — planned for "draft a reply to Ingrid". That writes the
       words into a reply to the USER and delivers nothing to anybody. The
       request is to put them in the mailbox, so the step is web.browse.
   Pass the user's request through into the browse goal unchanged, including any
   words they quoted: those exact words are what is to be typed.
${procedureRule(capabilities)}8. "missing" is [] when the list above covers everything.
9. Every step must matter. Its result must be used by a later step, OR it must
   change something on the machine, OR it must be the final step producing an
   answer. Never include a step whose result goes nowhere. In particular, when
   you cannot finish a job, do not plan the first half of it anyway: gathering
   material for an operation you do not have is wasted work and opens the user's
   files for nothing. Leave those steps out and put the job in "missing".

EXAMPLES

  "what does my thesis outline say about chapter three"
  -> {"goal":"Report what the thesis outline says about chapter three",
      "steps":[
        {"id":"s1","capability":"files.search","inputs":{"text":"thesis outline"},"reason":"locate the file"},
        {"id":"s2","capability":"files.read","inputs":{"paths":"$s1.paths"},"reason":"read it"},
        {"id":"s3","capability":"answer","inputs":{"question":"What does the outline say about chapter three?","passages":"$s2.passages"},"reason":"answer from what it says"}],
      "missing":[]}

  "turn the volume down and tell me what a mutex is"
  -> {"goal":"Lower the volume, then explain what a mutex is",
      "steps":[
        {"id":"s1","capability":"skill.system-volume","inputs":{"level":0.3},"reason":"lower the volume"},
        {"id":"s2","capability":"answer","inputs":{"question":"What is a mutex?"},"reason":"answer the question"}],
      "missing":[]}

  "what does https://example.org/pricing say the plans cost"
  -> {"goal":"Report the prices listed on that page",
      "steps":[
        {"id":"s1","capability":"web.read","inputs":{"url":"https://example.org/pricing"},"reason":"read the page"},
        {"id":"s2","capability":"answer","inputs":{"question":"What do the plans cost?","passages":"$s1.passages"},"reason":"answer from the page"}],
      "missing":[]}

  "find out when the next train to Brighton leaves"
  -> {"goal":"Find the next departure to Brighton",
      "steps":[
        {"id":"s1","capability":"web.browse","inputs":{"goal":"Find the time of the next train to Brighton","url":"https://www.nationalrail.co.uk"},"reason":"search the timetable"}],
      "missing":[]}
     (one step: web.browse reports what it found, so it needs no "answer" after it.)

  "tell Ingrid to meet me at Primrose Hill at 9 PM"
  -> {"goal":"Tell Ingrid to meet at Primrose Hill at 9 PM",
      "steps":[
        {"id":"s1","capability":"web.browse","inputs":{"goal":"tell Ingrid to meet me at Primrose Hill at 9 PM","url":"${mailUrl}"},"reason":"write to Ingrid from the user's mail"}],
      "missing":[]}
     (not "missing": the browser is signed in to the user's mail, and that is
      where one person writes to another.)

  "draft a reply to Ingrid saying \\"Sounds good to me\\""
  -> {"goal":"Draft a reply to Ingrid saying \\"Sounds good to me\\"",
      "steps":[
        {"id":"s1","capability":"web.browse","inputs":{"goal":"draft a reply to Ingrid saying \\"Sounds good to me\\"","url":"${mailUrl}"},"reason":"open the reply and write it"}],
      "missing":[]}
     (not "answer": the words go into the mailbox, not into a reply to the user.)

  "post this to my company Slack"
  -> {"goal":"Post a message to the user's Slack",
      "steps":[],
      "missing":["sending a message to Slack — nothing here can reach it"]}

  "convert the photos on my desktop to jpeg"
  -> {"goal":"Convert the photos on the Desktop to JPEG",
      "steps":[],
      "missing":["converting an image from one format to another"]}
     (finding the photos is not planned, because without a converter nothing
      would be done with them.)`;
}

const REPAIR_INSTRUCTION =
    'That plan was rejected: %ERRORS%. Return ONLY the corrected JSON object, ' +
    'with no // comments. Use capability ids exactly as they appear in the ' +
    'list, and make every "$step.output" reference point at an earlier step ' +
    'and a real output name. If you named a capability that is not in the ' +
    'list, DELETE that step rather than looking for a substitute — if the job ' +
    'genuinely needs it, put it in "missing" instead, and do the same when ' +
    'nothing in the list truly performs the job: a skill does exactly what ' +
    'its description says, never something merely like it.';


function referencesIn(value, found = []) {
    if (typeof value === 'string') {
        const match = value.match(REFERENCE);
        if (match) found.push({ step: match[1], output: match[2], raw: value });
    } else if (Array.isArray(value)) {
        for (const item of value) referencesIn(item, found);
    } else if (value && typeof value === 'object') {
        for (const item of Object.values(value)) referencesIn(item, found);
    }
    return found;
}

function validatePlan(parsed, { graph = capabilityGraph, maxSteps = MAX_STEPS, question = '' } = {}) {
    const errors = [];
    const repairs = [];
    const missing = [];

    if (!parsed || typeof parsed !== 'object') {
        return { valid: false, errors: ['plan did not parse to an object'], repairs, missing };
    }
    if (typeof parsed.goal !== 'string' || !parsed.goal.trim()) {
        errors.push('missing_field:goal');
    }
    const declaredMissing = Array.isArray(parsed.missing)
        ? parsed.missing.filter(m => typeof m === 'string' && m.trim()).map(m => m.trim())
        : [];

    if (!Array.isArray(parsed.steps)) {
        return {
            valid: false, errors: [...errors, 'missing_field:steps'],
            repairs, missing, declaredMissing
        };
    }
    if (parsed.steps.length > maxSteps) {
        errors.push(`too_many_steps:${parsed.steps.length}>${maxSteps}`);
    }

    const seen = new Map();
    const consumed = new Set();

    parsed.steps.forEach((step, index) => {
        const where = `steps[${index}]`;

        if (!step || typeof step !== 'object') {
            errors.push(`${where}: not an object`);
            return;
        }
        if (!step.id || !STEP_ID.test(String(step.id))) {
            errors.push(`${where}: invalid step id "${step.id}"`);
            return;
        }
        if (seen.has(step.id)) {
            errors.push(`${where}: duplicate step id "${step.id}"`);
            return;
        }

        const resolved = graph.resolveId(step.capability);
        if (!resolved) {
            missing.push(String(step.capability));
            errors.push(`unknown_capability:${step.capability}`);
            seen.set(step.id, null);
            return;
        }
        if (resolved !== step.capability) {
            repairs.push(`capability_name:${step.capability}->${resolved}`);
            step.capability = resolved;
        }

        const capability = graph.get(resolved);
        const inputs = (step.inputs && typeof step.inputs === 'object' && !Array.isArray(step.inputs))
            ? step.inputs
            : {};
        step.inputs = inputs;

        for (const reference of referencesIn(inputs)) {
            consumed.add(reference.step);
            if (!seen.has(reference.step)) {
                errors.push(`${where}: reference "${reference.raw}" does not name an earlier step`);
                continue;
            }
            const producer = seen.get(reference.step);
            if (producer && !(reference.output in producer.outputs)) {
                errors.push(
                    `${where}: "${reference.raw}" — ${reference.step} (${producer.id}) ` +
                    `produces ${Object.keys(producer.outputs).join(', ')}`
                );
            }
        }

        // A model that invents an input name usually decorated a real one —
        // "input_directory" for "directory". When the real name is missing
        // and the invented key contains it, the value moves across rather
        // than the plan bouncing.
        for (const key of Object.keys(inputs)) {
            if (key in capability.inputs) continue;
            const meant = Object.entries(capability.inputs).find(([name, io]) =>
                io.required
                && (inputs[name] === undefined || inputs[name] === null || inputs[name] === '')
                && (key.includes(name) || name.includes(key)));
            if (meant) {
                inputs[meant[0]] = inputs[key];
                delete inputs[key];
                repairs.push(`input_name:${step.id}.${key}->${meant[0]}`);
            }
        }

        // One error per step, echoing the inputs it already has: a retry told
        // only what was missing rewrites the step and loses the rest.
        const absent = Object.entries(capability.inputs)
            .filter(([name, io]) => io.required
                && (inputs[name] === undefined || inputs[name] === null || inputs[name] === ''))
            .map(([name]) => `"${name}"`);
        if (absent.length) {
            errors.push(`${where}: ${capability.id} requires ${absent.join(' and ')} `
                + `added to the inputs it already has, ${JSON.stringify(inputs)}`);
        }

        if (capability.id === 'web.browse') {
            let aimed = null;
            try { aimed = new URL(String(inputs.url || '')).hostname; } catch { }
            if (STEERED.has(aimed)) {
                const about = `${inputs.goal || ''} ${question}`;
                const misfit = (about.match(OTHER_CHANNEL) || about.match(NOT_AN_EVENT) || [])[0];
                if (misfit) {
                    errors.push(
                        `${where}: this steers "${String(misfit).trim()}" at the user's ` +
                        'mailbox, which sends mail and keeps their calendar, nothing else. ' +
                        'If no capability reaches what the request asks, leave "steps" ' +
                        'empty and describe the job in "missing"');
                }
            }
        }

        // A path on a site the request only named is a guess: the model
        // cannot know an unseen site's structure, and reading an invented
        // address answers from imagination. Hosts may be guessed — that is
        // how a named institution becomes its site — paths may not.
        if (capability.id === 'web.read') {
            const value = String(inputs.url || '');
            if (!REFERENCE.test(value)) {
                let aimed = null;
                try { aimed = new URL(value); } catch { }
                if (aimed && aimed.pathname && aimed.pathname !== '/'
                    && !question.toLowerCase().includes(aimed.pathname.toLowerCase())) {
                    errors.push(
                        `${where}: "${aimed.pathname}" is a guessed address — the request `
                        + 'named the site, not that page. Read the front page '
                        + `("${aimed.origin}") if that is where the answer lives, or `
                        + 'web.browse to find it on the site.');
                }
            }
        }

        for (const [name, io] of Object.entries(capability.inputs)) {
            const value = inputs[name];
            if (typeof value !== 'string' || !String(io.type).includes('path')) continue;
            if (REFERENCE.test(value)) continue;

            const invented = PLACEHOLDER.test(value) || !/^([/~])/.test(value);
            if (!invented) continue;

            if (io.required) {
                errors.push(`${where}: "${name}" is not a full path ("${value}")`);
            } else {
                delete inputs[name];
                repairs.push(`invented_path:${step.id}.${name}=${value}`);
            }
        }

        seen.set(step.id, capability);
    });

    const unused = [];
    parsed.steps.forEach((step, index) => {
        const capability = seen.get(step.id);
        if (!capability) return;

        const isLast = index === parsed.steps.length - 1;
        const useful = capabilityGraph.effectsFor(capability, step.inputs)
            .some(e => capabilityGraph.ACCOMPLISHING.has(e))
            || consumed.has(step.id)
            || (isLast && 'text' in capability.outputs);

        if (!useful) unused.push({ index, step, capability, isLast });
    });

    // A plan that stops at gathered passages is completed, not rejected: the
    // answer step it forgot is appended deterministically, the way a stronger
    // planner ends the same plan unprompted. A plan that stops at found paths
    // is finished the same way only when the question is one the paths
    // themselves answer — where a file is, whether it exists. An imperative
    // that merely stalled at found files gets no answer nobody asked for.
    const tail = unused[unused.length - 1];
    const evidence = tail
        && ['passages', 'paths'].find(name => name in (tail.capability.outputs || {}));
    const answerable = evidence === 'passages'
        || (evidence === 'paths' && LOCATING.test(String(question)));
    if (unused.length === 1 && tail.isLast && answerable
        && String(question).trim()
        && graph.resolveId('answer')
        && parsed.steps.length < maxSteps) {
        let id = `s${parsed.steps.length + 1}`;
        while (seen.has(id)) id = `${id}a`;
        parsed.steps.push({
            id, capability: 'answer',
            inputs: { question: String(question).trim(), passages: `$${tail.step.id}.${evidence}` },
            reason: 'read the answer out of what was gathered'
        });
        repairs.push('appended_answer');
        unused.pop();
    }

    for (const entry of unused) {
        errors.push(
            `steps[${entry.index}]: ${entry.step.id} (${entry.capability.id}) produces ` +
            `${Object.keys(entry.capability.outputs).join(', ')} that nothing uses` +
            (entry.isLast ? ' and does not end the plan with an answer' : '') +
            // Costs nothing on a valid plan; on retry it teaches the merge a
            // find-then-act request needs — or, off the web, that gathering
            // for a job the list cannot do belongs in "missing".
            (entry.capability.id === 'web.browse'
                ? ' — if a later step was meant to act on what this one finds, merge them: '
                  + 'one web.browse carries the whole request, reading one page and acting '
                  + 'on another by itself'
                : ' — either a later step must use what this produces, or the job it was '
                  + 'gathering for is not one the list can do: then leave the step out '
                  + 'and name that job in "missing"')
        );
    }

    if (parsed.steps.length === 0 && declaredMissing.length === 0) {
        errors.push('empty_plan');
    }

    return {
        valid: errors.length === 0,
        errors,
        repairs,
        missing,
        declaredMissing
    };
}


function callModel(messages) {
    return llmClient.complete(messages, {
        tier: TIER,
        temperature: TEMPERATURE,
        max_tokens: MAX_TOKENS,
        timeout_ms: TIMEOUT_MS
    });
}

async function selectProcedures(request, procedures) {
    if (procedures.length <= PROCEDURE_TOP_K) return procedures;

    try {
        const described = procedures.map(capability => ({
            name: capability.source,
            description: capability.description,
            parameters: capability.inputs,
            capability
        }));

        const { selected, scores } = await skillRetriever.rank(
            request, described, PROCEDURE_TOP_K, PROCEDURE_MIN_SCORE
        );

        console.log(
            `[Planner] ${selected.length}/${procedures.length} recipes: ` +
            scores.slice(0, 3).map(r => `${r.item.name}(${r.score.toFixed(2)})`).join(', ')
        );
        return selected.map(entry => entry.capability);
    } catch (err) {
        console.warn(`[Planner] Recipe retrieval unavailable (${err.message}); offering all.`);
        return procedures;
    }
}

async function selectCapabilities(request, options = {}) {
    if (options.capabilities) return { capabilities: options.capabilities, retrieved: false };

    const all = capabilityGraph.list();
    const builtins = all.filter(c => c.kind !== 'skill' && c.kind !== 'procedure');
    const skills = all.filter(c => c.kind === 'skill');

    const everyProcedure = all.filter(c => c.kind === 'procedure');
    const ids = new Set(everyProcedure.map(c => c.id));
    // A recipe learned on one mail provider is not on offer when the request
    // steers to another; with no recipes for the chosen mailbox, mail routes
    // through web.browse the way it did before recipes existed.
    const procedures = negativeMemory.offerable(
        everyProcedure
            .filter(c => !(c.family && ids.has(`procedure.${c.family}`)))
            .filter(c => !(c.surfaces || []).length
                || c.surfaces.some(s => mailProvider.surfaceApplies(s, request, config))));

    const skillRegistry = require('./skillRegistry');
    const manifests = skills
        .map(c => skillRegistry.get(c.source))
        .filter(Boolean);

    const selection = await skillRetriever.selectRelevant(request, manifests);
    const keep = new Set(selection.skills.map(s => `skill.${s.name}`));
    const recipes = await selectProcedures(request, procedures);

    return {
        capabilities: [...builtins, ...skills.filter(c => keep.has(c.id)), ...recipes],
        retrieved: selection.retrieved
    };
}

async function plan(request, options = {}) {
    const startedAt = Date.now();
    const graph = options.graph || capabilityGraph;

    const { capabilities, retrieved } = await selectCapabilities(request, options);
    const conversation = [
        { role: 'system', content: buildPlanPrompt(capabilities, mailUrlFor(request), calendarUrlFor(request)) },
        { role: 'user', content: String(request) }
    ];

    let lastErrors = [];
    let lastMissing = [];
    let lastRaw = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        let raw;
        try {
            raw = await callModel(conversation);
        } catch (err) {
            const kind = err.message.startsWith('timeout') ? 'timeout' : 'server_error';
            console.error(`[Planner] Attempt ${attempt} failed (${kind}): ${err.message}`);
            return {
                status: 'failed', reason: kind, errors: [`${kind}: ${err.message}`],
                attempts: attempt, latency_ms: Date.now() - startedAt, raw: err.message
            };
        }

        lastRaw = raw;
        const parsed = extractJson(raw);

        if (!parsed) {
            lastErrors = ['json_parse_error'];
            console.warn(`[Planner] Attempt ${attempt}: response was not parseable JSON.`);
        } else {
            const check = validatePlan(parsed, { graph, question: request });

            lastMissing = [...check.missing, ...check.declaredMissing];

            if (check.valid) {
                const result = {
                    status: 'planned',
                    goal: String(parsed.goal).trim(),
                    steps: parsed.steps.map(normaliseStep),
                    missing: check.declaredMissing,
                    repairs: check.repairs,
                    attempts: attempt,
                    catalogue: capabilities.length,
                    retrieved,
                    latency_ms: Date.now() - startedAt,
                    raw
                };

                if (!result.steps.length || !changesAnything(result, graph)) {
                    console.log(`[Planner] gap: ${result.missing.join('; ')}`);
                    return { ...result, status: 'gap' };
                }

                console.log(
                    `[Planner] ${result.steps.length} step(s): ` +
                    `${result.steps.map(s => s.capability).join(' -> ')} ` +
                    `(${result.attempts} attempt(s), ${result.latency_ms}ms)` +
                    (result.missing.length ? ` [missing: ${result.missing.join('; ')}]` : '')
                );
                return result;
            }

            lastErrors = check.errors;
            console.warn(`[Planner] Attempt ${attempt}: invalid — ${check.errors.join(', ')}`);
        }

        if (attempt < MAX_ATTEMPTS) {
            conversation.push({ role: 'assistant', content: raw });
            conversation.push({
                role: 'user',
                content: REPAIR_INSTRUCTION.replace('%ERRORS%', lastErrors.join(', '))
            });
        }
    }

    if (lastMissing.length) {
        console.log(`[Planner] gap after ${MAX_ATTEMPTS} attempts: ${lastMissing.join(', ')}`);
        return {
            status: 'gap',
            goal: null,
            steps: [],
            missing: [...new Set(lastMissing)],
            errors: lastErrors,
            attempts: MAX_ATTEMPTS,
            latency_ms: Date.now() - startedAt,
            raw: lastRaw
        };
    }

    return {
        status: 'failed', reason: 'schema_failure', errors: lastErrors,
        attempts: MAX_ATTEMPTS, latency_ms: Date.now() - startedAt, raw: lastRaw
    };
}

function changesAnything(result, graph) {
    if (!result.missing.length) return true;

    return result.steps.some(step => {
        const capability = graph.get(step.capability);
        return capability && capabilityGraph.effectsFor(capability, step.inputs).some(
            effect => capabilityGraph.ACCOMPLISHING.has(effect)
        );
    });
}

function normaliseStep(step) {
    return {
        id: String(step.id),
        capability: String(step.capability),
        inputs: step.inputs || {},
        reason: typeof step.reason === 'string' ? step.reason.trim() : ''
    };
}

module.exports = {
    plan,
    validatePlan,
    changesAnything,
    referencesIn,
    buildPlanPrompt,
    selectCapabilities,
    MAX_STEPS,
    REFERENCE
};
