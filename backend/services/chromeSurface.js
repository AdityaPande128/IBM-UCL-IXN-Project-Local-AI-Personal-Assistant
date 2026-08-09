const configReader = require('../utils/configReader');
const axBridge = require('./axBridge');
const perception = require('./pagePerception');

const config = configReader.readConfig();
const webConfig = config.web || {};

const APP = webConfig.desktop_browser || 'Google Chrome';
const MAX_ELEMENTS = webConfig.max_elements ?? 60;
const MAX_TEXT_CHARS = webConfig.max_text_chars ?? 4000;

const HARVEST = webConfig.ax_harvest ?? 500;

const TIER = 3;

const CHROME_FURNITURE = new Set([
    'Minimize', 'Zoom', 'Close', 'Full Screen', 'Bookmark this tab',
    'You are signed out', 'Chrome', 'Search tabs', 'Tab groups'
]);

const MAX_ALIKE = 3;

const SELECTS = new Set(['checkbox', 'radio']);
const LIST_ROWS = 3;

const MAX_SELECTOR_LABEL = 60;

const KEY_WORDS = 3;
const KEY_CHARS = 18;

function rowKey(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function quoted(link, selector) {
    const words = rowKey(link).split(' ').filter(Boolean);
    for (let length = words.length; length >= KEY_WORDS; length--) {
        const opening = words.slice(0, length).join(' ');
        if (opening.length < KEY_CHARS) return null;
        if (selector.includes(opening)) return opening;
    }
    return null;
}

function redundant(elements) {
    const openable = (elements || [])
        .filter(element => element.role === 'link' && element.name)
        .map(element => element.name);

    const covered = new Map();
    for (const element of elements || []) {
        if (!SELECTS.has(element.role) || !element.name) continue;
        const mine = rowKey(element.name);
        if (mine.length < KEY_CHARS) continue;

        for (const link of openable) {
            const opening = quoted(link, mine);
            if (opening) { covered.set(element.ref, opening); break; }
        }
    }

    const rows = new Set(covered.values());
    const drop = new Set(rows.size >= LIST_ROWS ? covered.keys() : []);

    for (const element of elements || []) {
        if (!SELECTS.has(element.role)) continue;
        if (String(element.name || '').length > MAX_SELECTOR_LABEL) drop.add(element.ref);
    }
    return drop;
}

const NEAR_FOCUS = 20;

function select(elements, limit) {
    const byRole = new Map();
    const seen = new Map();
    const keep = new Set();

    const focus = elements.findIndex(element => element.focused);
    if (focus >= 0) {
        const from = Math.max(0, focus - Math.floor(NEAR_FOCUS / 4));
        for (const element of elements.slice(from, from + NEAR_FOCUS)) {
            if (keep.size >= limit) break;
            keep.add(element.ref);
        }
    }

    for (const element of elements) {
        const alike = `${element.role} ${element.name}`;
        const count = seen.get(alike) || 0;
        if (element.name && count >= MAX_ALIKE) continue;
        seen.set(alike, count + 1);

        if (!byRole.has(element.role)) byRole.set(element.role, []);
        byRole.get(element.role).push(element);
    }

    const queues = [...byRole.values()];
    for (let round = 0; keep.size < limit; round++) {
        let placed = false;
        for (const queue of queues) {
            if (round >= queue.length) continue;
            placed = true;
            keep.add(queue[round].ref);
            if (keep.size >= limit) break;
        }
        if (!placed) break;
    }

    return elements.filter(element => keep.has(element.ref));
}

const ECHO_WINDOW = 3;

function readable(elements) {
    const lines = [];
    let length = 0;

    for (const element of elements) {
        const line = String(element.name || '').trim();
        if (line.length < 2) continue;

        const near = lines.slice(-ECHO_WINDOW);
        if (lines[lines.length - 1] === line) continue;
        if (near.some(seen => seen !== line && seen.includes(line))) continue;

        lines.push(line);
        length += line.length + 1;
        if (length >= MAX_TEXT_CHARS) break;
    }
    return lines.join('\n');
}

async function call(request) {
    const reply = await axBridge.send({ app: APP, ...request });
    if (reply && reply.error) throw new Error(reply.error);
    return reply;
}


async function ready() {
    return axBridge.available() && await axBridge.trusted();
}

async function start() {
    return call({ cmd: 'activate' });
}

async function observe() {
    const raw = await call({ cmd: 'observe', max: HARVEST });

    const all = (raw.elements || []).filter(element =>
        !(CHROME_FURNITURE.has(element.name) && element.role === 'button'));

    const restated = redundant(all);
    const actionable = all.filter(element =>
        element.role !== 'text' && !restated.has(element.ref));
    const kept = select(actionable, MAX_ELEMENTS);

    remember(raw.url);

    return {
        url: raw.url || '',
        title: raw.title || '',
        elements: kept,
        text: readable(all),
        droppedElements: actionable.length - kept.length,
        textTruncated: false,
        truncated: actionable.length > kept.length,
        label: perception.webLabel(),
        tier: TIER,
        app: raw.app || APP
    };
}

const NAVIGATION_TRIES = 3;

async function navigate(url) {
    let refused = null;
    for (let attempt = 1; attempt <= NAVIGATION_TRIES; attempt += 1) {
        try {
            await call({ cmd: 'navigate', url });
            refused = null;
            break;
        } catch (err) {
            refused = err;
            if (attempt === NAVIGATION_TRIES) break;
            await call({ cmd: 'activate' }).catch(() => {});
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    if (refused) throw refused;

    await settle();
    const after = await call({ cmd: 'observe', max: 1 });
    return { url: after.url || url, title: after.title || '' };
}

async function resolve(ref, anchor) {
    const live = await call({ cmd: 'has', ref }).catch(() => null);
    if (live && live.exists && live.onscreen) return { handle: ref, element: null, observation: null };

    if (!anchor || !anchor.role) {
        return { handle: null, element: null, observation: null,
                 why: 'that element is not on the page any more' };
    }

    const fresh = await observe();
    const { element, why } = perception.find(fresh, anchor);
    if (!element) {
        return { handle: null, element: null, observation: fresh,
                 why: `"${anchor.name}" is not on the page any more — it changed while you were deciding` };
    }
    return { handle: element.ref, element, observation: fresh, why: null };
}

async function click(handle) {
    try {
        const reply = await call({ cmd: 'click', ref: handle });
        await settle();
        return { ok: true, detail: reply.how === 'AXPress' ? 'clicked' : 'clicked' };
    } catch (err) {
        return { ok: false, stale: true, why: err.message };
    }
}

async function fill(handle, text) {
    try {
        await call({ cmd: 'fill', ref: handle, text: String(text ?? '') });
        return { ok: true, detail: 'typed' };
    } catch (err) {
        return { ok: false, stale: true, why: err.message };
    }
}

async function submit() {
    try {
        await call({ cmd: 'key', name: 'Return' });
        await settle();
        return { ok: true, detail: 'pressed Return' };
    } catch (err) {
        return { ok: false, why: err.message };
    }
}

const TRAIL = [];
const TRAIL_DEPTH = 12;

function remember(url) {
    const where = String(url || '');
    if (!where || TRAIL[TRAIL.length - 1] === where) return;
    TRAIL.push(where);
    if (TRAIL.length > TRAIL_DEPTH) TRAIL.shift();
}

async function back() {
    const from = (await call({ cmd: 'observe', max: 1 }).catch(() => null))?.url || '';

    await call({ cmd: 'key', name: 'ArrowLeft', command: true }).catch(() => null);
    await settle();
    let after = await call({ cmd: 'observe', max: 1 });

    if (String(after.url || '') === from) {
        const previous = [...TRAIL].reverse().find(url => url !== from);
        if (previous) {
            await navigate(previous);
            after = await call({ cmd: 'observe', max: 1 });
        }
    }

    remember(after.url);
    return { url: after.url || '' };
}

function grantedOnly() {
    return true;
}

function touch() {}

async function close() {
    axBridge.stop();
}

async function key(name, { command = false } = {}) {
    return call({ cmd: 'key', name, command });
}

const SETTLE_QUIET_MS = webConfig.settle_quiet_ms ?? 600;
const SETTLE_TIMEOUT_MS = webConfig.settle_timeout_ms ?? 8000;

async function settle({ quietMs = SETTLE_QUIET_MS, timeoutMs = SETTLE_TIMEOUT_MS } = {}) {
    const deadline = Date.now() + timeoutMs;
    let previous = null;
    let quietSince = null;

    while (Date.now() < deadline) {
        let sample;
        try {
            const reply = await call({ cmd: 'observe', max: 1 });
            sample = `${reply.url}:${reply.title}:${reply.visited}`;
        } catch {
            return false;
        }

        if (sample === previous) {
            if (quietSince === null) quietSince = Date.now();
            if (Date.now() - quietSince >= quietMs) return true;
        } else {
            previous = sample;
            quietSince = null;
        }
        await new Promise(resolve => setTimeout(resolve, 150));
    }
    return false;
}

module.exports = {
    ready, start, observe, resolve, navigate, back, click, fill, submit, key, settle,
    touch, close, grantedOnly,
    select, readable, redundant,
    APP, TIER, MAX_ELEMENTS, HARVEST, name: 'desktop'
};
