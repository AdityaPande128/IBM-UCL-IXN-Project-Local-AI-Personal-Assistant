const browser = require('./browser');
const perception = require('./pagePerception');

const TIER = 2;

let page = null;
let mode = browser.MODE.EPHEMERAL;

async function ready() {
    return true;
}

function grantedOnly() {
    return mode === browser.MODE.ATTACHED;
}

async function start(options = {}) {
    mode = options.mode || browser.MODE.EPHEMERAL;
    page = await browser.current({ mode });
    return { app: 'the assistant\'s browser' };
}

const MAX_SELECTOR_LABEL = 60;
const SELECTS = new Set(['checkbox', 'radio']);

async function observe() {
    const seen = await perception.observe(page);
    if (!seen || !Array.isArray(seen.elements)) return seen;

    const kept = seen.elements.filter(element =>
        !(SELECTS.has(element.role)
          && String(element.name || '').length > MAX_SELECTOR_LABEL));

    return { ...seen, elements: kept,
             droppedElements: (seen.droppedElements || 0) + (seen.elements.length - kept.length) };
}

async function navigate(url) {
    const landed = await browser.goto(url);
    return { url: landed.url, title: landed.title };
}

async function back() {
    await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
    return { url: page.url() };
}

async function resolve(ref, anchor) {
    const found = await perception.reacquire(page, ref, anchor);
    return {
        handle: found.target,
        element: found.element,
        observation: found.observation,
        why: found.why
    };
}

async function click(handle) {
    try {
        await handle.click({ timeout: browser.ACTION_TIMEOUT_MS });
    } catch (err) {
        return { ok: false, stale: true, why: err.message };
    }

    await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
    await browser.settle(page);
    return { ok: true, detail: 'clicked' };
}

async function fill(handle, text) {
    try {
        await handle.fill(String(text ?? ''));
    } catch (err) {
        return { ok: false, stale: true, why: err.message };
    }
    return { ok: true, detail: 'typed' };
}

async function submit(handle) {
    try {
        await handle.press('Enter');
    } catch (err) {
        return { ok: false, why: err.message };
    }
    await browser.settle(page);
    return { ok: true, detail: 'pressed Enter' };
}

async function settle() {
    return browser.settle(page);
}

function touch() {
    browser.touch();
}

async function close() {
    page = null;
    return browser.close();
}

module.exports = {
    ready, start, observe, resolve, navigate, back, click, fill, submit, settle, touch, close,
    grantedOnly, TIER, name: 'dom'
};
