const configReader = require('../utils/configReader');
const labels = require('./labels');
const egress = require('./egress');

const config = configReader.readConfig();
const webConfig = config.web || {};

const BLOCKED_HOSTS = new Set(
    (webConfig.blocked_hosts || []).map(host => String(host).toLowerCase())
);
const ALLOW_PRIVATE_HOSTS = webConfig.allow_private_hosts === true;

const REFUSAL = {
    SCHEME: 'scheme',
    HOST: 'host',
    PRIVATE: 'private-host',
    CREDENTIAL: 'credential-field',
    IRREVERSIBLE: 'irreversible-action',
    STALE: 'element-gone',
    UNGRANTED: 'site-not-granted',
    UNREQUESTED: 'unrequested-file',
    RUNNABLE: 'runnable-file'
};


function mayLeaveUnattended(label, channel = egress.CHANNEL.NETWORK) {
    const value = label || labels.UNKNOWN;

    if (labels.isSecret(value)) {
        return {
            decision: egress.DECISION.DENY,
            reason: 'credential material must never be transmitted; no approval can authorise this'
        };
    }
    if (labels.isInstructionSafe(value)) {
        return { decision: egress.DECISION.ALLOW, reason: "this is the user's own input" };
    }
    return {
        decision: egress.DECISION.APPROVE,
        reason: `data the user did not type would leave by ${channel} ` +
            `(${labels.describe(value)}); this needs explicit approval`
    };
}


const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

function isPrivateV4(host) {
    const octets = host.split('.');
    if (octets.length !== 4 || octets.some(part => !/^\d{1,3}$/.test(part))) return false;

    const [a, b] = octets.map(Number);
    if (a === 127 || a === 0 || a === 10) return true;
    if (a === 169 && b === 254) return true;   // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
}

// WHATWG URL canonicalises IPv6 to a compressed lowercase form, so the range
// can be read off the front. ::ffff:a.b.c.d (IPv4-mapped) is resolved by the
// network stack to its embedded IPv4, so it is judged as that address; the
// other non-global ranges — loopback, unspecified, link-local (fe80::/10),
// unique-local (fc00::/7) — never reach the public web and are refused whole.
// Nothing publicly routable begins with an f hextet (global unicast is
// 2000::/3), so f[cdef] catches ULA, link/site-local and multicast together.
function isPrivateV6(host) {
    if (!host.includes(':')) return false;
    if (host === '::1' || host === '::') return true;

    const mapped = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mapped) {
        const hi = parseInt(mapped[1], 16);
        const lo = parseInt(mapped[2], 16);
        return isPrivateV4(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
    }
    if (/^f[cdef]/.test(host)) return true;
    if (host.startsWith('::')) return true;   // other ::/8 special-use
    return false;
}

function isPrivateHost(hostname) {
    let host = String(hostname || '').toLowerCase();
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
    if (host.includes(':')) return isPrivateV6(host);
    return isPrivateV4(host);
}

function checkTarget(url, { allowPrivate = ALLOW_PRIVATE_HOSTS, grantedOnly = false } = {}) {
    let parsed;
    try {
        parsed = new URL(String(url));
    } catch {
        return refuse(REFUSAL.SCHEME, `"${url}" is not a URL`);
    }

    if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
        return refuse(REFUSAL.SCHEME, `${parsed.protocol} is not a scheme the browser may open`);
    }

    const hostname = parsed.hostname.toLowerCase();
    if (BLOCKED_HOSTS.has(hostname)) {
        return refuse(REFUSAL.HOST,
            `${hostname} handles sign-in or payment; the assistant does not go there`);
    }
    if (!allowPrivate && isPrivateHost(hostname)) {
        return refuse(REFUSAL.PRIVATE,
            `${hostname} is on this machine or this network; the browser stays on the public web`);
    }

    if (grantedOnly && !securityStore().isGrantedSite(hostname)) {
        return refuse(REFUSAL.UNGRANTED,
            `${hostname} is not one of the sites you have signed the assistant in to, and the ` +
            'browser it is using carries your logged-in sessions. Grant it with: ' +
            `node tools/grant-site.js ${hostname}`);
    }

    return { allowed: true, reason: 'an ordinary public address', refusal: null, url: parsed.href };
}

