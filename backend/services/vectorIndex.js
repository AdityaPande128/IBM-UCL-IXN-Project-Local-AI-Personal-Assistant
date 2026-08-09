const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const embedClient = require('./embedClient');

const DIM = embedClient.DIMENSIONS;
const BYTES_PER_VECTOR = DIM * 4;
const DB_FILE = 'index.db';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vectors (
    collection TEXT    NOT NULL,
    position   INTEGER NOT NULL,
    vector     BLOB    NOT NULL,
    meta       TEXT    NOT NULL,
    PRIMARY KEY (collection, position)
);
`;

const databases = new Map();

function openDb(dir) {
    if (!databases.has(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        const db = new DatabaseSync(path.join(dir, DB_FILE));
        db.exec('PRAGMA journal_mode = WAL');
        db.exec(SCHEMA);
        databases.set(dir, db);
    }
    return databases.get(dir);
}


function normalise(vector) {
    let sum = 0;
    for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i];

    const norm = Math.sqrt(sum);
    if (norm === 0) return vector;

    for (let i = 0; i < vector.length; i++) vector[i] /= norm;
    return vector;
}

function toBlob(vectors, row) {
    const blob = Buffer.alloc(BYTES_PER_VECTOR);
    for (let d = 0; d < DIM; d++) {
        blob.writeFloatLE(vectors[row * DIM + d], d * 4);
    }
    return blob;
}


class Collection {
    constructor(name, dir) {
        this.name = name;
        this.dir = dir;
        this.vectorPath = path.join(dir, `${name}.vec`);
        this.metaPath = path.join(dir, `${name}.jsonl`);

        this.vectors = null;
        this.meta = [];
        this.loaded = false;
    }

    get size() {
        return this.meta.length;
    }

    load() {
        this.loaded = true;
        this.vectors = new Float32Array(0);
        this.meta = [];

        try {
            this.importLegacy();

            const rows = openDb(this.dir)
                .prepare('SELECT vector, meta FROM vectors WHERE collection = ? ORDER BY position')
                .all(this.name);
            if (!rows.length) return this;

            const vectors = new Float32Array(rows.length * DIM);
            const meta = [];
            for (let row = 0; row < rows.length; row++) {
                const blob = Buffer.from(rows[row].vector);
                if (blob.length !== BYTES_PER_VECTOR) {
                    console.warn(
                        `[VectorIndex] "${this.name}" was built for a different embedding ` +
                        'width — treating as empty; re-index to rebuild.'
                    );
                    return this;
                }
                for (let d = 0; d < DIM; d++) {
                    vectors[row * DIM + d] = blob.readFloatLE(d * 4);
                }
                meta.push(JSON.parse(rows[row].meta));
            }

            this.vectors = vectors;
            this.meta = meta;
        } catch (err) {
            console.warn(`[VectorIndex] "${this.name}" unreadable, treating as empty: ${err.message}`);
        }
        return this;
    }

    importLegacy() {
        if (!fs.existsSync(this.vectorPath) || !fs.existsSync(this.metaPath)) return;

        const db = openDb(this.dir);
        const already = db.prepare('SELECT COUNT(*) AS n FROM vectors WHERE collection = ?')
            .get(this.name).n;
        if (already > 0) return;

        let buffer;
        let records;
        try {
            buffer = fs.readFileSync(this.vectorPath);
            records = fs.readFileSync(this.metaPath, 'utf8')
                .split('\n')
                .filter(line => line.trim())
                .map(line => JSON.parse(line));
        } catch (err) {
            console.warn(`[VectorIndex] legacy "${this.name}" unreadable, ignoring it: ${err.message}`);
            return;
        }

        const vectorCount = Math.floor(buffer.length / BYTES_PER_VECTOR);
        if (vectorCount !== records.length) {
            console.warn(
                `[VectorIndex] legacy "${this.name}" is inconsistent ` +
                `(${vectorCount} vectors, ${records.length} records) — not importing it; ` +
                're-index to rebuild.'
            );
            return;
        }

        const vectors = new Float32Array(vectorCount * DIM);
        for (let i = 0; i < vectors.length; i++) {
            vectors[i] = buffer.readFloatLE(i * 4);
        }
        this.persist(vectors, records);

        fs.renameSync(this.vectorPath, `${this.vectorPath}.imported`);
        fs.renameSync(this.metaPath, `${this.metaPath}.imported`);
        console.log(`[VectorIndex] imported legacy "${this.name}" (${vectorCount} vectors) into sqlite`);
    }

    persist(vectors, meta) {
        const db = openDb(this.dir);
        const insert = db.prepare(
            'INSERT INTO vectors (collection, position, vector, meta) VALUES (?, ?, ?, ?)');

        db.exec('BEGIN');
        try {
            db.prepare('DELETE FROM vectors WHERE collection = ?').run(this.name);
            for (let row = 0; row < meta.length; row++) {
                insert.run(this.name, row, toBlob(vectors, row), JSON.stringify(meta[row]));
            }
            db.exec('COMMIT');
        } catch (err) {
            db.exec('ROLLBACK');
            throw err;
        }
    }

    ensureLoaded() {
        if (!this.loaded) this.load();
        return this;
    }

    replace(rows) {
        const vectors = new Float32Array(rows.length * DIM);

        rows.forEach((row, i) => {
            if (row.vector.length !== DIM) {
                throw new Error(
                    `vector ${i} has ${row.vector.length} dimensions, expected ${DIM} — ` +
                    'the embedding model has changed and the index must be rebuilt'
                );
            }
            const normalised = normalise(Float32Array.from(row.vector));
            vectors.set(normalised, i * DIM);
        });

        this.vectors = vectors;
        this.meta = rows.map(row => row.meta);
        this.loaded = true;
        return this;
    }

    save() {
        this.persist(this.vectors, this.meta);
        return this;
    }

    search(queryVector, { topK = 5, minScore = 0, filter } = {}) {
        this.ensureLoaded();
        if (this.size === 0) return [];

        const query = normalise(Float32Array.from(queryVector));
        if (query.length !== DIM) {
            throw new Error(`query has ${query.length} dimensions, expected ${DIM}`);
        }

        const hits = [];

        for (let row = 0; row < this.meta.length; row++) {
            if (filter && !filter(this.meta[row])) continue;

            const base = row * DIM;
            let score = 0;
            for (let d = 0; d < DIM; d++) score += query[d] * this.vectors[base + d];

            if (score >= minScore) hits.push({ score, meta: this.meta[row] });
        }

        hits.sort((a, b) => b.score - a.score);
        return hits.slice(0, topK);
    }

    hashes() {
        this.ensureLoaded();
        return new Set(this.meta.map(m => m.hash).filter(Boolean));
    }

    delete() {
        openDb(this.dir).prepare('DELETE FROM vectors WHERE collection = ?').run(this.name);
        for (const file of [this.vectorPath, this.metaPath]) {
            if (fs.existsSync(file)) fs.unlinkSync(file);
        }
        this.vectors = new Float32Array(0);
        this.meta = [];
        this.loaded = true;
        return this;
    }
}


const DEFAULT_DIR = path.join(__dirname, '..', 'data', 'index');

const collections = new Map();

function collection(name, dir = DEFAULT_DIR) {
    const key = `${dir}::${name}`;
    if (!collections.has(key)) {
        collections.set(key, new Collection(name, dir).load());
    }
    return collections.get(key);
}

function reset() {
    collections.clear();
    for (const db of databases.values()) {
        try { db.close(); } catch { }
    }
    databases.clear();
}

module.exports = { collection, reset, normalise, Collection, DIM, DEFAULT_DIR };
