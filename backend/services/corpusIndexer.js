const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const embedClient = require('./embedClient');
const vectorIndex = require('./vectorIndex');
const classifier = require('../security/classifier');
const securityLabels = require('../security/labels');
const securityStore = require('../security/store');
const fileIndex = require('./fileIndex');

const TEXT_EXTENSIONS = new Set([
    '.txt', '.md', '.markdown', '.rst', '.org',
    '.csv', '.tsv', '.json', '.yaml', '.yml',
    '.js', '.ts', '.py', '.sh', '.html', '.css'
]);

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CHUNK_CHARS = 1200;
const MIN_CHUNK_CHARS = 40;

const SKIP_DIRS = new Set([
    'node_modules', '.git', '.venv', 'venv', '__pycache__',
    'dist', 'build', 'target', '.next', '.cache', 'Library'
]);

function expandHome(p) {
    return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function hash(text) {
    return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}


function discover(root, { extensions = TEXT_EXTENSIONS, maxDepth = 8, onExcluded } = {}) {
    const found = [];

    const walk = (dir, depth) => {
        if (depth > maxDepth) return;

        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const full = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name)) continue;
                const dirCheck = classifier.secretCheck(path.join(full, 'probe'));
                if (dirCheck.secret) {
                    if (onExcluded) onExcluded(full, dirCheck.reason);
                    continue;
                }
                walk(full, depth + 1);
                continue;
            }
            if (!entry.isFile()) continue;
            if (!extensions.has(path.extname(entry.name).toLowerCase())) continue;

            const check = classifier.secretCheck(full);
            if (check.secret) {
                if (onExcluded) onExcluded(full, check.reason);
                continue;
            }

            try {
                if (fs.statSync(full).size > MAX_FILE_BYTES) continue;
            } catch {
                continue;
            }
            found.push(full);
        }
    };

    walk(expandHome(root), 0);
    return found;
}

function chunk(text, { maxChars = MAX_CHUNK_CHARS, minChars = MIN_CHUNK_CHARS } = {}) {
    const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    const chunks = [];

    for (const paragraph of paragraphs) {
        if (paragraph.length <= maxChars) {
            chunks.push(paragraph);
            continue;
        }

        let current = '';
        for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
            if (current && current.length + sentence.length + 1 > maxChars) {
                chunks.push(current.trim());
                current = '';
            }
            if (sentence.length > maxChars) {
                for (let i = 0; i < sentence.length; i += maxChars) {
                    chunks.push(sentence.slice(i, i + maxChars).trim());
                }
                continue;
            }
            current += (current ? ' ' : '') + sentence;
        }
        if (current.trim()) chunks.push(current.trim());
    }

    return chunks.filter(c => c.length >= minChars);
}


function parseEmlx(raw) {
    const withoutLength = raw.replace(/^\d+\s*\n/, '');
    const plistAt = withoutLength.indexOf('<?xml');
    const message = plistAt === -1 ? withoutLength : withoutLength.slice(0, plistAt);

    const split = message.search(/\r?\n\r?\n/);
    if (split === -1) return null;

    const headerBlock = message.slice(0, split);
    let body = message.slice(split).trim();

    const header = name => {
        const match = headerBlock.match(new RegExp(`^${name}:\\s*(.+)$`, 'im'));
        return match ? match[1].trim() : '';
    };

    const boundary = (headerBlock.match(/boundary="?([^";\r\n]+)"?/i) || [])[1];
    if (boundary) {
        const parts = body.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
        const plain = parts.find(p => /content-type:\s*text\/plain/i.test(p));
        if (plain) {
            const partSplit = plain.search(/\r?\n\r?\n/);
            body = partSplit === -1 ? plain : plain.slice(partSplit).trim();
        }
    }

    if (/^\s*$/.test(body)) return null;

    return {
        subject: header('Subject'),
        from: header('From'),
        to: header('To'),
        date: header('Date'),
        body: body.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    };
}

