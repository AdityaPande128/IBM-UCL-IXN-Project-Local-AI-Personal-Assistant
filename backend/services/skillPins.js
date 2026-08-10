const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_PATH = path.join(__dirname, '..', 'data', 'skill-pins.json');

let storePath = null;

function open(target = DEFAULT_PATH) {
    storePath = target;
    return storePath;
}

function activePath() {
    return storePath || open();
}

function readStore() {
    try {
        return JSON.parse(fs.readFileSync(activePath(), 'utf8'));
    } catch {
        return {};
    }
}

function writeStore(store) {
    fs.mkdirSync(path.dirname(activePath()), { recursive: true });
    fs.writeFileSync(activePath(), JSON.stringify(store, null, 2) + '\n');
}

function walk(dir, files) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) files.push({ full, link: true });
        else if (entry.isDirectory()) walk(full, files);
        else if (entry.isFile()) files.push({ full, link: false });
    }
}

function hashDirectory(directory) {
    const files = [];
    walk(directory, files);
    files.sort((a, b) => a.full < b.full ? -1 : a.full > b.full ? 1 : 0);

    const hash = crypto.createHash('sha256');
    for (const { full, link } of files) {
        // A symlink is part of what the directory does — its target changing
        // must read as drift, so the link itself is hashed, not what it
        // points at. Regular files hash exactly as they always have.
        if (link) hash.update('link\0');
        hash.update(path.relative(directory, full));
        hash.update('\0');
        hash.update(link ? fs.readlinkSync(full) : fs.readFileSync(full));
        hash.update('\0');
    }
    return hash.digest('hex');
}

function pin(name, directory, version) {
    const store = readStore();
    store[name] = {
        hash: hashDirectory(directory),
        version: version || null,
        pinnedAt: new Date().toISOString()
    };
    writeStore(store);
    return store[name];
}

function verify(name, directory) {
    const pinned = readStore()[name];
    if (!pinned) return { ok: false, reason: 'unpinned' };
    if (hashDirectory(directory) !== pinned.hash) return { ok: false, reason: 'drifted' };
    return { ok: true };
}

function ensurePinned(name, directory, version) {
    if (!readStore()[name]) {
        pin(name, directory, version);
        return { ok: true, reason: 'first_seen' };
    }
    return verify(name, directory);
}

function remove(name) {
    const store = readStore();
    delete store[name];
    writeStore(store);
}

module.exports = { open, pin, verify, ensurePinned, remove, hashDirectory, DEFAULT_PATH };
