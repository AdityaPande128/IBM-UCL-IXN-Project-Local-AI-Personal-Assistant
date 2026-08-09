const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_PATH = path.join(__dirname, '..', 'data', 'traces.db');

const SCHEMA_VERSION = 2;

const MAX_SUMMARY_CHARS = 400;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS plans (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT    NOT NULL,
    request     TEXT    NOT NULL,   -- what the user asked
    goal        TEXT,               -- the planner's restatement of it
    status      TEXT    NOT NULL,   -- planned | running | success | failed | rejected
    step_count  INTEGER NOT NULL DEFAULT 0,
    plan_ms     INTEGER,            -- time spent planning
    run_ms      INTEGER,            -- time spent executing
    error       TEXT,
    detail      TEXT,               -- JSON: validation errors, gaps, model used
    parent_plan_id INTEGER REFERENCES plans (id),
    parent_step    TEXT,            -- the outer step this ran inside
    surface        TEXT             -- where it ran, e.g. a hostname
);

CREATE INDEX IF NOT EXISTS plans_ts     ON plans (ts);
CREATE INDEX IF NOT EXISTS plans_status ON plans (status);
-- The parent and surface indexes are created by migrate(), not here: on a
-- database written before those columns existed, CREATE TABLE IF NOT EXISTS
-- leaves the old table alone and indexing a column it has not got yet fails
-- the whole open. They go after the ALTERs, where the column is guaranteed.

CREATE TABLE IF NOT EXISTS steps (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id     INTEGER NOT NULL REFERENCES plans (id),
    ordinal     INTEGER NOT NULL,   -- position in the plan, 0-based
    step_key    TEXT    NOT NULL,   -- the planner's own id for it, e.g. "s2"
    capability  TEXT    NOT NULL,
    tier        INTEGER,            -- interface tier it ran at, for Phase 8
    status      TEXT    NOT NULL,   -- success | failed | skipped | blocked
    label       TEXT,               -- serialised label of what it produced
    inputs      TEXT,               -- JSON, summarised
    summary     TEXT,               -- one readable line about the outcome
    error       TEXT,
    duration_ms INTEGER,
    UNIQUE (plan_id, ordinal)
);

CREATE INDEX IF NOT EXISTS steps_capability ON steps (capability);
CREATE INDEX IF NOT EXISTS steps_status     ON steps (status);
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
    migrate(db);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

    return db;
}

function migrate(database) {
    const columns = new Set(
        database.prepare('PRAGMA table_info(plans)').all().map(row => row.name)
    );

    const additions = [
        ['parent_plan_id', 'INTEGER REFERENCES plans (id)'],
        ['parent_step', 'TEXT'],
        ['surface', 'TEXT']
    ];

    for (const [name, type] of additions) {
        if (columns.has(name)) continue;
        database.exec(`ALTER TABLE plans ADD COLUMN ${name} ${type}`);
    }

    database.exec('CREATE INDEX IF NOT EXISTS plans_parent  ON plans (parent_plan_id)');
    database.exec('CREATE INDEX IF NOT EXISTS plans_surface ON plans (surface)');
}

function handle() {
    return db || open();
}

function close() {
    if (db) {
        db.close();
        db = null;
        dbPath = null;
    }
}


function summarise(value) {
    if (value === null || value === undefined) return null;

    if (typeof value === 'string') {
        return value.length > MAX_SUMMARY_CHARS
            ? `${value.slice(0, MAX_SUMMARY_CHARS)}…`
            : value;
    }
    if (Array.isArray(value)) {
        return `${value.length} item(s)`;
    }
    if (typeof value === 'object') {
        const parts = Object.entries(value).map(([key, inner]) => {
            if (Array.isArray(inner)) return `${key}: ${inner.length} item(s)`;
            if (inner && typeof inner === 'object') return `${key}: {…}`;
            return `${key}: ${summarise(String(inner))}`;
        });
        const joined = parts.join(', ');
        return joined.length > MAX_SUMMARY_CHARS
            ? `${joined.slice(0, MAX_SUMMARY_CHARS)}…`
            : joined;
    }
    return String(value);
}

function encode(value) {
    if (value === null || value === undefined) return null;
    try { return JSON.stringify(value); } catch { return null; }
}

function decode(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
}


