#!/usr/bin/env node
// Builds the two extra router sets against the same frozen catalogue as the
// locked set: the final confirmation set (locked with its own digest, opened
// once) and the post-hoc supplement (reported separately). Every prompt must
// be new relative to items.jsonl and every named skill must exist. Refuses to
// rebuild the final set without --force.
//
//   node tools/router-extra-set.js [--force]

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const STUDY = path.join(ROOT, 'docs', 'measurements', 'router-study');
const FROZEN = path.join(STUDY, 'skills-frozen');

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

function main() {
    const force = process.argv.includes('--force');
    const finalPath = path.join(STUDY, 'items-final.jsonl');
    const finalLocked = fs.existsSync(finalPath) && !force;

    process.env.JARVIS_SKILLS_DIR = FROZEN;
    const registry = require('../services/skillRegistry');
    const names = new Set(registry.list().map(s => s.name));
    const existing = new Set(fs.readFileSync(path.join(STUDY, 'items.jsonl'), 'utf8').trim().split('\n')
        .map(l => JSON.parse(l).prompt.toLowerCase()));

    const sets = {
        final: require('./router-final-items').ITEMS,
        supplement: require('./router-supplement-items').ITEMS,
        safety: require('./router-safety-items').ITEMS
    };
    const problems = [];
    const seen = new Set();
    for (const [name, items] of Object.entries(sets)) {
        for (const item of items) {
            const p = item.prompt.toLowerCase();
            if (existing.has(p)) problems.push(`${item.id}: prompt already in the locked set`);
            if (seen.has(p)) problems.push(`${item.id}: duplicate within the extra sets`);
            seen.add(p);
            if (item.expected === 'execute_existing' && !names.has(item.skill)) problems.push(`${item.id}: unknown skill ${item.skill}`);
            if (item.expected !== 'execute_existing' && item.skill) problems.push(`${item.id}: skill on a non-execute item`);
            item.split = 'test';
        }
    }
    if (problems.length) throw new Error('item problems:\n  ' + problems.join('\n  '));

    const locks = {};
    for (const [name, items] of Object.entries(sets)) {
        if (name === 'final' && finalLocked) { locks[name] = JSON.parse(fs.readFileSync(path.join(STUDY, 'extra-sets.json'), 'utf8')).final.lock; continue; }
        fs.writeFileSync(path.join(STUDY, `items-${name}.jsonl`), items.map(i => JSON.stringify(i)).join('\n') + '\n');
        locks[name] = sha(items.map(i => `${i.id}\t${i.prompt}\t${i.expected}\t${i.skill || ''}`).join('\n'));
    }
    const catalogue = JSON.parse(fs.readFileSync(path.join(STUDY, 'catalogue.json'), 'utf8'));
    fs.writeFileSync(path.join(STUDY, 'extra-sets.json'), JSON.stringify({
        built_at: new Date().toISOString(), catalogue_hash: catalogue.hash,
        final: { items: sets.final.length, lock: locks.final },
        supplement: { items: sets.supplement.length, lock: locks.supplement },
        safety: { items: sets.safety.length, lock: locks.safety }
    }, null, 2) + '\n');

    for (const [name, items] of Object.entries(sets)) {
        const counts = {};
        for (const i of items) counts[i.stratum] = (counts[i.stratum] || 0) + 1;
        console.log(`${name}: ${items.length} items  ${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' ')}`);
        console.log(`  lock ${locks[name]}`);
    }
}

main();