function securityStore() {
    return require('./store');
}

function checkArrival(url, { allowPrivate = ALLOW_PRIVATE_HOSTS, grantedOnly = false } = {}) {
    const verdict = checkTarget(url, { allowPrivate, grantedOnly });
    if (verdict.allowed) return verdict;

    let where = url;
    try { where = new URL(String(url)).hostname; } catch {  }

    return refuse(verdict.refusal,
        `the site redirected the browser to ${where}, which is not somewhere it may go: ${verdict.reason}`);
}

function sameSite(hostname, from) {
    const here = String(hostname || '').toLowerCase();
    const there = String(from || '').toLowerCase();
    if (!here || !there) return false;
    return here === there || here.endsWith(`.${there}`) || there.endsWith(`.${here}`);
}

function checkNavigation({ url, label, allowPrivate = ALLOW_PRIVATE_HOSTS, grantedOnly = false,
                           from = null } = {}) {
    const target = checkTarget(url, { allowPrivate, grantedOnly });
    if (!target.allowed) return { ...target, approvalId: null };

    const parsed = new URL(target.url);

    const staying = from && !labels.isSecret(label || labels.UNKNOWN)
        && sameSite(parsed.hostname, from);
    if (staying) {
        return {
            allowed: true,
            reason: `this stays on ${from}, which is where the request already is`,
            refusal: null, approvalId: null, url: parsed.href
        };
    }

    const verdict = egress.guard({
        channel: egress.CHANNEL.NETWORK,
        action: 'web.navigate',
        inputs: [label],
        destination: parsed.origin,
        summary: `open ${parsed.origin}${parsed.pathname}`,
        preview: parsed.href,
        policy: mayLeaveUnattended
    });

    if (verdict.allowed) {
        return { allowed: true, reason: verdict.reason, refusal: null, approvalId: null, url: parsed.href };
    }
    return {
        allowed: false,
        reason: verdict.reason,
        refusal: verdict.decision === egress.DECISION.DENY ? REFUSAL.CREDENTIAL : 'approval-required',
        approvalId: verdict.approvalId,
        url: parsed.href
    };
}

function refuse(refusal, reason) {
    return { allowed: false, reason, refusal, approvalId: null, url: null };
}


function drawnFrom(text, source) {
    const words = value => new Set(
        String(value || '')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .split(/\s+/)
            .filter(Boolean)
    );

    const typed = words(text);
    if (!typed.size) return true;

    const available = words(source);
    for (const word of typed) {
        if (!available.has(word)) return false;
    }
    return true;
}

function checkFill({ element, text, goal, userLabel, contextLabel, label, destination,
                     mandate } = {}) {
    if (!element) {
        return refuse(REFUSAL.STALE, 'that element is not on the page any more');
    }
    if (element.sensitive) {
        return refuse(REFUSAL.CREDENTIAL,
            `this is a ${element.sensitive} field. The assistant never fills these — ` +
            'type it yourself if you want to continue');
    }
    if (element.disabled) {
        return refuse(REFUSAL.STALE, 'that field is disabled');
    }

    const composing = Boolean(mandate && mandate.has && mandate.has('send'));

    const effective = label || (composing || drawnFrom(text, goal)
        ? (userLabel || labels.UNKNOWN)
        : labels.join(userLabel || labels.UNKNOWN, contextLabel || labels.UNKNOWN));

    const verdict = egress.guard({
        channel: egress.CHANNEL.NETWORK,
        action: 'web.fill',
        inputs: [effective],
        destination,
        summary: `type into "${element.name || element.ref}" on ${destination || 'the page'}`,
        preview: String(text ?? '').slice(0, 200),
        policy: mayLeaveUnattended
    });

    return verdict.allowed
        ? { allowed: true, reason: verdict.reason, refusal: null, approvalId: null }
        : {
            allowed: false,
            reason: verdict.reason,
            refusal: verdict.decision === egress.DECISION.DENY ? REFUSAL.CREDENTIAL : 'approval-required',
            approvalId: verdict.approvalId
        };
}


