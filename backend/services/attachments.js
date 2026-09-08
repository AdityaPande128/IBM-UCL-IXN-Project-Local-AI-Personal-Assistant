const fs = require('fs');
const path = require('path');
const os = require('os');

const configReader = require('../utils/configReader');
const webPolicy = require('../security/webPolicy');

const config = configReader.readConfig();
const SETTINGS = config.web || {};

function expandHome(target) {
    const value = String(target || '');
    return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

function downloadDir() {
    return path.resolve(expandHome(SETTINGS.download_dir || '~/Downloads'));
}

// A name collision never overwrites what the user already has.
function landing(dir, name) {
    const extension = path.extname(name);
    const stem = name.slice(0, name.length - extension.length);
    let target = path.join(dir, name);
    for (let n = 2; fs.existsSync(target); n++) {
        target = path.join(dir, `${stem} (${n})${extension}`);
    }
    return target;
}

// Every download the browser produces passes through here exactly once.
// Unmandated or runnable, it is cancelled where it sits — in the browser's
// temporary area — and never reaches anywhere the user looks.
async function admit(download, { mandate, dir, evidence } = {}) {
    const offered = typeof download.suggestedFilename === 'function'
        ? download.suggestedFilename()
        : 'download';

    const verdict = webPolicy.checkDownload({ filename: offered, mandate, evidence });
    if (!verdict.allowed) {
        if (typeof download.cancel === 'function') {
            await download.cancel().catch(() => {});
        }
        return { saved: null, name: webPolicy.sanitizeFilename(offered),
                 reason: verdict.reason, refusal: verdict.refusal };
    }

    const where = path.resolve(dir || downloadDir());
    fs.mkdirSync(where, { recursive: true });
    const target = landing(where, verdict.filename);
    await download.saveAs(target);

    let bytes = 0;
    try { bytes = fs.statSync(target).size; } catch { }
    return { saved: { path: target, name: path.basename(target), bytes },
             reason: verdict.reason, refusal: null };
}

// Two readings of "a path was written": with an extension it may carry
// spaces; without one (id_rsa, Makefile) it ends at the first space. The
// longer capture wins.
const PATHISH = /(?:~\/|\/)[\w.\-/ ]*\.[A-Za-z0-9]{1,8}/;
const BARE_PATH = /(?:~\/|\/)[\w.\-/]+/;

function writtenPath(words) {
    const found = [
        (words.match(PATHISH) || [])[0],
        (words.match(BARE_PATH) || [])[0]
    ].filter(Boolean);
    if (!found.length) return null;
    return found.sort((a, b) => b.length - a.length)[0].trim();
}

const FILLER = new Set(['attach', 'attached', 'attaching', 'file', 'the', 'my', 'a', 'an',
    'to', 'and', 'of', 'in', 'it', 'that', 'this', 'send', 'email', 'mail', 'forward',
    'with', 'please', 'saying', 'called', 'named']);

// Which file leaves the machine is settled here, from the user's words alone,
// before any page has been observed — a page cannot nominate a file, because
// by the time one is on screen this question has already been answered.
async function resolveOutgoing(reference, { roots } = {}) {
    const words = String(reference || '').trim();
    if (!words) return null;

    const written = writtenPath(words);
    if (written) {
        const full = path.resolve(expandHome(written));
        try {
            const stat = fs.statSync(full);
            if (stat.isFile()) {
                const securityStore = require('../security/store');
                const outside = !securityStore.isWithinGrantedRoot(full, 'documents');
                return { file: { path: full, name: path.basename(full), bytes: stat.size },
                         ...(outside ? { outside: written } : {}) };
            }
        } catch { }
        return { missing: written };
    }

    const fileIndex = require('./fileIndex');
    const terms = words.toLowerCase()
        .split(/[^\p{L}\p{N}.]+/u)
        .filter(term => term.length >= 2 && !FILLER.has(term))
        .join(' ');
    if (!terms) return null;

    let hits;
    try {
        hits = fileIndex.search({ text: terms, dir: roots, limit: 6 });
    } catch {
        return null;
    }

    if (!hits.length) return null;
    if (hits.length === 1) {
        const only = hits[0];
        return { file: { path: only.path, name: only.name, bytes: only.size } };
    }
    return { candidates: hits.map(hit => ({ path: hit.path, name: hit.name, bytes: hit.size })) };
}

module.exports = { admit, resolveOutgoing, downloadDir, landing };
