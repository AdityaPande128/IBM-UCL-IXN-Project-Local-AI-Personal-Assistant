const configReader = require('../utils/configReader');
const llmClient = require('./llmClient');
const webPolicy = require('../security/webPolicy');
const { extractJson } = require('../utils/jsonRepair');

const config = configReader.readConfig();
const webConfig = config.web || {};

const TIER = webConfig.intent_tier || webConfig.tier || 'engine';
const TIMEOUT_MS = webConfig.intent_timeout_ms ?? 20000;
const MAX_TOKENS = 400;

const ACTS = new Set(['read', 'compose', 'send', 'book', 'spend', 'delete', 'agree']);

const SYSTEM_PROMPT = `You read a user's request and work out what it is asking for, before any website is opened.

Respond with ONLY a JSON object, no markdown fences and no commentary:
{"query":"<what to type in the site's search box, or null>","write":["<text to type>"],"act":"<read|compose|send|book|spend|delete|agree>","completes":"<short phrase: what will be true when this is done>"}

THE FIELDS

query   What you would type into the site's own search box to find the thing the
        request is about, or null if the request names nothing to look for.
        Use the site's qualifiers when the request implies a direction or a
        field, written key:value with NO space after the colon:
          mail FROM someone           -> "from:philip"
          mail the user SENT someone  -> "to:philip"
          anything mentioning someone -> "philip"
          something on a date         -> "August 15"
        A bare name finds every message that merely quotes that person. If the
        request is about what someone sent the user, that is from:. If it is
        about what the user sent them — including whether it was answered —
        that is to:. Prefer the narrower query; it is the difference between
        opening the right item and opening whatever is newest.
        Replying, forwarding and answering all need a query, because they act on
        a message that already exists and it has to be found first. Only a
        message to a fresh address, written from nothing, has no query.

write   The exact text to be typed, in the order it should be typed, as a list.
        Two cases, and they are different:
          The user QUOTED the words. Then the list is those words, character for
          character, including their capitalisation. Do not improve them.
          The user described the message instead ("tell Philip I'll be late").
          Then write the message yourself: one short, natural sentence or two
          that says what they asked to have said, in their voice. No subject
          line, no signature, no "Dear".
          NEVER copy the request into this field. The request is addressed to
          you and talks about the other person; the message is addressed TO
          them. Someone is going to read what you put here.
            "tell Philip to meet me at Primrose Hill at 9 PM"
              write: ["Could we meet at Primrose Hill at 9 PM?"]     RIGHT
              write: ["tell Philip to meet me at Primrose Hill at 9 PM"]  WRONG
            "let Sam know I'm running twenty minutes late"
              write: ["I'm running about twenty minutes late, sorry."]  RIGHT
              write: ["let Sam know I'm running twenty minutes late"]   WRONG
        If the request asks for several named values — an address, a subject, a
        body — list them in that order, one entry each.
        Empty list if nothing is to be typed. A question is never typed.

act     What the user is asking to have HAPPEN, not what words appear:
          read     find something out and tell them. Changes nothing. This is
                   the answer for every question, INCLUDING questions about
                   messages: "did Philip reply", "what did she say", "when is
                   it" are all read. A question that mentions replying is still
                   a question.
          compose  write a message but do not send it: "draft", "start a reply".
          send     write a message AND send it. This is what "reply to X",
                   "tell X that", "let X know", "send X" all mean — a message
                   nobody sent is not a reply, and someone who says "tell my
                   friend I'm running late" is asking for it to arrive.
          book     put something on the user's calendar: "book a meeting",
                   "schedule a call", "add it to my calendar". An event is
                   made, but no money moves and no message goes to anyone.
          spend    buy, order, pay — money changes hands. Booking a flight,
                   a hotel or a table is spend, not book.
          delete   delete, remove, unsubscribe.
          agree    accept terms, opt in, consent.
        When you are torn between read and send, ask what the user would be
        annoyed by. Being told the answer to a question they asked is never
        wrong; a message going out to another person because a question was
        misread is.

completes  One short phrase naming what will be true when the request has been
        carried out — "the reply has been sent", "the time and place are known".

EXAMPLES

"check my email to see if Philip has responded to my last email"
{"query":"to:philip","write":[],"act":"read","completes":"whether Philip answered is known"}

"tell Philip to meet me at Primrose Hill at 9 PM"
{"query":"philip","write":["Could we meet at Primrose Hill at 9 PM?"],"act":"send","completes":"the message has been sent"}

"reply to my friend Philip saying \\"Hello, yes Pakistan would be fab!\\""
{"query":"from:philip","write":["Hello, yes Pakistan would be fab!"],"act":"send","completes":"the reply has been sent"}

"find out what time and where I have to go on August 15th"
{"query":"August 15","write":[],"act":"read","completes":"the time and place are known"}

"draft an email to sam@example.com with the subject \\"Invoice\\" and the body \\"Attached.\\""
{"query":null,"write":["sam@example.com","Invoice","Attached."],"act":"compose","completes":"the draft is written"}

"draft a reply to Philip saying \\"Sounds good to me\\""
{"query":"from:philip","write":["Sounds good to me"],"act":"compose","completes":"the draft is written"}

"let Sam know I'm running twenty minutes late"
{"query":"sam","write":["I'm running about twenty minutes late, sorry."],"act":"send","completes":"the message has been sent"}

"put lunch with Sam on my calendar for Friday at 1pm"
{"query":null,"write":["Lunch with Sam"],"act":"book","completes":"the event is on the calendar"}`;

