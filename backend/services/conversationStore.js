// Chats as durable rows, not scrollback. Every message the user sees in the
// chat view — typed or spoken, answered or failed — lands in the active
// conversation, so the sidebar can list, reopen and delete whole exchanges.
// Incognito suspends recording entirely: reading old chats is fine, growing
// them is not.

const crypto = require('crypto');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const configReader = require('../utils/configReader');
const incognito = require('./incognito');

// Every surface records through append, so this is the one choke point where
// a second surface can hear the conversation grow. The listener must never
// be able to break the recording it is observing.
let appendListener = null;

function notifyAppend(fn) {
    appendListener = fn;
}

// A file artifact gets a durable id the moment it is recorded; remote
// surfaces download by id, never by path.
function stampArtifacts(artifacts) {
    if (!artifacts || !Array.isArray(artifacts.files)) return artifacts || null;
    return {
        ...artifacts,
        files: artifacts.files.map(entry => entry && !entry.id
            ? { ...entry, id: crypto.randomBytes(6).toString('hex') }
            : entry)
    };
}

const DEFAULT_PATH = process.env.JARVIS_CONVERSATIONS_DB
    || path.join(__dirname, '..', 'data', 'conversations.db');
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
    if (incognito.isIncognito()) return null;

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

    if (ws.conversationId && !exists(ws.conversationId)) ws.conversationId = null;

    if (!ws.conversationId) {
        const seed = role === 'user' ? text : 'New chat';
        const row = store.prepare(
            'INSERT INTO conversations (title, created_at, updated_at) VALUES (?, ?, ?)')
            .run(titleFrom(seed), now, now);
        ws.conversationId = Number(row.lastInsertRowid);
        created = { id: ws.conversationId, title: titleFrom(seed) };
    }

    const stamped = stampArtifacts(artifacts);
    store.prepare(
        'INSERT INTO messages (conversation_id, ts, role, text, artifacts) VALUES (?, ?, ?, ?, ?)')
        .run(ws.conversationId, now, role, String(text),
             stamped ? JSON.stringify(stamped) : null);
    store.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
        .run(now, ws.conversationId);

    if (appendListener) {
        try {
            appendListener({
                ws, id: ws.conversationId, created,
                message: { ts: now, role, text: String(text),
                           artifacts: stamped || undefined }
            });
        } catch (err) {
            console.warn(`[Conversations] sync listener failed: ${err.message}`);
        }
    }

    return created;
}

