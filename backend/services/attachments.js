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
async function admit(download, { mandate, dir } = {}) {
    const offered = typeof download.suggestedFilename === 'function'
        ? download.suggestedFilename()
        : 'download';

    const verdict = webPolicy.checkDownload({ filename: offered, mandate });
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

const PATHISH = /(?:~\/|\/)[\w.\-/ ]*\.[A-Za-z0-9]{1,8}/;

const FILLER = new Set(['attach', 'attached', 'attaching', 'file', 'the', 'my', 'a', 'an',
    'to', 'and', 'of', 'in', 'it', 'that', 'this', 'send', 'email', 'mail', 'forward',
    'with', 'please', 'saying', 'called', 'named']);

// Which file leaves the machine is settled here, from the user's words alone,
// before any page has been observed — a page cannot nominate a file, because
// by the time one is on screen this question has already been answered.
async function resolveOutgoing(reference, { roots } = {}) {
    const words = String(reference || '').trim();
    if (!words) return null;

    const written = (words.match(PATHISH) || [])[0];
    if (written) {
        const full = path.resolve(expandHome(written.trim()));
        try {
            const stat = fs.statSync(full);
            if (stat.isFile()) {
                return { file: { path: full, name: path.basename(full), bytes: stat.size } };
            }
        } catch { }
        return { missing: written.trim() };
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