function mailRoots() {
    const base = path.join(os.homedir(), 'Library', 'Mail');
    if (!fs.existsSync(base)) return [];

    try {
        return fs.readdirSync(base)
            .filter(name => /^V\d+$/.test(name))
            .map(name => path.join(base, name));
    } catch {
        return [];
    }
}


function recordsForFile(file, { kind = 'document' } = {}) {
    const classification = classifier.classify(file, {
        origin: kind === 'mail' ? securityLabels.ORIGIN.APP : securityLabels.ORIGIN.FILE
    });
    if (!classification.readable) return [];

    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch {
        return [];
    }

    const label = securityLabels.serialise(classification.label);

    if (kind === 'mail') {
        const mail = parseEmlx(raw);
        if (!mail) return [];

        const header = `Email from ${mail.from || 'unknown'}${mail.subject ? ` — subject: ${mail.subject}` : ''}${mail.date ? ` (${mail.date})` : ''}`;

        return chunk(mail.body).map((text, i) => ({
            text: `${header}\n${text}`,
            meta: {
                kind: 'mail',
                path: file,
                chunk: i,
                subject: mail.subject,
                from: mail.from,
                date: mail.date,
                hash: hash(`${file}:${i}:${text}`),
                label,
                text
            }
        }));
    }

    const name = path.basename(file);
    return chunk(raw).map((text, i) => ({
        text: `${name}\n${text}`,
        meta: {
            kind: 'document',
            path: file,
            chunk: i,
            name,
            hash: hash(`${file}:${i}:${text}`),
            label,
            text
        }
    }));
}

async function build({ name, roots, kind = 'document', extensions, dir,
                       log = () => {}, requireConsent = true }) {
    if (requireConsent) {
        const ungranted = roots.filter(root =>
            !securityStore.isWithinGrantedRoot(expandHome(root), name));
        if (ungranted.length) {
            throw new Error(
                `not granted for content indexing: ${ungranted.join(', ')}. ` +
                `Grant with: node tools/index-corpus.js ${name} ${ungranted[0]}`
            );
        }
    }

    const collection = vectorIndex.collection(name, dir);
    collection.ensureLoaded();

    const existing = new Map();
    for (let row = 0; row < collection.meta.length; row++) {
        const meta = collection.meta[row];
        if (!meta.hash) continue;
        existing.set(meta.hash, collection.vectors.slice(row * vectorIndex.DIM, (row + 1) * vectorIndex.DIM));
    }

    const fileExtensions = extensions || (kind === 'mail' ? new Set(['.emlx']) : TEXT_EXTENSIONS);

    const files = [];
    for (const root of roots) files.push(...discover(root, { extensions: fileExtensions }));
    log(`found ${files.length} file(s)`);

    const records = [];
    for (const file of files) records.push(...recordsForFile(file, { kind }));
    log(`produced ${records.length} chunk(s)`);

    const fresh = records.filter(r => !existing.has(r.meta.hash));
    const reused = records.length - fresh.length;
    log(`${reused} unchanged, ${fresh.length} to embed`);

    let vectors = [];
    if (fresh.length) {
        vectors = await embedClient.embedAll(fresh.map(r => r.text), {
            onProgress: (done, total) => {
                if (done % 128 === 0 || done === total) log(`embedded ${done}/${total}`);
            }
        });
    }

    const freshVectors = new Map();
    fresh.forEach((record, i) => freshVectors.set(record.meta.hash, vectors[i]));

    const rows = records.map(record => ({
        vector: Array.from(freshVectors.get(record.meta.hash) || existing.get(record.meta.hash)),
        meta: record.meta
    }));

    collection.replace(rows).save();

    let marked = 0;
    try {
        marked = fileIndex.markContentIndexed(files);
    } catch (err) {
        log(`could not update the file index: ${err.message}`);
    }

    return { indexed: rows.length, files: files.length, skipped: 0, reused, marked };
}

module.exports = {
    build, discover, chunk, parseEmlx, mailRoots, recordsForFile,
    expandHome, hash, TEXT_EXTENSIONS, MAX_CHUNK_CHARS
};
