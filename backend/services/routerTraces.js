// Every routing decision the guard makes, and whether the outcome bore it
// out. A decision is recorded when it is made and confirmed only when what it
// chose actually succeeded — a skill that ran, an answer that grounded, a
// plan that finished. Confirmed traces are the training set for tuning the
// guard on its own verified behaviour (efficiency ladder, step 5); refusals
// are recorded but never confirmed automatically, because nothing downstream
// can prove a refusal right.

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_PATH = path.join(__dirname, '..', 'data', 'router-traces.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS decisions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           TEXT    NOT NULL,
    prompt       TEXT    NOT NULL,
    intent_type  TEXT    NOT NULL,  -- execute_existing | generate_new_skill | answer | refuse
    intent_class TEXT    NOT NULL,  -- act | tell | refuse, the triage view
    confidence   REAL,
    reasoning    TEXT,
    target_skill TEXT,
    verified     INTEGER NOT NULL DEFAULT 0,
    outcome      TEXT
);
CREATE INDEX IF NOT EXISTS decisions_verified ON decisions (verified);
`;

let db = null;
let dbPath = null;

function open(target = DEFAULT_PATH) {
    if (db) db.close();
    dbPath = target;
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec(SCHEMA);
    return dbPath;
}

function handle() {
    if (!db) open();
    return db;
}

function classOf(intentType) {
    if (intentType === 'refuse') return 'refuse';
    if (intentType === 'answer') return 'tell';
    return 'act';
}

function record(prompt, decision) {
    if (!decision || !decision.schema_valid) return null;
    const result = handle().prepare(`
        INSERT INTO decisions (ts, prompt, intent_type, intent_class,
                               confidence, reasoning, target_skill)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        new Date().toISOString(),
        String(prompt),
        decision.intent_type,
        classOf(decision.intent_type),
        decision.confidence ?? null,
        decision.reasoning || null,
        decision.target_skill || null
    );
    return Number(result.lastInsertRowid);
}

function confirm(id, outcome) {
    if (!id) return;
    handle().prepare('UPDATE decisions SET verified = 1, outcome = ? WHERE id = ?')
        .run(String(outcome || 'success'), id);
}

function note(id, outcome) {
    if (!id) return;
    handle().prepare('UPDATE decisions SET outcome = ? WHERE id = ? AND verified = 0')
        .run(String(outcome || ''), id);
}

function verifiedDecisions() {
    return handle().prepare(
        'SELECT * FROM decisions WHERE verified = 1 ORDER BY ts').all();
}

function counts() {
    const rows = handle().prepare(`
        SELECT intent_class, verified, COUNT(*) AS n
        FROM decisions GROUP BY intent_class, verified`).all();
    const summary = { recorded: 0, verified: 0 };
    for (const row of rows) {
        summary.recorded += row.n;
        if (row.verified) {
            summary.verified += row.n;
            summary[row.intent_class] = (summary[row.intent_class] || 0) + row.n;
        }
    }
    return summary;
}

// The triage-stage training pair for one verified decision: the guard's
// system prompt, the user's request, and the JSON the guard should have
// produced — which, for a verified trace, is the JSON it did produce. The
// latest decision wins when the same prompt was routed more than once.
function trainingPairs(rows, systemPrompt) {
    const byPrompt = new Map();
    for (const row of rows) byPrompt.set(row.prompt, row);

    const pairs = [];
    for (const row of byPrompt.values()) {
        const target = {
            intent_class: row.intent_class,
            confidence: row.confidence ?? 0.8,
            reasoning: row.reasoning || ''
        };
        pairs.push({
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: row.prompt },
                { role: 'assistant', content: JSON.stringify(target) }
            ]
        });
    }
    return pairs;
}

module.exports = {
    open, record, confirm, note, verifiedDecisions, counts, trainingPairs,
    classOf, DEFAULT_PATH
};
