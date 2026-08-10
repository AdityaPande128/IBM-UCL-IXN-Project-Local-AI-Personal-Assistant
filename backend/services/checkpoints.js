// Checkpointed store snapshots (hardening #10). Each checkpoint is a
// consistent copy of every store the assistant owns: SQLite files are
// snapshotted with VACUUM INTO — safe against live WAL writers — and the
// plain-file stores are copied, all under a manifest of content hashes.
// Restore never destroys anything: the current state is checkpointed first,
// then the chosen snapshot is put back and the daemon restarts onto it.
//
// Deliberately excluded: the browser profile (a signed-in Chrome profile is
// credentials), the telegram token, and anything else that is a secret
// rather than state.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_PATH = path.join(__dirname, '..', '..', 'config.json');
const DEFAULT_ROOT = path.join(os.homedir(), '.jarvis', 'checkpoints');

const EXCLUDED = new Set(['browser-profile', 'telegram-token']);
const NAME = /^[\w.-]+$/;

let root = process.env.JARVIS_CHECKPOINTS_DIR || DEFAULT_ROOT;

function open(target = DEFAULT_ROOT) {
    root = target;
    return root;
}

function rootDir() {
    return root;
}

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function storeFiles(dataDir = DATA_DIR) {
    const found = [];
    const walk = (dir, base) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (EXCLUDED.has(entry.name)) continue;
            if (entry.name.endsWith('-wal') || entry.name.endsWith('-shm')) continue;
            const full = path.join(dir, entry.name);
            const rel = base ? path.join(base, entry.name) : entry.name;
            if (entry.isDirectory()) walk(full, rel);
            else if (entry.isFile()) found.push({ full, rel });
        }
    };
    walk(dataDir, '');
    return found;
}

// A consistent copy of every store into targetDir, plus config.json.
// Returns the manifest's file map.
function snapshotInto(targetDir, dataDir = DATA_DIR) {
    const files = {};
    for (const { full, rel } of storeFiles(dataDir)) {
        const target = path.join(targetDir, 'data', rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (rel.endsWith('.db')) {
            const db = new DatabaseSync(full, { readOnly: true });
            try {
                db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
            } finally {
                db.close();
            }
        } else {
            fs.copyFileSync(full, target);
        }
        files[path.join('data', rel)] = sha256(target);
    }
    if (fs.existsSync(CONFIG_PATH)) {
        fs.copyFileSync(CONFIG_PATH, path.join(targetDir, 'config.json'));
        files['config.json'] = sha256(path.join(targetDir, 'config.json'));
    }
    return files;
}

function stamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function create(label, { dataDir = DATA_DIR } = {}) {
    const name = label && NAME.test(label) ? `${stamp()}-${label}` : stamp();
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });

    const files = snapshotInto(dir, dataDir);
    const manifest = {
        format: 'jarvis-checkpoint/1',
        name,
        createdAt: new Date().toISOString(),
        label: label || null,
        files
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'),
        JSON.stringify(manifest, null, 2) + '\n');
    return { name, path: dir, files: Object.keys(files).length };
}

function list() {
    let entries;
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        return [];
    }
    const found = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
            const manifest = JSON.parse(
                fs.readFileSync(path.join(root, entry.name, 'manifest.json'), 'utf8'));
            found.push({
                name: entry.name,
                createdAt: manifest.createdAt,
                label: manifest.label,
                files: Object.keys(manifest.files || {}).length
            });
        } catch { }
    }
    return found.sort((a, b) => a.name.localeCompare(b.name));
}

function prune(keep) {
    const keepCount = Number.isInteger(keep) && keep > 0 ? keep : 5;
    const all = list();
    const removed = [];
    while (all.length > keepCount) {
        const oldest = all.shift();
        fs.rmSync(path.join(root, oldest.name), { recursive: true, force: true });
        removed.push(oldest.name);
    }
    return removed;
}

// A manifest names files by relative path, and those paths become write
// targets on restore — so a path that steps outside (absolute, or any ".."
// segment) makes the whole checkpoint invalid, not just the one entry.
function unsafeRel(rel) {
    if (typeof rel !== 'string' || !rel || path.isAbsolute(rel)) return true;
    return rel.split(/[\\/]/).some(part => !part || part === '.' || part === '..');
}