const MAX_CONTROL_LABEL_CHARS = 60;

const IRREVERSIBLE = [
    { kind: 'spend',
      pattern: /\b(buy|purchase|place order|pay now|checkout|complete order|subscribe|donate)\b/i,
      what: 'spends money' },
    { kind: 'agree',
      pattern: /\b(i agree|accept (all|terms)|agree (and|to)|consent|opt.?in)\b/i,
      what: 'agrees to terms on your behalf' },
    { kind: 'delete',
      pattern: /\b(delete|remove account|deactivate|close account|erase|permanently)\b/i,
      what: 'deletes something' },
    { kind: 'send',
      pattern: /\b(send|post|publish|submit application|tweet)\b/i,
      what: 'sends something to other people' },
    // "Save" and "Schedule event" commit an event; "New event" and "Create
    // event" merely open the editor, and crediting the booking to the opener
    // once ended a run with nothing on the calendar.
    { kind: 'book',
      pattern: /\bsave\b|\bschedule event\b/i,
      what: 'puts an event on the calendar' },
    { kind: 'compose',
      pattern: /\b(reply|forward|compose|new message|write)\b/i,
      what: 'starts a message to other people' },
    { kind: 'account',
      pattern: /\b(sign ?up|create account|register)\b/i,
      what: 'creates an account' }
];

const AS_NOUN = /\b(my|your|his|her|their|our|its|the|a|an|this|that|these|those|last|latest|newest|recent|any|some|no|each|every|first|next|previous|unread|new|old)\s+((\w+\s+){0,2})?$/i;

const MANDATES = [
    { kind: 'send',
      pattern: /\b(send|reply|respond|forward|write (to|back))\b/i },
    { kind: 'send', pattern: /\b(email|message)\b/i, notAfter: AS_NOUN },
    { kind: 'send', pattern: /\btell\s+(?!me\b|us\b)/i },
    { kind: 'compose', pattern: /\b(draft|compose)\b/i },
    // Booking is calendar work unless the words nearby say commerce — "book a
    // meeting" schedules, "book me a flight" spends, and spend is never
    // granted from text.
    { kind: 'book',
      pattern: /\b(book|schedule)\b(?![^.]{0,20}\b(flights?|hotels?|tables?|tickets?|taxis?|cabs?|rooms?)\b)/i },
    { kind: 'book',
      pattern: /\b(add|put|create|set up|make)\b[^.]{0,40}\b(event|appointment|reminder|calendar)\b/i },
    { kind: 'spend', pattern: /\b(buy|purchase|pay|checkout|subscribe|donate)\b/i },
    { kind: 'spend', pattern: /\b(order|book)\b/i, notAfter: AS_NOUN },
    { kind: 'delete', pattern: /\b(delete|remove|erase|unsubscribe|clear out|throw away)\b/i },
    { kind: 'agree', pattern: /\b(accept|agree|consent|opt in)\b/i },
    // Both file mandates need an object: "save the event" grants no download,
    // "send an email" hands over no file. "attachment" does not match
    // \battach\b — asking to save one is not asking to attach one.
    { kind: 'save',
      pattern: /\b(save|download)\b[^.]{0,60}\b(attachment|attached|file|pdf|invoice|receipt|ticket|document|paper|photo|picture|image|cv|resume)\b/i },
    { kind: 'attach', pattern: /\battach(?:ing|ed)?\b/i },
    { kind: 'attach',
      pattern: /\b(send|email|forward)\b[^.]{0,60}\b(file|pdf|spreadsheet|document|photo|picture|image|cv|resume|report)\b/i }
];

const INTENT_MANDATE = {
    read: [],
    compose: ['compose'],
    send: ['compose', 'send'],
    book: ['compose', 'book'],
    save: ['save'],
    spend: [],
    delete: [],
    agree: []
};