function beginPlan({
    request, goal = null, status = 'planned', stepCount = 0, planMs = null, detail = null,
    parentPlanId = null, parentStep = null, surface = null
}) {
    const result = handle().prepare(`
        INSERT INTO plans
            (ts, request, goal, status, step_count, plan_ms, detail,
             parent_plan_id, parent_step, surface)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        now(), String(request), goal, status, stepCount, planMs, encode(detail),
        parentPlanId, parentStep, surface
    );

    return Number(result.lastInsertRowid);
}

function recordStep(planId, {
    ordinal, key, capability, tier = null, status,
    label = null, inputs = null, value = undefined, summary = null,
    error = null, durationMs = null
}) {
    const result = handle().prepare(`
        INSERT INTO steps
            (plan_id, ordinal, step_key, capability, tier, status, label, inputs, summary, error, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        planId, ordinal, String(key), String(capability), tier, status,
        label ? encode(label) : null,
        encode(inputs === null ? null : summariseInputs(inputs)),
        summary !== null ? summary : summarise(value),
        error, durationMs
    );

    return Number(result.lastInsertRowid);
}

function summariseInputs(inputs) {
    const out = {};
    for (const [name, value] of Object.entries(inputs || {})) {
        out[name] = summarise(value);
    }
    return out;
}

function finishPlan(planId, { status, runMs = null, error = null, detail = undefined }) {
    if (detail === undefined) {
        handle().prepare('UPDATE plans SET status = ?, run_ms = ?, error = ? WHERE id = ?')
            .run(status, runMs, error, planId);
    } else {
        handle().prepare('UPDATE plans SET status = ?, run_ms = ?, error = ?, detail = ? WHERE id = ?')
            .run(status, runMs, error, encode(detail), planId);
    }
}


function reconcileInterrupted() {
    const result = handle().prepare(
        "UPDATE plans SET status = 'failed', error = 'interrupted: the daemon stopped mid-run' " +
        "WHERE status = 'running'"
    ).run();
    return Number(result.changes);
}


function getPlan(planId) {
    const plan = handle().prepare('SELECT * FROM plans WHERE id = ?').get(planId);
    if (!plan) return null;

    const steps = handle()
        .prepare('SELECT * FROM steps WHERE plan_id = ? ORDER BY ordinal')
        .all(planId)
        .map(step => ({ ...step, inputs: decode(step.inputs), label: decode(step.label) }));

    return { ...plan, detail: decode(plan.detail), steps };
}

function recentPlans(limit = 20) {
    return handle()
        .prepare('SELECT * FROM plans ORDER BY id DESC LIMIT ?')
        .all(limit)
        .map(plan => ({ ...plan, detail: decode(plan.detail) }));
}

function capabilityStats() {
    return handle().prepare(`
        SELECT capability,
               COUNT(*)                                              AS runs,
               SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END)   AS successes,
               CAST(AVG(duration_ms) AS INTEGER)                     AS mean_ms
        FROM steps
        GROUP BY capability
        ORDER BY runs DESC
    `).all().map(row => ({
        ...row,
        success_rate: row.runs ? row.successes / row.runs : 0
    }));
}

function gaps(limit = 50) {
    return handle()
        .prepare(`SELECT id, ts, request, error, detail FROM plans
                  WHERE status = 'rejected' ORDER BY id DESC LIMIT ?`)
        .all(limit)
        .map(plan => ({ ...plan, detail: decode(plan.detail) }));
}

function procedures({ surface = null, limit = 50 } = {}) {
    const rows = surface
        ? handle().prepare(`
            SELECT * FROM plans
            WHERE surface = ? AND status = 'success'
            ORDER BY id DESC LIMIT ?`).all(surface, limit)
        : handle().prepare(`
            SELECT * FROM plans
            WHERE surface IS NOT NULL AND status = 'success'
            ORDER BY id DESC LIMIT ?`).all(limit);

    return rows.map(plan => {
        const steps = handle()
            .prepare(`SELECT ordinal, capability, tier, status, summary, inputs, duration_ms
                      FROM steps WHERE plan_id = ? ORDER BY ordinal`)
            .all(plan.id)
            .map(step => ({ ...step, inputs: decode(step.inputs) }));

        return {
            id: plan.id,
            surface: plan.surface,
            goal: plan.goal,
            request: plan.request,
            parent_plan_id: plan.parent_plan_id,
            run_ms: plan.run_ms,
            detail: decode(plan.detail),
            signature: steps.map(step => step.capability).join(' > '),
            steps
        };
    });
}

function childPlans(planId) {
    return handle()
        .prepare('SELECT * FROM plans WHERE parent_plan_id = ? ORDER BY id')
        .all(planId)
        .map(plan => ({ ...plan, detail: decode(plan.detail) }));
}

function stats() {
    const plans = handle().prepare(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN status = 'success'  THEN 1 ELSE 0 END) AS succeeded,
               SUM(CASE WHEN status = 'failed'   THEN 1 ELSE 0 END) AS failed,
               SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected
        FROM plans
    `).get();

    const steps = handle().prepare('SELECT COUNT(*) AS total FROM steps').get();

    return {
        plans: Number(plans.total || 0),
        succeeded: Number(plans.succeeded || 0),
        failed: Number(plans.failed || 0),
        rejected: Number(plans.rejected || 0),
        steps: Number(steps.total || 0)
    };
}

module.exports = {
    open, close, handle,
    beginPlan, recordStep, finishPlan, reconcileInterrupted,
    getPlan, recentPlans, capabilityStats, gaps, stats,
    procedures, childPlans,
    summarise,
    DEFAULT_PATH, MAX_SUMMARY_CHARS
};