function verify(name) {
    const dir = path.join(root, name);
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    } catch {
        return { ok: false, reason: 'no readable manifest' };
    }
    for (const [rel, hash] of Object.entries(manifest.files || {})) {
        if (unsafeRel(rel)) return { ok: false, reason: `unsafe path in manifest: ${rel}` };
        const target = path.join(dir, rel);
        if (!fs.existsSync(target)) return { ok: false, reason: `missing: ${rel}` };
        if (sha256(target) !== hash) return { ok: false, reason: `altered: ${rel}` };
    }
    return { ok: true, manifest };
}

// Restoring over stores the running daemon holds open would race its own
// writers, so a restore happens in two acts: stage now, apply on the next
// boot before any store is opened. server.js calls applyPending() first
// thing; the wire handler stages and restarts the daemon.

function pendingPath() {
    return path.join(root, 'pending-restore.json');
}

function restore(name) {
    if (!NAME.test(String(name)) || String(name).includes('..')) {
        return { status: 'refused', reason: 'not a checkpoint name' };
    }
    const checked = verify(name);
    if (!checked.ok) {
        return { status: 'refused', reason: `the checkpoint does not verify: ${checked.reason}` };
    }
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(pendingPath(), JSON.stringify({
        name, requestedAt: new Date().toISOString()
    }, null, 2) + '\n');
    return {
        status: 'staged', name,
        files: Object.keys(checked.manifest.files).length,
        restarting: true
    };
}

function applyPending({
    dataDir = DATA_DIR,
    skillsDir = path.join(DATA_DIR, '..', 'skills'),
    configPath = CONFIG_PATH,
    log = console.log
} = {}) {
    let pending;
    try {
        pending = JSON.parse(fs.readFileSync(pendingPath(), 'utf8'));
    } catch {
        return { status: 'none' };
    }
    fs.rmSync(pendingPath(), { force: true });

    const checked = verify(pending.name);
    if (!checked.ok) {
        log(`[Checkpoints] Staged restore of "${pending.name}" refused: ${checked.reason}`);
        return { status: 'refused', name: pending.name, reason: checked.reason };
    }

    // The state being replaced is itself checkpointed first — a restore can
    // always be undone by restoring what it displaced. If that undo
    // checkpoint cannot be taken, nothing is touched.
    let undo;
    try {
        undo = create('pre-restore', { dataDir });
    } catch (err) {
        log(`[Checkpoints] Restore of "${pending.name}" refused: `
            + `the current state could not be checkpointed first (${err.message})`);
        return { status: 'refused', name: pending.name, reason: err.message };
    }

    // The undo checkpoint covers the data dir and config, but a restore can
    // also overwrite skills (bundle imports carry them) — so any skill file
    // about to be displaced is saved into the undo first.
    const undoDir = path.join(root, undo.name);
    const undoManifestPath = path.join(undoDir, 'manifest.json');
    const undoManifest = JSON.parse(fs.readFileSync(undoManifestPath, 'utf8'));
    let undoGrew = false;
    for (const rel of Object.keys(checked.manifest.files)) {
        if (!rel.startsWith('skills/')) continue;
        const displaced = path.join(skillsDir, rel.slice('skills/'.length));
        if (!fs.existsSync(displaced)) continue;
        const saved = path.join(undoDir, rel);
        fs.mkdirSync(path.dirname(saved), { recursive: true });
        fs.copyFileSync(displaced, saved);
        undoManifest.files[rel] = sha256(saved);
        undoGrew = true;
    }
    if (undoGrew) {
        fs.writeFileSync(undoManifestPath,
            JSON.stringify(undoManifest, null, 2) + '\n');
    }

    const dir = path.join(root, pending.name);
    for (const rel of Object.keys(checked.manifest.files)) {
        const source = path.join(dir, rel);
        let target;
        if (rel === 'config.json') target = configPath;
        else if (rel.startsWith('data/')) target = path.join(dataDir, rel.slice('data/'.length));
        else if (rel.startsWith('skills/')) target = path.join(skillsDir, rel.slice('skills/'.length));
        else continue;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
        // A restored database must not wake up beside a stale WAL.
        if (target.endsWith('.db')) {
            fs.rmSync(`${target}-wal`, { force: true });
            fs.rmSync(`${target}-shm`, { force: true });
        }
    }

    log(`[Checkpoints] Restored "${pending.name}" `
        + `(${Object.keys(checked.manifest.files).length} file(s)); undo: ${undo.name}`);
    return {
        status: 'restored', name: pending.name,
        files: Object.keys(checked.manifest.files).length,
        undo: undo.name
    };
}

module.exports = {
    open, rootDir, create, list, prune, verify, restore, applyPending,
    snapshotInto, storeFiles,
    DEFAULT_ROOT, DATA_DIR
};
