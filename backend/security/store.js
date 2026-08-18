const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const labels = require('./labels');

const DEFAULT_PATH = process.env.JARVIS_SECURITY_DB
    || path.join(__dirname, '..', 'data', 'security.db');

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT    NOT NULL,
    channel     TEXT    NOT NULL,   -- where the data was going: 'network', 'message', ...
    action      TEXT    NOT NULL,   -- what was attempted, e.g. 'http.post'
    decision    TEXT    NOT NULL,   -- allow | approve | deny
    label       TEXT    NOT NULL,   -- serialised label of the data crossing
    destination TEXT,
    summary     TEXT,
    detail      TEXT,               -- JSON, free-form
    approval_id INTEGER             -- set when the decision came from a human
);

CREATE INDEX IF NOT EXISTS audit_ts       ON audit (ts);
CREATE INDEX IF NOT EXISTS audit_decision ON audit (decision);

CREATE TABLE IF NOT EXISTS approvals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT    NOT NULL,
    channel     TEXT    NOT NULL,
    action      TEXT    NOT NULL,
    label       TEXT    NOT NULL,
    destination TEXT,
    summary     TEXT    NOT NULL,   -- what the user is being asked to allow
    preview     TEXT,               -- what would actually leave
    status      TEXT    NOT NULL DEFAULT 'pending',  -- pending | granted | denied | expired | used
    resolved_ts TEXT
);

CREATE INDEX IF NOT EXISTS approvals_status ON approvals (status);

CREATE TABLE IF NOT EXISTS roots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    path        TEXT    NOT NULL,
    collection  TEXT    NOT NULL,
    granted_ts  TEXT    NOT NULL,
    revoked_ts  TEXT,
    UNIQUE (path, collection)
);

-- The same idea as roots, for the web. A granted site is one the assistant may
-- operate on using a browser that carries the user's real sessions, and the
-- list is short and named by hand for the same reason the folder list is: the
-- alternative is an assistant whose reach is whatever it happens to be logged
-- into, which is not something the user ever decided.
CREATE TABLE IF NOT EXISTS sites (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    host        TEXT    NOT NULL UNIQUE,
    label       TEXT,               -- what the user calls it, for the planner
    granted_ts  TEXT    NOT NULL,
    revoked_ts  TEXT
);
`;

let db = null;
let dbPath = null;

function now() {
    return new Date().toISOString();
}

function open(target = DEFAULT_PATH) {
    if (db && dbPath === target) return db;
    if (db) close();

    fs.mkdirSync(path.dirname(target), { recursive: true });
    db = new DatabaseSync(target);
    dbPath = target;

    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

    prune();

    return db;
}

function handle() {
    return db || open();
}

// The audit table is append-only by design — this module offers no way to
// rewrite what happened. Settled approvals, though, age out: they are
// working state, not testimony.
const RETAIN_DAYS = 90;

function prune(now = Date.now()) {
    const cutoff = new Date(now - RETAIN_DAYS * 24 * 3600 * 1000).toISOString();
    const approvals = handle()
        .prepare("DELETE FROM approvals WHERE status != 'pending' AND ts < ?")
        .run(cutoff).changes;
    return { approvals };
}

function close() {
    if (db) {
        db.close();
        db = null;
        dbPath = null;
    }
}


function recordDecision(entry) {
    const statement = handle().prepare(`
        INSERT INTO audit (ts, channel, action, decision, label, destination, summary, detail, approval_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = statement.run(
        now(),
        String(entry.channel || 'unknown'),
        String(entry.action || 'unknown'),
        String(entry.decision || 'deny'),
        labels.serialise(entry.label),
        entry.destination ?? null,
        entry.summary ?? null,
        entry.detail ? JSON.stringify(entry.detail) : null,
        entry.approvalId ?? null
    );
    return Number(result.lastInsertRowid);
}

function recentDecisions(limit = 50) {
    return handle()
        .prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?')
        .all(limit)
        .map(row => ({ ...row, label: labels.deserialise(row.label) }));
}

function decisionsSince(ts, limit = 200) {
    return handle()
        .prepare('SELECT * FROM audit WHERE ts >= ? ORDER BY id DESC LIMIT ?')
        .all(String(ts), limit)
        .map(row => ({ ...row, label: labels.deserialise(row.label) }));
}

function approvalsSince(ts, limit = 100) {
    return handle()
        .prepare(`SELECT * FROM approvals
                  WHERE ts >= ? OR (resolved_ts IS NOT NULL AND resolved_ts >= ?)
                  ORDER BY id DESC LIMIT ?`)
        .all(String(ts), String(ts), limit);
}


function requestApproval(request) {
    const statement = handle().prepare(`
        INSERT INTO approvals (ts, channel, action, label, destination, summary, preview, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `);
    const result = statement.run(
        now(),
        String(request.channel || 'unknown'),
        String(request.action || 'unknown'),
        labels.serialise(request.label),
        request.destination ?? null,
        String(request.summary || request.action || 'unnamed action'),
        request.preview ?? null
    );
    return Number(result.lastInsertRowid);
}

function pendingApprovals() {
    return handle()
        .prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY id ASC")
        .all()
        .map(row => ({ ...row, label: labels.deserialise(row.label) }));
}

function getApproval(id) {
    const row = handle().prepare('SELECT * FROM approvals WHERE id = ?').get(id);
    return row ? { ...row, label: labels.deserialise(row.label) } : null;
}