// "draft", "don't send" and the like ask for a message to be written, not
// sent. The send verb inside such a request ("draft a reply", "write back but
// leave it unsent") is describing the message, not authorising its dispatch —
// so the send mandate is withdrawn, matching what the model path (act
// "compose") and the recipe guard both already do.
const DRAFT_INTENT = /\b(draft|drafts|drafting|don'?t send|do not send|without sending|leave it unsent)\b/i;

// A verb governed by somebody else's subject, or by an interrogative
// auxiliary, describes an act to find out about, not one to perform: "what
// did she email me about", "has Philip replied to it" name sending without
// asking for any. The guard reads the word or two before the matched verb —
// an imperative's verb has the request's own opening there, never "she" or
// "did". Modal requests to this system ("could you email Sam") keep their
// grant, because "you" is deliberately absent from the list.
const ANOTHERS_ACT = /\b(she|he|they|who|anyone|someone|somebody|did|does|has|have|had)\s+(\w+\s+)?$/i;

function safeHost(url) {
    try { return new URL(String(url)).host; } catch { return String(url || ''); }
}

function mandateFromIntent(act, label) {
    const origins = (label && label.origins) || [];
    if (origins.includes(labels.ORIGIN.WEB)) return new Set();

    return new Set(INTENT_MANDATE[String(act || '')] || []);
}

function mandateFrom(text, label) {
    const words = String(text || '');
    if (!words.trim()) return new Set();

    const origins = (label && label.origins) || [];
    if (origins.includes(labels.ORIGIN.WEB)) return new Set();

    const asks = entry => {
        const found = entry.pattern.exec(words);
        if (!found) return false;
        const before = words.slice(0, found.index);
        if (ANOTHERS_ACT.test(before)) return false;
        return !entry.notAfter || !entry.notAfter.test(before);
    };

    const asked = new Set();
    for (const entry of MANDATES.filter(asks)) {
        const expanded = INTENT_MANDATE[entry.kind];
        for (const kind of expanded || [entry.kind]) asked.add(kind);
    }
    // A drafting request keeps compose but never send: the message is written,
    // not dispatched, however the send verb was phrased.
    if (asked.has('send') && DRAFT_INTENT.test(words)) {
        asked.delete('send');
        asked.add('compose');
    }
    return asked;
}

// What arrives runnable is never fetched — no mandate reaches past this.
const RUNNABLE = new Set(['.app', '.exe', '.dmg', '.pkg', '.msi', '.bat', '.cmd', '.com',
    '.sh', '.command', '.scpt', '.jar', '.apk', '.js', '.vbs', '.ps1']);

function sanitizeFilename(name) {
    const bare = String(name || '').split(/[\\/]/).pop()
        .replace(/[\u0000-\u001f]/g, "")
        .replace(/^\.+/, '')
        .trim()
        .slice(0, 120);
    return bare || 'download';
}

// The one gate bytes from the web pass on their way to disk: nothing lands
// unless the user's own words asked for a file to be saved, programs never
// land at all, and even a mandated save only admits a file the page itself
// shows — a drive-by download under the cover of a real request is refused
// for not being the file that was asked about.
function checkDownload({ filename, mandate, evidence } = {}) {
    const name = sanitizeFilename(filename);
    const extension = (name.match(/\.[^.]+$/) || [''])[0].toLowerCase();

    if (RUNNABLE.has(extension)) {
        return refuse(REFUSAL.RUNNABLE,
            `"${name}" arrives runnable, and the assistant does not fetch programs — `
            + 'download it yourself if you trust where it came from');
    }
    if (!mandate || !mandate.has || !mandate.has('save')) {
        return refuse(REFUSAL.UNREQUESTED,
            `the page offered "${name}", and nothing in the request asked for a file to be saved`);
    }
    if (evidence != null && !String(evidence).toLowerCase().includes(name.toLowerCase())) {
        return refuse(REFUSAL.UNREQUESTED,
            `the page produced "${name}" without showing it anywhere — a file the page `
            + 'does not own up to is not the one that was asked for');
    }
    return { allowed: true, reason: 'the request asked for this file to be saved',
             refusal: null, approvalId: null, filename: name };
}

// The mirror gate for bytes leaving: a local file goes into a page only when
// the user's own words asked for one to be attached. Which file it is was
// settled before any page was observed, so a page cannot choose it either.
function checkAttach({ path, mandate, label, destination } = {}) {
    const name = String(path || '').split(/[\\/]/).pop();

    if (!mandate || !mandate.has || !mandate.has('attach')) {
        return refuse(REFUSAL.UNREQUESTED,
            `nothing in the request asks for a file to be attached, so "${name}" stays on this machine`);
    }
    // The path speaks for itself: a credential file is refused here whatever
    // label the caller carried and however explicitly the user named it.
    const secret = require('./classifier').secretCheck(String(path || ''));
    if (secret.secret) {
        return refuse(REFUSAL.CREDENTIAL,
            `"${name}" is credential material (${secret.reason}); `
            + 'it never leaves this machine, and no approval can authorise it');
    }
    if (labels.isSecret(label || labels.UNKNOWN)) {
        return refuse(REFUSAL.CREDENTIAL,
            'credential material must never be transmitted; no approval can authorise this');
    }

    egress.guard({
        channel: egress.CHANNEL.NETWORK,
        action: 'web.attach',
        inputs: [label],
        destination,
        summary: `hand "${name}" to ${destination || 'the page'} — the request asked for this`,
        preview: name,
        policy: () => ({ decision: egress.DECISION.ALLOW, reason: 'the request named this file' })
    });

    return { allowed: true, reason: `"${name}" is the file the request names`,
             refusal: null, approvalId: null };
}

function checkClick({ element, label, destination, mandate, home } = {}) {
    if (!element) {
        return refuse(REFUSAL.STALE, 'that element is not on the page any more');
    }
    if (element.disabled) {
        return refuse(REFUSAL.STALE, 'that control is disabled');
    }

    const name = element.name || '';

    const match = name.length <= MAX_CONTROL_LABEL_CHARS
        ? IRREVERSIBLE.find(entry => entry.pattern.test(name))
        : null;

    const strayed = home && destination && safeHost(home) !== safeHost(destination);

    const asked = match && !strayed && mandate && mandate.has && mandate.has(match.kind);
    if (asked) {
        egress.guard({
            channel: egress.CHANNEL.NETWORK,
            action: 'web.click',
            inputs: [label],
            destination,
            summary: `press "${name}" — this ${match.what}, and was asked for`,
            preview: name,
            policy: () => ({ decision: egress.DECISION.ALLOW, reason: 'the request asked for this' })
        });
        return {
            allowed: true,
            reason: `"${name}" ${match.what}, and that is what was asked for.`,
            refusal: null,
            approvalId: null,
            advisory: `mandated: ${match.kind}`
        };
    }

    if (match) {
        const verdict = egress.guard({
            channel: egress.CHANNEL.NETWORK,
            action: 'web.click',
            inputs: [label],
            destination,
            summary: `press "${name}" — this ${match.what}`,
            preview: name,
            policy: () => ({
                decision: egress.DECISION.APPROVE,
                reason: `"${name}" ${match.what}`
            })
        });

        return {
            allowed: false,
            reason: `"${name}" ${match.what}, so I have not pressed it.`,
            refusal: REFUSAL.IRREVERSIBLE,
            approvalId: verdict.approvalId
        };
    }

    return { allowed: true, reason: 'ordinary navigation control', refusal: null, approvalId: null };
}

module.exports = {
    REFUSAL,
    mayLeaveUnattended,
    drawnFrom,
    checkTarget,
    checkArrival,
    checkNavigation,
    checkFill,
    checkClick,
    checkDownload,
    checkAttach,
    sanitizeFilename,
    mandateFrom,
    mandateFromIntent,
    INTENT_MANDATE,
    DRAFT_INTENT,
    ANOTHERS_ACT,
    isPrivateHost,
    IRREVERSIBLE,
    MANDATES,
    BLOCKED_HOSTS
};
