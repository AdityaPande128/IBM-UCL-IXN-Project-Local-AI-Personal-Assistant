const http = require('http');
const configReader = require('../utils/configReader');

const config = configReader.readConfig();
const retrievalConfig = config.retrieval || {};

const TIMEOUT_MS = retrievalConfig.timeout_ms ?? 10000;

const DIMENSIONS = 384;

function embed(texts, opts = {}) {
    const timeout = opts.timeout_ms ?? TIMEOUT_MS;

    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({ texts });

        const req = http.request({
            hostname: '127.0.0.1',
            port: config.ports.inference,
            path: '/embed',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            },
            timeout
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.error) return reject(new Error(json.error));
                    if (!Array.isArray(json.embeddings)) return reject(new Error('no embeddings returned'));
                    resolve(json.embeddings);
                } catch (err) {
                    reject(new Error(`embedding transport error: ${err.message}`));
                }
            });
        });

        req.on('error', err => reject(err));
        req.on('timeout', () => { req.destroy(); reject(new Error('embedding timed out')); });
        req.write(payload);
        req.end();
    });
}

async function embedAll(texts, { batchSize = 32, onProgress } = {}) {
    const out = [];

    for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const vectors = await embed(batch);
        out.push(...vectors);
        if (onProgress) onProgress(Math.min(i + batch.length, texts.length), texts.length);
    }

    return out;
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

module.exports = { embed, embedAll, cosine, DIMENSIONS };