async function read(goal, options = {}) {
    const words = String(goal || '').trim();
    if (!words) return fallback(goal, options.label, 'empty');

    let raw;
    try {
        raw = await llmClient.complete([
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `The request: ${words}\n\nThe JSON:` }
        ], { tier: TIER, temperature: 0, max_tokens: MAX_TOKENS, timeout_ms: TIMEOUT_MS });
    } catch (err) {
        return fallback(goal, options.label, `unreachable: ${err.message}`);
    }

    const parsed = extractJson(raw);
    if (!parsed || typeof parsed !== 'object') {
        return fallback(goal, options.label, 'unparseable');
    }

    const act = ACTS.has(parsed.act) ? parsed.act : null;
    if (!act) return fallback(goal, options.label, `unknown act: ${parsed.act}`);

    let write = list(parsed.write);

    if (copied(words, write)) {
        const better = await recompose(words, raw).catch(() => null);
        if (better && !copied(words, better)) write = better;
    }

    return {
        query: text(parsed.query),
        write,
        act,
        completes: text(parsed.completes),
        mandate: webPolicy.mandateFromIntent(act, options.label),
        source: 'model'
    };
}

function copied(goal, write) {
    if (!write.length) return false;
    if (/["“”'‘’]/.test(goal)) return false;

    const request = goal.toLowerCase();
    return write.some(entry => {
        const words = entry.toLowerCase().trim();
        return words.length > 12 && request.includes(words.slice(0, 40));
    });
}

async function recompose(goal, previous) {
    const raw = await llmClient.complete([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `The request: ${goal}\n\nThe JSON:` },
        { role: 'assistant', content: previous },
        { role: 'user', content:
            'That "write" is the request copied back. The request was addressed to '
            + 'you; the message is addressed to the person it is going to, and they '
            + 'are the one who will read it. Write what they should receive, in the '
            + 'first person, as one short natural sentence. Reply with the same JSON '
            + 'object and nothing else.' }
    ], { tier: TIER, temperature: 0, max_tokens: MAX_TOKENS, timeout_ms: TIMEOUT_MS });

    const parsed = extractJson(raw);
    return parsed && typeof parsed === 'object' ? list(parsed.write) : null;
}

function fallback(goal, label, why) {
    const words = String(goal || '');
    const address = (words.toLowerCase().match(/[\w.+-]+@[\w.-]+\.\w{2,}/) || [])[0];
    const quoted = (words.match(/["“”'‘’]([^"“”'‘’]{2,200})["“”'‘’]/g) || [])
        .map(phrase => phrase.slice(1, -1).trim())
        .filter(Boolean);

    return {
        query: address ? `from:${address}` : null,
        write: quoted,
        act: null,
        completes: null,
        mandate: webPolicy.mandateFrom(goal, label),
        source: `words (${why})`
    };
}

function text(value) {
    const trimmed = String(value ?? '').trim();
    if (!trimmed || trimmed === 'null' || trimmed === 'undefined') return null;
    return trimmed;
}

function list(value) {
    const values = Array.isArray(value) ? value : (value == null ? [] : [value]);
    return values.map(entry => String(entry ?? '').trim()).filter(Boolean);
}

module.exports = { read, fallback, ACTS, SYSTEM_PROMPT };
