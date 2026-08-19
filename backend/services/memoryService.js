const configReader = require('../utils/configReader');
const memoryStore = require('./memoryStore');
const proposals = require('./proposals');
const traceStore = require('./traceStore');
const llmClient = require('./llmClient');
const activityBus = require('./activityBus');
const securityLabels = require('../security/labels');
const { extractJson } = require('../utils/jsonRepair');

const config = configReader.readConfig();
const SETTINGS = config.memory || {};
const INFER = SETTINGS.infer !== false;
const EMBED_MODEL = (config.retrieval || {}).model || null;
const NIGHTLY_TICK_MS = SETTINGS.nightly_tick_ms ?? 6 * 60 * 60 * 1000;
const MAX_OFFERS_PER_PASS = 3;

let embedder = null;
let incognito = false;
let ticker = null;
let tracesBefore = null;

function setEmbedder(fn) {
    embedder = fn;
}

async function embedOne(text) {
    const embed = embedder || require('./embedClient').embed;
    const [vector] = await embed([text]);
    return vector;
}

// Incognito governs records, not transport (§4): memory writes are disabled,
// recall still works — reading is not recording — and traces go to an
// in-memory database that vanishes with the session.
function setIncognito(on) {
    const next = Boolean(on);
    if (next === incognito) return status();
    incognito = next;
    if (next) {
        tracesBefore = traceStore.path || traceStore.DEFAULT_PATH;
        traceStore.open(':memory:');
    } else {
        traceStore.open(tracesBefore || traceStore.DEFAULT_PATH);
        tracesBefore = null;
    }
    activityBus.publish('memory', next ? 'incognito_on' : 'incognito_off', {});
    return status();
}

function isIncognito() {
    return incognito;
}

async function add(text, { source = 'user', origin = null } = {}) {
    if (incognito) throw new Error('incognito: nothing is being recorded');
    const vector = await embedOne(String(text));
    const fact = memoryStore.remember({
        text, vector, embeddingModel: EMBED_MODEL, source, origin
    });
    activityBus.publish('memory', 'remembered', { id: fact.id, source });
    return fact;
}

// Inference never writes: it offers. The card is the write barrier (§3.1).
function offer(text, why, origin = null) {
    if (incognito) return null;
    const words = String(text || '').trim();
    if (!words) return null;

    const already = memoryStore.list({ status: 'active', limit: 500 })
        .some(fact => fact.text.toLowerCase() === words.toLowerCase());
    if (already) return null;

    return proposals.create('memory', {
        summary: `Remember that ${words}?`,
        text: words,
        why: why || 'this came up and looks like it will matter again'
    }, async () => {
        const fact = await add(words, { source: 'inferred', origin });
        return { status: 'success', response: `Remembered: ${fact.text}` };
    });
}

const INFER_PROMPT = `You read one exchange with a user and decide whether it
revealed any durable fact about the user worth remembering for future
conversations.

A fact is durable when it will still be true and useful in a month: who they
are, preferences, people and places in their life, standing constraints.
Task ephemera are never facts: what they asked for today, file names, one-off
errands. When in doubt, it is not a fact.

Respond with ONLY a JSON object:
{"facts":["<short third-person statement>", ...]}

Zero facts is the usual answer: {"facts":[]}`;

async function inferFrom(exchange, origin = null) {
    if (!INFER || incognito) return [];
    const text = String(exchange || '').trim();
    if (text.length < 12) return [];

    let raw;
    try {
        raw = await llmClient.complete([
            { role: 'system', content: INFER_PROMPT },
            { role: 'user', content: `The exchange:\n${text.slice(0, 2000)}\n\nThe JSON:` }
        ], { tier: 'guard', temperature: 0, max_tokens: 200,
             response_format: { type: 'json_object' } });
    } catch {
        return [];
    }

    const parsed = extractJson(raw);
    const facts = Array.isArray(parsed && parsed.facts) ? parsed.facts : [];
    return facts
        .map(fact => String(fact || '').trim())
        .filter(fact => fact.length >= 8 && fact.length <= 200)
        .slice(0, MAX_OFFERS_PER_PASS)
        .map(fact => offer(fact, 'mentioned in conversation', origin))
        .filter(Boolean);
}

// What enters context is labelled as memory, with its age, so the user can
// see why the assistant knew something — and correct it (§3.1).
function ageInWords(days) {
    if (days < 1) return 'today';
    if (days < 14) return `${days} day${days === 1 ? '' : 's'} old`;
    if (days < 60) return `${Math.round(days / 7)} weeks old`;
    return `${Math.round(days / 30)} months old`;
}

const answerSource = {
    name: 'memory',
    matches: () => true,
    async retrieve(query) {
        const vector = await embedOne(query);
        return memoryStore.search(vector, { topK: 3 }).map(hit => ({
            score: hit.score,
            text: hit.text,
            cite: `memory (${ageInWords(hit.age_days)})`,
            label: securityLabels.label(securityLabels.ORIGIN.USER,
                securityLabels.SENSITIVITY.PERSONAL)
        }));
    }
};

function start() {
    if (ticker) return;
    ticker = setInterval(() => {
        try {
            const swept = memoryStore.nightly();
            if (swept.archivedFacts || swept.archivedEpisodes) {
                console.log(`[Memory] Archived ${swept.archivedFacts} fact(s), `
                    + `${swept.archivedEpisodes} episode(s) past their horizon.`);
            }
        } catch (err) {
            console.warn(`[Memory] nightly pass failed: ${err.message}`);
        }
    }, NIGHTLY_TICK_MS);
    if (ticker.unref) ticker.unref();
}

function stop() {
    if (ticker) {
        clearInterval(ticker);
        ticker = null;
    }
}

function status() {
    return { incognito, ...memoryStore.stats() };
}

module.exports = {
    add, offer, inferFrom, answerSource,
    setIncognito, isIncognito, setEmbedder,
    start, stop, status
};
