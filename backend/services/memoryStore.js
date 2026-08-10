const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const configReader = require('../utils/configReader');

const DEFAULT_PATH = path.join(__dirname, '..', 'data', 'memory.db');

const config = configReader.readConfig();
const SETTINGS = config.memory || {};

// Demotion and promotion are rule passes, no model involved (architecture §3.1).
const FACT_ARCHIVE_DAYS = SETTINGS.fact_archive_days ?? 180;
const EPISODE_ARCHIVE_DAYS = SETTINGS.episode_archive_days ?? 90;
const RECENCY_HALF_LIFE_DAYS = SETTINGS.recency_half_life_days ?? 90;
const RECENCY_WEIGHT = SETTINGS.recency_weight ?? 0.05;

const DAY_MS = 24 * 60 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS facts (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    embedding BLOB,
    embedding_model TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    pinned INTEGER NOT NULL DEFAULT 0,
    superseded_by TEXT,
    source TEXT NOT NULL DEFAULT 'user',
    created_at INTEGER NOT NULL,
    last_recalled_at INTEGER
);
CREATE TABLE IF NOT EXISTS episodes (
    id TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    embedding BLOB,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL
);
`;

let db = null;
let dbPath = null;

function open(target = DEFAULT_PATH) {
    if (db && dbPath === target) return db;
    if (db) close();

    if (target !== ':memory:') fs.mkdirSync(path.dirname(target), { recursive: true });
    db = new DatabaseSync(target);
    dbPath = target;
    db.exec('PRAGMA journal_mode = WAL');
    // Hard deletion must mean deletion: SQLite zeroes freed pages, so a
    // removed fact is not recoverable by reading the file.
    db.exec('PRAGMA secure_delete = ON');
    db.exec(SCHEMA);
    return db;
}

function close() {
    if (db) {
        db.close();
        db = null;
        dbPath = null;
    }
}

function ensure() {
    if (!db) open();
    return db;
}

function pack(vector) {
    return vector ? Buffer.from(new Float32Array(vector).buffer) : null;
}

function unpack(blob) {
    if (!blob) return null;
    const raw = Buffer.from(blob);
    return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

function inflate(row) {
    return { ...row, pinned: Boolean(row.pinned), embedding: undefined };
}

function remember({ text, vector = null, embeddingModel = null, source = 'user' }) {
    ensure();
    const words = String(text || '').trim();
    if (!words) throw new Error('a memory needs words');

    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO facts (id, text, embedding, embedding_model, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, words, pack(vector), embeddingModel, source, Date.now());
    return get(id);
}

function get(id) {
    ensure();
    const row = db.prepare('SELECT * FROM facts WHERE id = ?').get(id);
    return row ? inflate(row) : null;
}

function list({ status = 'active', limit = 200 } = {}) {
    ensure();
    const rows = status === 'all'
        ? db.prepare('SELECT * FROM facts ORDER BY created_at DESC LIMIT ?').all(limit)
        : db.prepare('SELECT * FROM facts WHERE status = ? ORDER BY created_at DESC LIMIT ?')
            .all(status, limit);
    return rows.map(inflate);
}

function cosine(a, b) {
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    const scale = Math.sqrt(magA) * Math.sqrt(magB);
    return scale ? dot / scale : 0;
}

// Recall: cosine + a small additive recency prior, so an old but highly
// relevant fact still wins. Pinned facts are always eligible; superseded and
// archived rows never surface unless explicitly asked for (§3.1).
function search(queryVector, { topK = 5, minScore = 0.35, includeArchived = false, now = Date.now() } = {}) {
    ensure();
    const statuses = includeArchived ? ['active', 'archived'] : ['active'];
    const rows = db.prepare(
        `SELECT * FROM facts WHERE status IN (${statuses.map(() => '?').join(',')})`)
        .all(...statuses);

    const scored = [];
    for (const row of rows) {
        const vector = unpack(row.embedding);
        if (!vector) continue;
        const similarity = cosine(queryVector, vector);
        const ageDays = (now - row.created_at) / DAY_MS;
        const recency = RECENCY_WEIGHT * Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
        const score = similarity + recency;
        if (similarity >= minScore || row.pinned) {
            scored.push({ ...inflate(row), score, similarity, age_days: Math.floor(ageDays) });
        }
    }

    scored.sort((a, b) => b.score - a.score);
    const kept = scored.slice(0, topK);

    if (kept.length) {
        const touch = db.prepare('UPDATE facts SET last_recalled_at = ? WHERE id = ?');
        for (const hit of kept) touch.run(now, hit.id);
    }
    return kept;
}

// Supersession keeps the audit trail of what the assistant used to believe;
// only the user's hard delete removes it (§3.1).
function supersede(oldId, newId) {
    ensure();
    const changed = db.prepare(
        `UPDATE facts SET status = 'superseded', superseded_by = ? WHERE id = ? AND status != 'superseded'`)
        .run(newId, oldId).changes;
    return changed > 0;
}

function setPinned(id, pinned) {
    ensure();
    db.prepare('UPDATE facts SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id);
    return get(id);
}

function hardDelete(ids) {
    ensure();
    const remove = db.prepare('DELETE FROM facts WHERE id = ?');
    let removed = 0;
    for (const id of ids || []) removed += remove.run(id).changes;
    return removed;
}

// The reviewable hit list behind "forget everything about X": plain substring
// over every tier including what was superseded — a wipe must find it all.
function wipeCandidates(term) {
    ensure();
    const needle = `%${String(term || '').trim()}%`;
    if (needle === '%%') return [];
    return db.prepare(
        `SELECT * FROM facts WHERE text LIKE ? COLLATE NOCASE ORDER BY created_at DESC`)
        .all(needle).map(inflate);
}

function wipeAll() {
    ensure();
    const removed = db.prepare('DELETE FROM facts').run().changes
        + db.prepare('DELETE FROM episodes').run().changes;
    db.exec('VACUUM');
    return removed;
}

// The nightly rule pass (§3.1): unpinned facts unrecalled past the horizon
// archive; episodes age out on their own clock. No model involved.
function nightly(now = Date.now()) {
    ensure();
    const factHorizon = now - FACT_ARCHIVE_DAYS * DAY_MS;
    const archivedFacts = db.prepare(
        `UPDATE facts SET status = 'archived'
         WHERE status = 'active' AND pinned = 0
           AND COALESCE(last_recalled_at, created_at) < ?`)
        .run(factHorizon).changes;

    const episodeHorizon = now - EPISODE_ARCHIVE_DAYS * DAY_MS;
    const archivedEpisodes = db.prepare(
        `UPDATE episodes SET status = 'archived'
         WHERE status = 'active' AND created_at < ?`)
        .run(episodeHorizon).changes;

    return { archivedFacts, archivedEpisodes };
}

function restore(id) {
    ensure();
    db.prepare(`UPDATE facts SET status = 'active' WHERE id = ? AND status = 'archived'`)
        .run(id);
    return get(id);
}

function stats() {
    ensure();
    const count = status => db.prepare(
        'SELECT COUNT(*) AS n FROM facts WHERE status = ?').get(status).n;
    return {
        active: count('active'),
        archived: count('archived'),
        superseded: count('superseded'),
        secure_delete: db.prepare('PRAGMA secure_delete').get().secure_delete === 1
    };
}

module.exports = {
    open, close, remember, get, list, search, supersede, setPinned,
    hardDelete, wipeCandidates, wipeAll, nightly, restore, stats,
    cosine, DEFAULT_PATH, FACT_ARCHIVE_DAYS
};
