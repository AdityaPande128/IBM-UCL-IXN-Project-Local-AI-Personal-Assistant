const browser = require('./browser');
const perception = require('./pagePerception');
const consentBanners = require('./consentBanners');

const TIER = 2;

let page = null;
let mode = browser.MODE.EPHEMERAL;
let consentCheckedFor = null;

// Downloads queue here untouched — still in the browser's temporary area —
// until the loop drains them through the policy gate. This surface never
// decides whether one is kept.
let downloads = [];
let hookedPage = null;

async function ready() {
    return true;
}

function grantedOnly() {
    return mode === browser.MODE.ATTACHED;
}

async function start(options = {}) {
    mode = options.mode || browser.MODE.EPHEMERAL;
    page = await browser.current({ mode });
    if (page !== hookedPage) {
        hookedPage = page;
        downloads = [];
        page.on('download', download => { downloads.push(download); });
    } else {
        // A new run owns nothing an earlier one left queued: a mandate covers
        // its own request, never bytes another request abandoned.
        for (const stray of downloads.splice(0)) {
            if (typeof stray.cancel === 'function') stray.cancel().catch(() => {});
        }
    }
    return { app: 'the assistant\'s browser' };
}

function takeDownloads() {
    const held = downloads;
    downloads = [];
    return held;
}

async function attachFiles(handle, filePath) {
    try {
        const isFileInput = await handle.evaluate(el =>
            el.tagName === 'INPUT' && el.type === 'file').catch(() => false);
        if (isFileInput) {
            await handle.setInputFiles(filePath);
        } else {
            const chooser = page.waitForEvent('filechooser',
                { timeout: browser.ACTION_TIMEOUT_MS });
            await handle.click({ timeout: browser.ACTION_TIMEOUT_MS });
            await (await chooser).setFiles(filePath);
        }
    } catch (err) {
        return { ok: false, why: err.message };
    }
    await browser.settle(page);
    return { ok: true, detail: 'attached' };
}

const MAX_SELECTOR_LABEL = 60;
const SELECTS = new Set(['checkbox', 'radio']);

async function observe() {
    if (page && page.url() !== consentCheckedFor) {
        consentCheckedFor = page.url();
        const banner = await consentBanners.dismiss(page).catch(() => ({ dismissed: false }));
        if (banner.dismissed) {
            console.log(`[DomSurface] Declined a consent banner ("${banner.label}").`);
            await browser.settle(page);
        }
    }

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
        // With a handle, Enter lands on it; without one it lands wherever
        // focus is — after a click, on the thing just clicked.
        if (handle) await handle.press('Enter');
        else await page.keyboard.press('Enter');
    } catch (err) {
        return { ok: false, why: err.message };
    }
    await browser.settle(page);
    return { ok: true, detail: 'pressed Enter' };
}

// A transient panel — a date picker, an expanded dropdown — closes the way a
// person closes it: Escape, or a click on empty space beside it. While a
// light-dismiss layer is up the page marks everything behind it aria-hidden,
// so a spot inside a hidden region that hits nothing interactive is outside
// the panel and inert. Whatever was committed into the panel's fields stays.
async function dismiss() {
    try {
        await page.keyboard.press('Escape');
        await browser.settle(page);
        const spot = await page.evaluate(() => {
            const CONTROLS = 'a,button,input,select,textarea,summary,[role="button"],'
                + '[role="link"],[role="menuitem"],[role="tab"],[role="checkbox"],'
                + '[role="radio"],[role="combobox"],[role="option"],[role="textbox"],'
                + '[role="searchbox"],[role="listbox"],[role="slider"],[role="switch"]';
            const layers = Array.from(document.querySelectorAll('[aria-hidden="true"]'))
                .map(el => el.getBoundingClientRect())
                .filter(box => box.width > 40 && box.height > 20);
            for (const box of layers) {
                for (let y = box.top + 8; y < box.bottom - 4; y += 24) {
                    for (let x = box.left + 8; x < box.right - 4; x += 24) {
                        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
                        const at = document.elementFromPoint(x, y);
                        if (!at || !at.closest('[aria-hidden="true"]')) continue;
                        if (at.closest(CONTROLS)) continue;
                        return { x, y };
                    }
                }
            }
            return null;
        });
        if (spot) await page.mouse.click(spot.x, spot.y);
    } catch (err) {
        return { ok: false, why: err.message };
    }
    await browser.settle(page);
    return { ok: true, detail: 'left the panel' };
}

async function settle() {
    return browser.settle(page);
}

function touch() {
    browser.touch();
}

async function close() {
    page = null;
    hookedPage = null;
    downloads = [];
    return browser.close();
}

module.exports = {
    ready, start, observe, resolve, navigate, back, click, fill, submit, dismiss, settle, touch, close,
    takeDownloads, attachFiles,
    grantedOnly, TIER, name: 'dom'
};