// Resolve a minted artifact id back to the real file it named.
function artifactPath(id) {
    if (!/^[0-9a-f]{12,16}$/.test(String(id))) return null;
    const rows = ready().prepare('SELECT artifacts FROM messages WHERE artifacts LIKE ?')
        .all(`%${id}%`);
    for (const row of rows) {
        let parsed;
        try { parsed = JSON.parse(row.artifacts); } catch { continue; }
        const hit = (parsed.files || []).find(entry => entry && entry.id === id);
        if (hit && hit.path) return { path: hit.path, name: hit.name || path.basename(hit.path) };
    }
    return null;
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

function clear() {
    const store = ready();
    store.prepare('DELETE FROM messages').run();
    store.prepare('DELETE FROM conversations').run();
}

function remove(conversationId) {
    const store = ready();
    store.prepare('DELETE FROM messages WHERE conversation_id = ?').run(Number(conversationId));
    const gone = store.prepare('DELETE FROM conversations WHERE id = ?').run(Number(conversationId));
    return gone.changes > 0;
}

// Demand paging for old chats. Every conversation already lives on disk in
// this store; only the tail of the current one rides in the model's context.
// When the user asks to recall an earlier discussion, the matching exchanges
// are paged back in as answer passages — nothing is recalled unasked.
const RECALL_SHAPE = new RegExp([
    '\\b(remember|recall|remind me|last time|earlier|yesterday|last week|previous(ly)?',
    '|our (chat|conversation)s?|we (said|spoke|talked|discussed|decided|agreed)',
    '|did (i|we) (say|ask|mention|decide|talk|tell)|what did (i|we)|what was (my|the|his|her|their)',
    '|i (told|mentioned to|said to) you|you (noted|wrote down)|for the record',
    '|talk(ed)? about|discuss(ed)?)\\b'
].join(''), 'i');

const RECALL_STOP = new Set([
    'the', 'and', 'that', 'this', 'with', 'from', 'what', 'when', 'where',
    'which', 'about', 'have', 'does', 'did', 'was', 'were', 'you', 'your',
    'our', 'has', 'how', 'for', 'are', 'can', 'could', 'would', 'tell',
    'said', 'earlier', 'yesterday', 'remember', 'recall', 'chat',
    'conversation', 'talked', 'talk', 'discussed', 'discuss', 'time'
]);

const DISCLAIMS_MEMORY =
    /\b(do(?:es)? not|don't|cannot|can't|no)\b[^.]{0,40}\b(memory|recall|remember|record|access to (?:our |previous |earlier |past )?(?:conversations?|chats?))\b/i;

function recallWords(query) {
    return [...new Set((String(query).toLowerCase().match(/[a-z0-9]{3,}/g) || []))]
        .filter(word => !RECALL_STOP.has(word))
        .slice(0, 8);
}

function searchMessages(query, { limit = 8 } = {}) {
    ready();
    const words = recallWords(query);
    if (!words.length) return [];
    const asked = String(query).trim().toLowerCase();
    const clause = words.map(() => 'm.text LIKE ? COLLATE NOCASE').join(' OR ');
    const rows = db.prepare(
        `SELECT m.conversation_id, m.ts, m.role, m.text, c.title
           FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE m.role IN ('user', 'assistant') AND (${clause})
          ORDER BY m.id DESC LIMIT 200`)
        .all(...words.map(word => `%${word}%`));
    return rows
        // The question being asked has just been recorded; it is not a memory.
        .filter(row => row.text.trim().toLowerCase() !== asked)
        .map(row => ({
            row,
            hits: words.filter(word => row.text.toLowerCase().includes(word)).length
        }))
        .sort((a, b) => b.hits - a.hits)
        .slice(0, limit)
        .map(({ row }) => row);
}

const answerSource = {
    name: 'conversations',
    matches: query => RECALL_SHAPE.test(String(query || '')),
    async retrieve(query) {
        const rows = searchMessages(query);
        if (!rows.length) return [];

        const embedClient = require('./embedClient');
        const securityLabels = require('../security/labels');
        const retrieval = (configReader.readConfig().retrieval || {});
        const minScore = retrieval.corpus_min_score ?? 0.62;
        const margin = retrieval.corpus_margin ?? 0.05;

        const passages = rows.map(row => ({
            text: `${row.role === 'user' ? 'The user' : 'The assistant'} said: ${row.text}`,
            embedText: row.text,
            cite: `past chat "${row.title}" (${String(row.ts).slice(0, 10)})`,
            label: securityLabels.label(securityLabels.ORIGIN.USER,
                securityLabels.SENSITIVITY.PERSONAL)
        }));

        const [queryVector, ...vectors] = await embedClient.embed(
            [query, ...passages.map(p => p.embedText)]);
        const scored = passages.map((passage, i) => ({
            ...passage, score: embedClient.cosine(queryVector, vectors[i])
        }));

        const kept = scored.filter(p => p.score >= minScore
            && !(p.text.startsWith('The assistant said') && DISCLAIMS_MEMORY.test(p.embedText)));
        if (!kept.length) return [];
        kept.sort((a, b) => b.score - a.score);
        const best = kept[0].score;
        const chosen = kept.filter(p => p.score >= best - margin).slice(0, 3);
        const bestUser = kept.find(p => p.text.startsWith('The user said'));
        if (bestUser && !chosen.includes(bestUser)) chosen[chosen.length - 1] = bestUser;
        return chosen.map(({ embedText, ...passage }) => passage);
    }
};

module.exports = { open, append, list, messages, exists, remove, clear, titleFrom, RECALL_SHAPE,
    searchMessages, answerSource, notifyAppend, artifactPath, stampArtifacts,
    DEFAULT_PATH };
