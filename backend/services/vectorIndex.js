const fs = require('fs');
const path = require('path');

const embedClient = require('./embedClient');

const DIM = embedClient.DIMENSIONS;
const BYTES_PER_VECTOR = DIM * 4;


function normalise(vector) {
    let sum = 0;
    for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i];

    const norm = Math.sqrt(sum);
    if (norm === 0) return vector;

    for (let i = 0; i < vector.length; i++) vector[i] /= norm;
    return vector;
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

        if (!fs.existsSync(this.vectorPath) || !fs.existsSync(this.metaPath)) return this;

        let buffer;
        let records;
        try {
            buffer = fs.readFileSync(this.vectorPath);
            records = fs.readFileSync(this.metaPath, 'utf8')
                .split('\n')
                .filter(line => line.trim())
                .map(line => JSON.parse(line));
        } catch (err) {
            console.warn(`[VectorIndex] "${this.name}" unreadable, treating as empty: ${err.message}`);
            return this;
        }

        const vectorCount = Math.floor(buffer.length / BYTES_PER_VECTOR);
        if (vectorCount !== records.length) {
            console.warn(
                `[VectorIndex] "${this.name}" is inconsistent ` +
                `(${vectorCount} vectors, ${records.length} records) — treating as empty; re-index to rebuild.`
            );
            return this;
        }

        const vectors = new Float32Array(vectorCount * DIM);
        for (let i = 0; i < vectors.length; i++) {
            vectors[i] = buffer.readFloatLE(i * 4);
        }

        this.vectors = vectors;
        this.meta = records;
        return this;
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
        fs.mkdirSync(this.dir, { recursive: true });

        const buffer = Buffer.alloc(this.vectors.length * 4);
        for (let i = 0; i < this.vectors.length; i++) {
            buffer.writeFloatLE(this.vectors[i], i * 4);
        }

        const vectorTmp = `${this.vectorPath}.tmp`;
        const metaTmp = `${this.metaPath}.tmp`;

        fs.writeFileSync(vectorTmp, buffer);
        fs.writeFileSync(metaTmp, this.meta.map(m => JSON.stringify(m)).join('\n') + (this.meta.length ? '\n' : ''));

        fs.renameSync(vectorTmp, this.vectorPath);
        fs.renameSync(metaTmp, this.metaPath);

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
}

module.exports = { collection, reset, normalise, Collection, DIM, DEFAULT_DIR };
