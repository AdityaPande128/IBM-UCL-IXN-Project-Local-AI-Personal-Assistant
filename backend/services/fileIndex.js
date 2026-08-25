const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const classifier = require('../security/classifier');
const labels = require('../security/labels');

const DEFAULT_PATH = path.join(__dirname, '..', 'data', 'files.db');

const SKIP_DIRS = new Set([
    'node_modules', '.git', '.svn', '.hg', '.venv', 'venv', '__pycache__',
    'dist', 'build', 'target', '.next', '.nuxt', '.cache', '.gradle', '.m2',
    'Library', 'Applications', '.Trash', '.local', '.cargo', '.rustup',
    'site-packages', 'DerivedData', 'Pods', '.terraform'
]);

const SKIP_EXTENSIONS = new Set([
    '.pyc', '.pyo', '.class', '.o', '.obj', '.so', '.dylib', '.a',
    '.lock', '.log', '.tmp', '.temp', '.swp', '.DS_Store'
]);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
    path            TEXT    PRIMARY KEY,
    name            TEXT    NOT NULL,
    dir             TEXT    NOT NULL,
    ext             TEXT,
    size            INTEGER NOT NULL,
    mtime           INTEGER NOT NULL,   -- epoch ms; integer so ranges are cheap
    sensitivity     TEXT    NOT NULL,
    content_indexed INTEGER NOT NULL DEFAULT 0,
    generation      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS files_name  ON files (name);
CREATE INDEX IF NOT EXISTS files_ext   ON files (ext);
CREATE INDEX IF NOT EXISTS files_mtime ON files (mtime);
CREATE INDEX IF NOT EXISTS files_dir   ON files (dir);

-- Filename search. The default tokeniser splits on punctuation, so
-- "thesis-outline.md" is findable by "thesis" or "outline" without the user
-- having to remember the exact name, which is the whole point of the tier.
CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
    path UNINDEXED, name, dir
);

CREATE TABLE IF NOT EXISTS crawls (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    root       TEXT    NOT NULL,
    generation INTEGER NOT NULL,
    ts         TEXT    NOT NULL,
    files      INTEGER NOT NULL,
    skipped    INTEGER NOT NULL,
    removed    INTEGER NOT NULL,
    ms         INTEGER NOT NULL
);
`;

let db = null;
let dbPath = null;

function open(target = DEFAULT_PATH) {
    if (db && dbPath === target) return db;
    if (db) close();

    fs.mkdirSync(path.dirname(target), { recursive: true });
    db = new DatabaseSync(target);
    dbPath = target;

    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec(SCHEMA);
    return db;
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

function expandHome(target) {
    return target.startsWith('~') ? path.join(os.homedir(), target.slice(1)) : target;
}


function crawl({ roots, maxDepth = 12, onProgress = () => {} } = {}) {
    const database = handle();
    const startedAt = Date.now();

    const generation = Number(database
        .prepare('SELECT COALESCE(MAX(generation), 0) + 1 AS next FROM files')
        .get().next);

    const insert = database.prepare(`
        INSERT INTO files (path, name, dir, ext, size, mtime, sensitivity, generation)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (path) DO UPDATE SET
            size = excluded.size,
            mtime = excluded.mtime,
            sensitivity = excluded.sensitivity,
            generation = excluded.generation
    `);

    let files = 0;
    let skipped = 0;
    let denied = 0;
    const seenRoots = [];

    for (const rawRoot of roots) {
        const root = path.resolve(expandHome(rawRoot));
        if (!fs.existsSync(root)) continue;
        seenRoots.push(root);

        database.exec('BEGIN');
        let sinceCommit = 0;

        const stack = [[root, 0]];
        while (stack.length) {
            const [dir, depth] = stack.pop();
            if (depth > maxDepth) continue;

            let entries;
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                denied++;
                continue;
            }

            for (const entry of entries) {
                const full = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    if (SKIP_DIRS.has(entry.name)) { skipped++; continue; }
                    if (entry.name.startsWith('.')) { skipped++; continue; }
                    if (classifier.secretCheck(path.join(full, 'probe')).secret) {
                        skipped++;
                        continue;
                    }
                    stack.push([full, depth + 1]);
                    continue;
                }

                if (!entry.isFile()) continue;

                const ext = path.extname(entry.name).toLowerCase();
                if (SKIP_EXTENSIONS.has(ext) || entry.name === '.DS_Store') {
                    skipped++;
                    continue;
                }
                if (classifier.secretCheck(full).secret) { skipped++; continue; }

                let stat;
                try {
                    stat = fs.statSync(full);
                } catch {
                    continue;
                }

                insert.run(full, entry.name, dir, ext || null,
                    stat.size, Math.round(stat.mtimeMs),
                    labels.SENSITIVITY.PERSONAL, generation);
                files++;
                sinceCommit++;

                if (sinceCommit >= 2000) {
                    database.exec('COMMIT');
                    database.exec('BEGIN');
                    sinceCommit = 0;
                    onProgress(files);
                }
            }
        }

        database.exec('COMMIT');
    }

    let removed = 0;
    if (seenRoots.length) {
        const clauses = seenRoots.map(() => '(path = ? OR path LIKE ? ESCAPE \'\\\')').join(' OR ');
        const params = [];
        for (const root of seenRoots) {
            params.push(root, `${root.replace(/[\\%_]/g, '\\$&')}${path.sep}%`);
        }
        const result = database
            .prepare(`DELETE FROM files WHERE generation < ? AND (${clauses})`)
            .run(generation, ...params);
        removed = Number(result.changes);
    }

    rebuildSearchIndex();

    const ms = Date.now() - startedAt;
    database.prepare(`
        INSERT INTO crawls (root, generation, ts, files, skipped, removed, ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(seenRoots.join(path.delimiter), generation, new Date().toISOString(),
        files, skipped, removed, ms);

    return { files, skipped, removed, denied, ms };
}

