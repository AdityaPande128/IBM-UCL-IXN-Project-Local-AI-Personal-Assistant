const http = require('http');
const configReader = require('../utils/configReader');

const config = configReader.readConfig();
const retrievalConfig = config.retrieval || {};

const ENABLED = retrievalConfig.enabled !== false;
const TOP_K = retrievalConfig.top_k ?? 8;
const TIMEOUT_MS = retrievalConfig.timeout_ms ?? 10000;

const cache = new Map();


function embed(texts) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({ texts });

        const req = http.request({
            hostname: '127.0.0.1',
            port: config.ports.inference,
            path: '/embed',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
            timeout: TIMEOUT_MS
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

function skillText(skill) {
    const params = Object.keys(skill.parameters || {}).join(' ');
    return `${skill.name.replace(/-/g, ' ')}. ${skill.description} ${params}`.trim();
}

function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom === 0 ? 0 : dot / denom;
}

async function ensureEmbedded(skills) {
    const missing = [...new Set(skills.map(skillText))].filter(text => !cache.has(text));
    if (missing.length === 0) return;

    const vectors = await embed(missing);
    if (vectors.length !== missing.length) {
        throw new Error(`expected ${missing.length} embeddings, got ${vectors.length}`);
    }
    missing.forEach((text, i) => cache.set(text, vectors[i]));
}

async function rank(request, items, k = TOP_K, floor = 0) {
    if (!ENABLED) return { selected: items, scores: [], retrieved: false, reason: 'disabled' };
    if (!items.length) return { selected: [], scores: [], retrieved: true };

    await ensureEmbedded(items);
    const [queryVector] = await embed([request]);

    const scores = items
        .map(item => ({ item, score: cosine(queryVector, cache.get(skillText(item))) }))
        .sort((a, b) => b.score - a.score);

    const selected = scores.filter(r => r.score >= floor).slice(0, k).map(r => r.item);
    return { selected, scores, retrieved: true };
}

async function selectRelevant(request, skills) {
    if (!ENABLED) return { skills, retrieved: false, reason: 'disabled' };

    const builtins = skills.filter(s => (s.provenance || {}).author !== 'generated');
    const generated = skills.filter(s => (s.provenance || {}).author === 'generated');

    if (generated.length <= TOP_K) {
        return { skills, retrieved: false, reason: 'generated library within top_k' };
    }

    try {
        const { selected, scores } = await rank(request, generated, TOP_K);
        console.log(
            `[SkillRetriever] ${builtins.length} builtin + ${selected.length}/${generated.length} generated: ` +
            scores.slice(0, 3).map(r => `${r.item.name}(${r.score.toFixed(2)})`).join(', ')
        );

        return { skills: [...builtins, ...selected], retrieved: true, scores };
    } catch (err) {
        console.warn(`[SkillRetriever] Unavailable (${err.message}); using full catalogue.`);
        return { skills, retrieved: false, reason: err.message };
    }
}

function clearCache() {
    cache.clear();
}

module.exports = { rank, selectRelevant, clearCache, skillText, cosine, TOP_K, ENABLED };
