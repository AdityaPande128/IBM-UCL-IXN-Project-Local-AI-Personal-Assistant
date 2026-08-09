const skillRegistry = require('../services/skillRegistry');

const MODES = ['pinned', 'live'];

function isGenerated(skill) {
    return (skill.provenance || {}).author === 'generated';
}

function catalogue(mode = 'pinned') {
    if (!MODES.includes(mode)) {
        throw new Error(`unknown catalogue mode "${mode}" (expected ${MODES.join(' or ')})`);
    }
    if (mode === 'live') return null;
    return skillRegistry.list().filter(skill => !isGenerated(skill));
}

function resolved(mode) {
    return catalogue(mode) || skillRegistry.list();
}

function modeFromArgv(argv = process.argv) {
    return argv.includes('--live') ? 'live' : 'pinned';
}

function isStaleLabel(expected, decision) {
    if (expected !== 'generate_new_skill') return false;
    if (decision.intent_type !== 'execute_existing') return false;

    const chosen = decision.target_skill && skillRegistry.get(decision.target_skill);
    return Boolean(chosen && isGenerated(chosen));
}

function resolveExpectation(testCase, skills) {
    const fallback = { expect: testCase.expect, skill: testCase.skill ?? null, derived: false };

    if (testCase.expect !== 'generate_new_skill') return fallback;
    if (!Array.isArray(testCase.satisfied_by) || testCase.satisfied_by.length === 0) return fallback;

    const installed = new Set(skills.map(s => s.name));
    const covering = testCase.satisfied_by.find(name => installed.has(name));

    return covering
        ? { expect: 'execute_existing', skill: covering, derived: true }
        : fallback;
}

function isUnverifiableCoverage(expected, expectedSkill) {
    return expected === 'execute_existing' && !expectedSkill;
}

function describe(mode) {
    const skills = resolved(mode);
    const generated = skills.filter(isGenerated).length;
    const builtin = skills.length - generated;
    return mode === 'pinned'
        ? `catalogue: pinned — ${builtin} built-in skill(s), generated library excluded, retrieval inactive`
        : `catalogue: live — ${builtin} built-in + ${generated} generated skill(s), via production retrieval`;
}

module.exports = {
    catalogue, resolved, modeFromArgv, resolveExpectation,
    isStaleLabel, isUnverifiableCoverage, describe, isGenerated, MODES
};