// An approval the user granted authorises exactly one retry of the same
// disclosure, and only for a short while: the grant is consumed on use.
const GRANT_TTL_MS = 10 * 60 * 1000;

function takeGrant(request) {
    const destination = request.destination ?? null;
    // The summary is what the approval card showed; a grant redeems only the
    // exact disclosure the user read, not any action sharing its shape.
    const row = handle().prepare(`
        SELECT * FROM approvals
        WHERE status = 'granted' AND channel = ? AND action = ?
          AND destination IS ? AND summary = ?
        ORDER BY resolved_ts DESC LIMIT 1
    `).get(
        String(request.channel || 'unknown'),
        String(request.action || 'unknown'),
        destination,
        String(request.summary || request.action || 'unnamed action')
    );
    if (!row) return null;
    if (Date.now() - Date.parse(row.resolved_ts) > GRANT_TTL_MS) {
        handle().prepare("UPDATE approvals SET status = 'expired' WHERE id = ? AND status = 'granted'")
            .run(row.id);
        return null;
    }
    const taken = handle()
        .prepare("UPDATE approvals SET status = 'used' WHERE id = ? AND status = 'granted'")
        .run(row.id);
    if (taken.changes === 0) return null;
    return { ...row, label: labels.deserialise(row.label) };
}

// takeGrant without the consumption: whether a grant would redeem, leaving
// it untouched for the caller that must first know every channel passes.
function peekGrant(request) {
    const destination = request.destination ?? null;
    const row = handle().prepare(`
        SELECT * FROM approvals
        WHERE status = 'granted' AND channel = ? AND action = ?
          AND destination IS ? AND summary = ?
        ORDER BY resolved_ts DESC LIMIT 1
    `).get(
        String(request.channel || 'unknown'),
        String(request.action || 'unknown'),
        destination,
        String(request.summary || request.action || 'unnamed action')
    );
    if (!row) return null;
    if (Date.now() - Date.parse(row.resolved_ts) > GRANT_TTL_MS) return null;
    return { id: row.id };
}

function resolveApproval(id, granted) {
    const result = handle().prepare(`
        UPDATE approvals SET status = ?, resolved_ts = ?
        WHERE id = ? AND status = 'pending'
    `).run(granted ? 'granted' : 'denied', now(), id);
    return result.changes > 0;
}


function grantRoot(rootPath, collection) {
    const resolved = path.resolve(rootPath);
    handle().prepare(`
        INSERT INTO roots (path, collection, granted_ts, revoked_ts)
        VALUES (?, ?, ?, NULL)
        ON CONFLICT (path, collection)
        DO UPDATE SET granted_ts = excluded.granted_ts, revoked_ts = NULL
    `).run(resolved, collection, now());
    return resolved;
}

function revokeRoot(rootPath, collection) {
    const result = handle().prepare(`
        UPDATE roots SET revoked_ts = ?
        WHERE path = ? AND collection = ? AND revoked_ts IS NULL
    `).run(now(), path.resolve(rootPath), collection);
    return result.changes > 0;
}

function grantedRoots(collection) {
    const rows = collection
        ? handle().prepare('SELECT * FROM roots WHERE collection = ? AND revoked_ts IS NULL').all(collection)
        : handle().prepare('SELECT * FROM roots WHERE revoked_ts IS NULL').all();
    return rows;
}

function isWithinGrantedRoot(target, collection) {
    const resolved = path.resolve(target);
    return grantedRoots(collection).some(row => {
        const base = path.resolve(row.path);
        return resolved === base || resolved.startsWith(base + path.sep);
    });
}


function normaliseHost(value) {
    const text = String(value || '').trim().toLowerCase();
    if (!text) return null;
    try {
        return new URL(text.includes('://') ? text : `https://${text}`).hostname || null;
    } catch {
        return null;
    }
}

function grantSite(host, { label = null } = {}) {
    const canonical = normaliseHost(host);
    if (!canonical) throw new Error(`"${host}" is not a hostname`);

    handle().prepare(`
        INSERT INTO sites (host, label, granted_ts, revoked_ts)
        VALUES (?, ?, ?, NULL)
        ON CONFLICT (host)
        DO UPDATE SET granted_ts = excluded.granted_ts, label = excluded.label, revoked_ts = NULL
    `).run(canonical, label, now());

    return canonical;
}

function revokeSite(host) {
    const canonical = normaliseHost(host);
    if (!canonical) return false;
    const result = handle().prepare(
        'UPDATE sites SET revoked_ts = ? WHERE host = ? AND revoked_ts IS NULL'
    ).run(now(), canonical);
    return result.changes > 0;
}

function grantedSites() {
    return handle()
        .prepare('SELECT host, label, granted_ts FROM sites WHERE revoked_ts IS NULL ORDER BY host')
        .all();
}

function isGrantedSite(target) {
    const host = normaliseHost(target);
    if (!host) return false;

    return grantedSites().some(row => host === row.host || host.endsWith(`.${row.host}`));
}

module.exports = {
    open,
    close,
    handle,
    DEFAULT_PATH,
    SCHEMA_VERSION,
    recordDecision,
    recentDecisions,
    decisionsSince,
    approvalsSince,
    requestApproval,
    pendingApprovals,
    getApproval,
    resolveApproval,
    takeGrant,
    peekGrant,
    prune,
    grantRoot,
    revokeRoot,
    grantedRoots,
    isWithinGrantedRoot,
    grantSite,
    revokeSite,
    grantedSites,
    isGrantedSite,
    normaliseHost
};
