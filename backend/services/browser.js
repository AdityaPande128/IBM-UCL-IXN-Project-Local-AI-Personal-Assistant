const configReader = require('../utils/configReader');
const linkedBrowser = require('./linkedBrowser');

const config = configReader.readConfig();
const webConfig = config.web || {};

const HEADLESS = webConfig.headless !== false;
const IDLE_TIMEOUT_MS = webConfig.idle_timeout_ms ?? 120000;
const NAVIGATION_TIMEOUT_MS = webConfig.navigation_timeout_ms ?? 20000;
const ACTION_TIMEOUT_MS = webConfig.action_timeout_ms ?? 8000;

const USER_AGENT =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

const MODE = { EPHEMERAL: 'ephemeral', ATTACHED: 'attached' };

const SETTLE_QUIET_MS = webConfig.settle_quiet_ms ?? 600;
const SETTLE_TIMEOUT_MS = webConfig.settle_timeout_ms ?? 8000;

let browser = null;
let context = null;
let page = null;
let idleTimer = null;
let launching = null;
let mode = MODE.EPHEMERAL;

function clearIdleTimer() {
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
}

function touch() {
    clearIdleTimer();
    if (!IDLE_TIMEOUT_MS) return;
    idleTimer = setTimeout(() => { close().catch(() => {}); }, IDLE_TIMEOUT_MS);
    if (typeof idleTimer.unref === 'function') idleTimer.unref();
}

async function open(options = {}) {
    const wanted = options.mode || MODE.EPHEMERAL;

    if (page && !page.isClosed() && mode !== wanted) await close();

    if (page && !page.isClosed()) {
        touch();
        return page;
    }
    if (launching) return launching;

    mode = wanted;
    launching = wanted === MODE.ATTACHED ? attach() : launch();

    try {
        return await launching;
    } finally {
        launching = null;
    }
}

async function attach() {
    const { chromium } = require('playwright-core');

    const source = linkedBrowser.chosen();
    if (!linkedBrowser.exists() || !source) {
        throw new Error('the assistant has no browser profile of its own yet, so there is no '
            + 'signed-in session to use. Make one with: node tools/link-browser.js');
    }
    if (linkedBrowser.inUse()) {
        throw new Error(`the assistant's ${source.name} profile is already open in another `
            + 'window, and a profile can only be run by one browser at a time');
    }

    linkedBrowser.bind(source.name);

    context = await chromium.launchPersistentContext(linkedBrowser.PROFILE_DIR, {
        executablePath: source.binary,
        headless: HEADLESS,
        // Accepted downloads sit in Playwright's temporary area and die with
        // the context; only the web loop's policy gate can move one to disk.
        acceptDownloads: true,
        viewport: { width: 1680, height: 1000 },
        ignoreDefaultArgs: ['--use-mock-keychain', '--password-store=basic'],
        args: [
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-background-networking'
        ]
    });

    context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    context.setDefaultTimeout(ACTION_TIMEOUT_MS);

    page = context.pages()[0] || await context.newPage();

    const primary = page;
    context.on('page', extra => {
        if (extra !== primary) extra.close().catch(() => {});
    });

    page.on('dialog', dialog => { dialog.dismiss().catch(() => {}); });

    touch();
    return page;
}

async function launch() {
    {
        const { chromium } = require('playwright-core');

        browser = await chromium.launch({
            headless: HEADLESS,
            args: [
                '--disable-background-networking',
                '--disable-sync',
                '--no-first-run',
                '--no-default-browser-check'
            ]
        });

        context = await browser.newContext({
            userAgent: USER_AGENT,
            viewport: { width: 1680, height: 1000 },
            acceptDownloads: true,
            permissions: [],
            javaScriptEnabled: true
        });

        context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
        context.setDefaultTimeout(ACTION_TIMEOUT_MS);

        page = await context.newPage();

        const primary = page;
        context.on('page', extra => {
            if (extra !== primary) extra.close().catch(() => {});
        });

        page.on('dialog', dialog => { dialog.dismiss().catch(() => {}); });

        touch();
        return page;
    }
}

async function settle(target = page, { quietMs = SETTLE_QUIET_MS, timeoutMs = SETTLE_TIMEOUT_MS } = {}) {
    if (!target || target.isClosed()) return false;

    const deadline = Date.now() + timeoutMs;
    let previous = -1;
    let quietSince = null;

    while (Date.now() < deadline) {
        const sample = await target.evaluate(
            () => `${document.readyState}:${document.querySelectorAll('*').length}`
        ).catch(() => null);

        if (sample === null) return false;

        if (sample === previous) {
            if (quietSince === null) quietSince = Date.now();
            if (Date.now() - quietSince >= quietMs) return true;
        } else {
            previous = sample;
            quietSince = null;
        }
        await target.waitForTimeout(150);
    }
    return false;
}

async function goto(url, options = {}) {
    const target = await open({ mode: options.mode || mode });

    const response = await target.goto(url, { waitUntil: 'domcontentloaded' });
    if (options.settle !== false) await settle(target);
    touch();

    return {
        url: target.url(),
        status: response ? response.status() : null,
        title: await target.title().catch(() => '')
    };
}

async function current(options = {}) {
    return open(options);
}

function isOpen() {
    return Boolean(page && !page.isClosed());
}

function currentMode() {
    return isOpen() ? mode : null;
}

async function close() {
    clearIdleTimer();

    const closingBrowser = browser;
    const closingContext = context;
    const wasAttached = mode === MODE.ATTACHED;

    page = null;
    context = null;
    browser = null;
    mode = MODE.EPHEMERAL;

    if (wasAttached) {
        if (closingContext) await closingContext.close().catch(() => {});
        return;
    }
    if (closingBrowser) await closingBrowser.close().catch(() => {});
}

let attachRefusal = null;

async function attachAvailable() {
    if (page && !page.isClosed() && mode === MODE.ATTACHED) return true;

    if (!linkedBrowser.exists()) {
        attachRefusal = 'the assistant has no browser profile of its own yet';
        return false;
    }
    const source = linkedBrowser.chosen();
    if (!source) {
        attachRefusal = 'no supported browser is installed to run it with';
        return false;
    }
    if (linkedBrowser.inUse()) {
        attachRefusal = `the assistant's ${source.name} profile is open in another window`;
        return false;
    }
    return true;
}

function whyNotAttached() {
    return attachRefusal;
}

module.exports = {
    open,
    goto,
    settle,
    current,
    close,
    isOpen,
    currentMode,
    attachAvailable,
    whyNotAttached,
    touch,
    MODE,
    NAVIGATION_TIMEOUT_MS,
    ACTION_TIMEOUT_MS
};