function rebuildSearchIndex() {
    const database = handle();
    database.exec('BEGIN');
    database.exec('DELETE FROM files_fts');
    database.exec(`
        INSERT INTO files_fts (path, name, dir)
        SELECT path, name, dir FROM files
    `);
    database.exec('COMMIT');
}


function toMatchQuery(text) {
    const terms = String(text || '')
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(term => term.length >= 2);
    if (!terms.length) return null;
    return terms.map(term => `"${term}"*`).join(' OR ');
}

function search(query = {}) {
    const database = handle();
    const { text, ext, dir, modifiedAfter, modifiedBefore, limit = 20 } = query;

    const where = [];
    const params = [];
    let from = 'files f';

    const match = text ? toMatchQuery(text) : null;
    if (match) {
        from = 'files_fts JOIN files f ON f.path = files_fts.path';
        where.push('files_fts MATCH ?');
        params.push(match);
    }

    if (ext) {
        const list = Array.isArray(ext) ? ext : [ext];
        const normalised = list.map(e => (e.startsWith('.') ? e : `.${e}`).toLowerCase());
        where.push(`f.ext IN (${normalised.map(() => '?').join(', ')})`);
        params.push(...normalised);
    }
    if (dir) {
        const base = path.resolve(expandHome(dir));
        where.push("(f.dir = ? OR f.dir LIKE ? ESCAPE '\\')");
        params.push(base, `${base.replace(/[\\%_]/g, '\\$&')}${path.sep}%`);
    }
    // Anything under a hidden directory is machinery, not the user's
    // files; it never answers a search however well its name matches.
    where.push("f.path NOT LIKE '%/.%'");
    if (modifiedAfter) { where.push('f.mtime >= ?'); params.push(modifiedAfter); }
    if (modifiedBefore) { where.push('f.mtime <= ?'); params.push(modifiedBefore); }

    const sql = `
        SELECT f.path, f.name, f.dir, f.ext, f.size, f.mtime, f.sensitivity, f.content_indexed
        FROM ${from}
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY ${match ? 'bm25(files_fts), ' : ''}f.mtime DESC
        LIMIT ?
    `;
    params.push(limit);

    const rows = database.prepare(sql).all(...params);
    // A name that carries the query's words beats a body that merely
    // mentions them: "Iron Profile.pdf" must outrank a long report whose
    // text happens to say "report" a hundred times. Stable sort keeps the
    // bm25 order inside each name-hit band.
    if (match) {
        const terms = String(text).toLowerCase()
            .split(/[^\p{L}\p{N}]+/u).filter(t => t.length >= 2);
        const nameHits = row => {
            const name = String(row.name || '').toLowerCase();
            return terms.filter(t => name.includes(t)).length;
        };
        rows.sort((a, b) => nameHits(b) - nameHits(a));
    }
    return rows.map(row => ({
        ...row,
        content_indexed: Boolean(row.content_indexed),
        modified: new Date(row.mtime).toISOString()
    }));
}

function get(target) {
    const row = handle().prepare('SELECT * FROM files WHERE path = ?')
        .get(path.resolve(expandHome(target)));
    return row ? { ...row, content_indexed: Boolean(row.content_indexed) } : null;
}

function markContentIndexed(paths, indexed = true) {
    const database = handle();
    const statement = database.prepare('UPDATE files SET content_indexed = ? WHERE path = ?');
    database.exec('BEGIN');
    let changed = 0;
    for (const target of paths) {
        changed += Number(statement.run(indexed ? 1 : 0, path.resolve(target)).changes);
    }
    database.exec('COMMIT');
    return changed;
}

function stats() {
    const database = handle();
    const totals = database.prepare(`
        SELECT COUNT(*) AS files,
               COALESCE(SUM(size), 0) AS bytes,
               COALESCE(SUM(content_indexed), 0) AS content_indexed
        FROM files
    `).get();

    const byExtension = database.prepare(`
        SELECT ext, COUNT(*) AS n FROM files
        WHERE ext IS NOT NULL
        GROUP BY ext ORDER BY n DESC LIMIT 10
    `).all();

    const lastCrawl = database.prepare(
        'SELECT * FROM crawls ORDER BY id DESC LIMIT 1'
    ).get() || null;

    return { ...totals, byExtension, lastCrawl };
}

module.exports = {
    open,
    close,
    handle,
    crawl,
    search,
    get,
    stats,
    markContentIndexed,
    rebuildSearchIndex,
    toMatchQuery,
    DEFAULT_PATH,
    SKIP_DIRS,
    SKIP_EXTENSIONS
};
