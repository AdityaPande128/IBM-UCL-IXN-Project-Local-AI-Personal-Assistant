const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const configReader = require('../utils/configReader');
const activityBus = require('./activityBus');
const intentQueue = require('./intentQueue');
const procedureStore = require('./procedureStore');
const webPolicy = require('../security/webPolicy');

const DEFAULT_PATH = path.join(__dirname, '..', 'data', 'watchers.db');

const config = configReader.readConfig();
const SETTINGS = config.watchers || {};
const TICK_MS = SETTINGS.tick_ms ?? 60000;
const DEFAULT_INTERVAL_MINUTES = SETTINGS.default_interval_minutes ?? 60;
const MAX_NOTICE_CHARS = 1200;
const MAX_KEPT_CHARS = 20000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS watchers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    target TEXT NOT NULL,
    args TEXT NOT NULL DEFAULT '{}',
    interval_minutes INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    last_run_at INTEGER,
    last_status TEXT,
    last_error TEXT,
    last_digest TEXT,
    last_text TEXT
);
CREATE TABLE IF NOT EXISTS notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    watcher_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    seen INTEGER NOT NULL DEFAULT 0
);
`;

let db = null;
let dbPath = null;
let ticker = null;
let runner = null;

function open(target = DEFAULT_PATH) {
    if (db && dbPath === target) return db;
    if (db) close();

    fs.mkdirSync(path.dirname(target), { recursive: true });
    db = new DatabaseSync(target);
    dbPath = target;
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA);
    return db;
}

function close() {
    if (ticker) {
        clearInterval(ticker);
        ticker = null;
    }
    if (db) {
        db.close();
        db = null;
        dbPath = null;
    }
}

// Ensure a database is open without moving it: only an explicit open(target)
// may choose the path, so a test pointing at its own file stays pointed there.
function ensure() {
    if (!db) open();
    return db;
}

// Watchers replay recipes on their own, with nobody watching the approval
// surface — so a recipe is only watchable when replaying it cannot press
// anything irreversible. The check is at attach time and again before every
// run, because a procedure can be re-recorded under the same name.
function unwatchable(procedure) {
    if (!procedure) return 'no such recipe';
    const step = (procedure.steps || []).find(entry =>
        entry.action === 'click'
        && webPolicy.IRREVERSIBLE.some(rule => rule.pattern.test(String(entry.name || ''))));
    if (step) {
        return `its step presses "${step.name}", which is irreversible — `
            + 'a watcher may only look, never act';
    }
    return null;
}

function add({ name, target, args = {}, intervalMinutes } = {}) {
    ensure();

    const procedure = procedureStore.get(target);
    const objection = unwatchable(procedure);
    if (objection) throw new Error(`"${target}" cannot be watched: ${objection}`);

    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO watchers
        (id, name, target, args, interval_minutes, enabled, created_at)
        VALUES (?, ?, ?, ?, ?, 1, ?)`)
        .run(id, String(name || target), String(target), JSON.stringify(args),
            Math.max(1, Math.round(intervalMinutes || DEFAULT_INTERVAL_MINUTES)),
            Date.now());
    return get(id);
}

function get(id) {
    ensure();
    const row = db.prepare('SELECT * FROM watchers WHERE id = ?').get(id);
    return row ? inflate(row) : null;
}

function list() {
    ensure();
    return db.prepare('SELECT * FROM watchers ORDER BY created_at').all().map(inflate);
}

function remove(id) {
    ensure();
    db.prepare('DELETE FROM notices WHERE watcher_id = ?').run(id);
    return db.prepare('DELETE FROM watchers WHERE id = ?').run(id).changes > 0;
}

