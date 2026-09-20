#!/usr/bin/env node
// Builds the router set once: freezes the catalogue, adds the S13 mechanical
// perturbations, splits dev/test by hash within each stratum, and locks the
// test split with a digest that the pre-registration records. Refuses to
// overwrite an existing split unless --force is given, so the lock holds.
//
//   node tools/router-set.js [--force]

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { ITEMS } = require('./router-items');
const { LIVE, isGenerated } = require('./study-scratch');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'docs', 'measurements', 'router-study');
const FROZEN = path.join(OUT, 'skills-frozen');
const SEED = 20260902;
const DEV_FRACTION = 0.3;
const PERTURB_FROM = ['S1', 'S3', 'S5', 'S8', 'S11'];
const PERTURB_EACH = 2;

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Lower-case, drop terminal punctuation, swap two adjacent letters inside one
// word of five letters or more. Deterministic under the seed.
function perturb(prompt, rng) {
    const words = prompt.toLowerCase().replace(/[.?!]+$/, '').split(' ');
    const eligible = words.map((w, i) => (/^[a-z]{5,}$/.test(w) ? i : -1)).filter(i => i >= 0);
    if (eligible.length) {
        const i = eligible[Math.floor(rng() * eligible.length)];
        const w = words[i];
        const p = 1 + Math.floor(rng() * (w.length - 3));
        words[i] = w.slice(0, p) + w[p + 1] + w[p] + w.slice(p + 2);
    }
    return words.join(' ');
}

function hashDir(dir) {
    const hash = crypto.createHash('sha256');
    const walk = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile()) {
                hash.update(path.relative(dir, full)); hash.update('\0');
                hash.update(fs.readFileSync(full)); hash.update('\0');
            }
        }
    };
    walk(dir);
    return hash.digest('hex');
}

function freezeCatalogue(force) {
    const liveHash = hashDir(LIVE);
    if (fs.existsSync(FROZEN)) {
        const frozenHash = hashDir(FROZEN);
        if (frozenHash === liveHash) return { hash: liveHash, action: 'unchanged' };
        if (!force) {
            throw new Error(`frozen catalogue differs from backend/skills (${frozenHash.slice(0, 12)} vs ${liveHash.slice(0, 12)}); pass --force to re-freeze`);
        }
        fs.rmSync(FROZEN, { recursive: true });
    }
    fs.cpSync(LIVE, FROZEN, { recursive: true });
    return { hash: hashDir(FROZEN), action: 'frozen' };
}

function main() {
    const force = process.argv.includes('--force');
    fs.mkdirSync(OUT, { recursive: true });

    const splitPath = path.join(OUT, 'split.json');
    if (fs.existsSync(splitPath) && !force) {
        throw new Error('split.json exists; the test split is locked. Pass --force only to rebuild before any registered run.');
    }

    const catalogue = freezeCatalogue(force);
    process.env.JARVIS_SKILLS_DIR = FROZEN;
    const registry = require('../services/skillRegistry');
    const skills = registry.list().map(s => ({
        name: s.name, description: s.description,
        parameters: s.parameters || {},
        author: (s.provenance || {}).author || 'builtin'
    }));
    const names = new Set(skills.map(s => s.name));

    const problems = [];
    const seen = new Set();
    for (const item of ITEMS) {
        if (seen.has(item.prompt)) problems.push(`${item.id}: duplicate prompt`);
        seen.add(item.prompt);
        if (item.expected === 'execute_existing' && !names.has(item.skill)) problems.push(`${item.id}: unknown skill ${item.skill}`);
        if (item.expected !== 'execute_existing' && item.skill) problems.push(`${item.id}: skill on a non-execute item`);
    }
    if (problems.length) throw new Error('item problems:\n  ' + problems.join('\n  '));

    const rng = mulberry32(SEED);
    const perturbed = [];
    for (const code of PERTURB_FROM) {
        const pool = ITEMS.filter(i => i.stratum === code);
        const chosen = new Set();
        while (chosen.size < PERTURB_EACH) chosen.add(pool[Math.floor(rng() * pool.length)].id);
        for (const id of chosen) {
            const base = ITEMS.find(i => i.id === id);
            const { id: _id, stratum: _s, source: _src, note: _n, ...rest } = base;
            perturbed.push({
                ...rest,
                id: `S13-${String(perturbed.length + 1).padStart(2, '0')}`,
                stratum: 'S13',
                prompt: perturb(base.prompt, rng),
                perturbed_from: base.id
            });
        }
    }
    const all = [...ITEMS, ...perturbed];

    const byStratum = new Map();
    for (const item of all) {
        if (!byStratum.has(item.stratum)) byStratum.set(item.stratum, []);
        byStratum.get(item.stratum).push(item);
    }
    const dev = new Set();
    for (const [code, items] of byStratum) {
        const ordered = [...items].sort((a, b) => sha(a.prompt).localeCompare(sha(b.prompt)));
        const k = Math.round(items.length * DEV_FRACTION);
        ordered.slice(0, k).forEach(i => dev.add(i.id));
    }
    for (const item of all) item.split = dev.has(item.id) ? 'dev' : 'test';

    const testItems = all.filter(i => i.split === 'test').sort((a, b) => a.id.localeCompare(b.id));
    const lock = sha(testItems.map(i => `${i.id}\t${i.prompt}\t${i.expected}\t${i.skill || ''}`).join('\n'));

    fs.writeFileSync(path.join(OUT, 'items.jsonl'), all.map(i => JSON.stringify(i)).join('\n') + '\n');
    fs.writeFileSync(path.join(OUT, 'catalogue.json'), JSON.stringify({
        frozen_at: new Date().toISOString(), hash: catalogue.hash, count: skills.length, skills
    }, null, 2) + '\n');
    fs.writeFileSync(splitPath, JSON.stringify({
        built_at: new Date().toISOString(), seed: SEED, dev_fraction: DEV_FRACTION,
        items: all.length, dev: [...dev].sort(), test: testItems.map(i => i.id),
        catalogue_hash: catalogue.hash, test_lock: lock
    }, null, 2) + '\n');

    const counts = {};
    for (const item of all) {
        counts[item.stratum] ??= { dev: 0, test: 0 };
        counts[item.stratum][item.split] += 1;
    }
    console.log(`catalogue ${catalogue.action}: ${skills.length} skills, sha256 ${catalogue.hash.slice(0, 16)}`);
    console.log(`items: ${all.length} (${dev.size} dev / ${testItems.length} test)`);
    for (const [code, c] of Object.entries(counts)) console.log(`  ${code.padEnd(4)} dev ${String(c.dev).padStart(2)}  test ${String(c.test).padStart(3)}`);
    console.log(`S13 perturbations: ${perturbed.map(p => `${p.perturbed_from}→${p.id}`).join(', ')}`);
    console.log(`test lock: ${lock}`);
    console.log(`written: ${path.relative(ROOT, OUT)}/{items.jsonl,catalogue.json,split.json,skills-frozen/}`);
}

main();
