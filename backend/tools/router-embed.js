#!/usr/bin/env node
// The no-LLM baseline: nearest installed skill by embedding similarity, or
// "build a new skill" when nothing is close enough. It cannot answer or refuse,
// so it is scored two ways: over every item (as a router) and over the action
// items alone (as the selection stage). The threshold is chosen on dev and
// applied to test; both are printed.
//
//   node tools/router-embed.js [--set main|final|supplement]

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const STUDY = path.join(ROOT, 'docs', 'measurements', 'router-study');
process.env.JARVIS_SKILLS_DIR = path.join(STUDY, 'skills-frozen');

const registry = require('../services/skillRegistry');
const embedClient = require('../services/embedClient');
const { skillText, cosine } = require('../services/skillRetriever');

const ACTION_STRATA = new Set(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S12', 'S15']);

function arg(name, fallback = null) {
    const at = process.argv.indexOf(`--${name}`);
    return at >= 0 ? process.argv[at + 1] : fallback;
}

function score(items, theta) {
    let all = 0, action = 0, actionN = 0, skillHit = 0, skillN = 0;
    for (const it of items) {
        const predicted = it.best.score >= theta ? 'execute_existing' : 'generate_new_skill';
        const predictedSkill = predicted === 'execute_existing' ? it.best.name : null;
        const ok = predicted === it.expected && (it.expected !== 'execute_existing' || predictedSkill === it.skill);
        if (ok) all += 1;
        const isAction = ACTION_STRATA.has(it.stratum) || (it.perturbed_from && it.expected !== 'answer' && it.expected !== 'refuse');
        if (isAction) { actionN += 1; if (ok) action += 1; }
        if (it.expected === 'execute_existing') { skillN += 1; if (it.best.name === it.skill) skillHit += 1; }
    }
    return { all: all / items.length, action: action / actionN, actionN, top1_skill: skillHit / skillN, skillN };
}

async function main() {
    const set = arg('set', 'main');
    const file = set === 'main' ? 'items.jsonl' : `items-${set}.jsonl`;
    const items = fs.readFileSync(path.join(STUDY, file), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const skills = registry.list();
    const skillVectors = await embedClient.embedAll(skills.map(skillText));
    const promptVectors = await embedClient.embedAll(items.map(i => i.prompt));
    items.forEach((it, i) => {
        let best = { name: null, score: -1 };
        skills.forEach((s, j) => {
            const c = cosine(promptVectors[i], skillVectors[j]);
            if (c > best.score) best = { name: s.name, score: c };
        });
        it.best = best;
    });

    const dev = items.filter(i => i.split === 'dev');
    const test = items.filter(i => i.split === 'test');
    const tune = dev.length ? dev : test;
    let bestTheta = arg('theta') ? Number(arg('theta')) : 0.5, bestAcc = -1;
    if (!arg('theta')) for (let theta = 0.30; theta <= 0.95; theta += 0.01) {
        const acc = score(tune, theta).action;
        if (acc > bestAcc) { bestAcc = acc; bestTheta = Number(theta.toFixed(2)); }
    }
    const devScore = dev.length ? score(dev, bestTheta) : null;
    const testScore = score(test, bestTheta);
    const pct = x => (x * 100).toFixed(1);
    console.log(`embedding-only router over ${skills.length} skills, set ${set}, theta ${bestTheta} (${arg('theta') ? 'given' : dev.length ? 'chosen on dev' : 'chosen on the set itself'})`);
    if (devScore) console.log(`  dev : all-items ${pct(devScore.all)}  action-items ${pct(devScore.action)} (n=${devScore.actionN})  top-1 skill ${pct(devScore.top1_skill)} (n=${devScore.skillN})`);
    console.log(`  test: all-items ${pct(testScore.all)}  action-items ${pct(testScore.action)} (n=${testScore.actionN})  top-1 skill ${pct(testScore.top1_skill)} (n=${testScore.skillN})`);

    const outDir = path.join(STUDY, 'runs');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, `embed-only__${set}.json`), JSON.stringify({
        at: new Date().toISOString(), set, skills: skills.length, theta: bestTheta, dev: devScore, test: testScore,
        items: items.map(i => ({ id: i.id, expected: i.expected, skill: i.skill || null, best: i.best, split: i.split }))
    }, null, 2) + '\n');
    console.log(`written: runs/embed-only__${set}.json`);
}

main().catch(err => { console.error(err); process.exit(1); });