function setEnabled(id, enabled) {
    ensure();
    db.prepare('UPDATE watchers SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    return get(id);
}

function inflate(row) {
    return {
        ...row,
        args: safeParse(row.args),
        enabled: Boolean(row.enabled)
    };
}

function safeParse(text) {
    try { return JSON.parse(text || '{}'); } catch { return {}; }
}

function digestOf(text) {
    return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

function watchedText(result) {
    return (result.passages || [])
        .map(passage => String(passage.text || '').trim())
        .filter(Boolean)
        .join('\n')
        .slice(0, MAX_KEPT_CHARS);
}

function lines(text) {
    return String(text || '').split('\n').map(line => line.trim()).filter(Boolean);
}

function describeChange(before, after) {
    const old = new Set(lines(before));
    const added = lines(after).filter(line => !old.has(line));
    if (added.length) {
        return { title: 'changed', body: added.join('\n').slice(0, MAX_NOTICE_CHARS) };
    }
    const fresh = new Set(lines(after));
    const removed = lines(before).filter(line => !fresh.has(line));
    return {
        title: 'changed',
        body: removed.length
            ? `No longer there:\n${removed.join('\n')}`.slice(0, MAX_NOTICE_CHARS)
            : 'The page changed, but no single line tells the story.'
    };
}

// Catch-up-on-wake is a property of this predicate, not of any OS hook: a
// watcher is due when its interval has elapsed, however that time passed —
// ticking at a desk or asleep in a bag. The first tick after wake runs
// everything the sleep deferred.
function due(now = Date.now()) {
    return list().filter(watcher => watcher.enabled
        && (!watcher.last_run_at
            || now - watcher.last_run_at >= watcher.interval_minutes * 60000));
}

function setRunner(fn) {
    runner = fn;
}

async function runOne(watcher, now = Date.now()) {
    ensure();

    const procedure = procedureStore.get(watcher.target);
    const objection = unwatchable(procedure);
    if (objection) {
        db.prepare('UPDATE watchers SET last_run_at = ?, last_status = ?, last_error = ? WHERE id = ?')
            .run(now, 'refused', objection, watcher.id);
        return { status: 'refused', reason: objection };
    }

    const replay = runner || require('./procedureRunner').replay;

    let result;
    try {
        result = await replay(watcher.target, watcher.args, { trace: false });
    } catch (err) {
        db.prepare('UPDATE watchers SET last_run_at = ?, last_status = ?, last_error = ? WHERE id = ?')
            .run(now, 'failed', String(err.message || err).slice(0, 500), watcher.id);
        return { status: 'failed', reason: err.message };
    }

    if (result.status !== 'success') {
        db.prepare('UPDATE watchers SET last_run_at = ?, last_status = ?, last_error = ? WHERE id = ?')
            .run(now, result.status || 'failed', String(result.reason || '').slice(0, 500), watcher.id);
        return { status: result.status || 'failed', reason: result.reason };
    }

    const text = watchedText(result);
    const digest = digestOf(text);
    const first = !watcher.last_digest;
    const changed = !first && digest !== watcher.last_digest;

    db.prepare(`UPDATE watchers SET last_run_at = ?, last_status = 'success',
        last_error = NULL, last_digest = ?, last_text = ? WHERE id = ?`)
        .run(now, digest, text, watcher.id);

    if (changed) {
        const change = describeChange(watcher.last_text, text);
        const title = `${watcher.name} ${change.title}`;
        db.prepare('INSERT INTO notices (watcher_id, at, title, body) VALUES (?, ?, ?, ?)')
            .run(watcher.id, now, title, change.body);
        activityBus.publish('watchers', 'notice', {
            watcherId: watcher.id, name: watcher.name, title, body: change.body
        });
    }

    return { status: 'success', changed, first };
}

// A watcher drives the same browser page interactive work uses, so its
// runs queue behind whatever the user has in flight instead of navigating
// underneath it. One tick at a time: the queued jobs from a slow tick must
// finish before the interval fires a second round for the same watchers.
let ticking = false;

async function tick(now = Date.now()) {
    if (ticking) return [];
    ticking = true;
    try {
        return await runDue(now);
    } finally {
        ticking = false;
    }
}

async function runDue(now) {
    const ran = [];
    for (const watcher of due(now)) {
        const job = intentQueue.submit(() => runOne(watcher, now), { background: true });
        const result = await job.result;
        if (result && (result.status === 'error' || result.status === 'aborted')) {
            console.warn(`[Watchers] "${watcher.name}" failed: ${result.response}`);
            ran.push({ id: watcher.id, status: 'failed', reason: result.response });
        } else {
            ran.push({ id: watcher.id, ...result });
        }
    }
    return ran;
}

function start() {
    ensure();
    if (ticker) return;
    ticker = setInterval(() => {
        tick().catch(err => console.warn(`[Watchers] tick failed: ${err.message}`));
    }, TICK_MS);
    if (ticker.unref) ticker.unref();
}

function notices({ unseenOnly = true, limit = 50 } = {}) {
    ensure();
    return db.prepare(`SELECT * FROM notices ${unseenOnly ? 'WHERE seen = 0' : ''}
        ORDER BY at DESC LIMIT ?`).all(limit);
}

function markSeen(ids) {
    ensure();
    const mark = db.prepare('UPDATE notices SET seen = 1 WHERE id = ?');
    let marked = 0;
    for (const id of ids || []) marked += mark.run(id).changes;
    return marked;
}

module.exports = {
    open, close, add, get, list, remove, setEnabled,
    due, tick, runOne, start, notices, markSeen,
    setRunner, unwatchable, describeChange, watchedText, digestOf,
    DEFAULT_PATH
};
