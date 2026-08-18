// Chats as durable rows, not scrollback. Every message the user sees in the
// chat view — typed or spoken, answered or failed — lands in the active
// conversation, so the sidebar can list, reopen and delete whole exchanges.
// Incognito suspends recording entirely: reading old chats is fine, growing
// them is not.

const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const memoryService = require('./memoryService');

const DEFAULT_PATH = path.join(__dirname, '..', 'data', 'conversations.db');
const ROLES = new Set(['user', 'assistant', 'system', 'error']);
const TITLE_LIMIT = 64;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT    NOT NULL,
    created_at TEXT    NOT NULL,
    updated_at TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations (id),
    ts              TEXT    NOT NULL,
    role            TEXT    NOT NULL,
    text            TEXT    NOT NULL,
    artifacts       TEXT
);
CREATE INDEX IF NOT EXISTS messages_conversation ON messages (conversation_id);
CREATE INDEX IF NOT EXISTS conversations_updated ON conversations (updated_at);
`;

let db = null;

function open(target = DEFAULT_PATH) {
    if (db) db.close();
    db = new DatabaseSync(target);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA busy_timeout = 2000;');
    db.exec(SCHEMA);
    return target;
}

function ready() {
    if (!db) open();
    return db;
}

function titleFrom(text) {
    const line = String(text || '').replace(/\s+/g, ' ').trim();
    if (!line) return 'New chat';
    return line.length > TITLE_LIMIT ? `${line.slice(0, TITLE_LIMIT - 1)}…` : line;
}

// The socket carries which conversation it is talking in; the first recorded
// message creates the row. Returns what the caller needs to tell the client
// when a conversation just came into being.
function append(ws, role, text, artifacts) {
    if (!ROLES.has(role) || !String(text || '').trim()) return null;
    if (memoryService.isIncognito()) return null;

    // A conversation that fails to record must never break the exchange
    // it was recording.
    try {
        return write(ws, role, text, artifacts);
    } catch (err) {
        console.warn(`[Conversations] not recorded: ${err.message}`);
        return null;
    }
}

function write(ws, role, text, artifacts) {
    const store = ready();
    const now = new Date().toISOString();
    let created = null;

    if (!ws.conversationId) {
        const seed = role === 'user' ? text : 'New chat';
        const row = store.prepare(
            'INSERT INTO conversations (title, created_at, updated_at) VALUES (?, ?, ?)')
            .run(titleFrom(seed), now, now);
        ws.conversationId = Number(row.lastInsertRowid);
        created = { id: ws.conversationId, title: titleFrom(seed) };
    }

    store.prepare(
        'INSERT INTO messages (conversation_id, ts, role, text, artifacts) VALUES (?, ?, ?, ?, ?)')
        .run(ws.conversationId, now, role, String(text),
             artifacts ? JSON.stringify(artifacts) : null);
    store.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
        .run(now, ws.conversationId);

    return created;
}

function list() {
    return ready().prepare(`
        SELECT c.id, c.title, c.updated_at,
               (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS messages
        FROM conversations c ORDER BY c.updated_at DESC`).all();
}

function messages(conversationId) {
    const rows = ready().prepare(
        'SELECT ts, role, text, artifacts FROM messages WHERE conversation_id = ? ORDER BY id')
        .all(Number(conversationId));
    return rows.map(row => ({
        ts: row.ts, role: row.role, text: row.text,
        artifacts: row.artifacts ? JSON.parse(row.artifacts) : undefined
    }));
}

function exists(conversationId) {
    return Boolean(ready().prepare('SELECT id FROM conversations WHERE id = ?')
        .get(Number(conversationId)));
}

function remove(conversationId) {
    const store = ready();
    store.prepare('DELETE FROM messages WHERE conversation_id = ?').run(Number(conversationId));
    const gone = store.prepare('DELETE FROM conversations WHERE id = ?').run(Number(conversationId));
    return gone.changes > 0;
}

module.exports = { open, append, list, messages, exists, remove, titleFrom, DEFAULT_PATH };
