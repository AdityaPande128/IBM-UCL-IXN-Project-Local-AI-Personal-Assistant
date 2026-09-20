// A throwaway copy of the skills directory for a measurement run, so nothing
// a study registers or pins ever touches the live catalogue. Pure filesystem;
// safe to call before any service module is loaded.

const fs = require('fs');
const os = require('os');
const path = require('path');

const LIVE = path.resolve(__dirname, '..', 'skills');

function isGenerated(dir) {
    // Builtins are a single SKILL.md whose exec is a command; every skill the
    // generator wrote ships its own run.py and test.json beside it.
    try {
        const files = fs.readdirSync(dir);
        if (files.includes('run.py') || files.includes('test.json')) return true;
        return /author:\s*generated/.test(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
    } catch { return false; }
}

function makeScratchSkills({ label = 'study', builtinOnly = false, source = LIVE } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `jarvis-skills-${label}-`));
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const from = path.join(source, entry.name);
        if (entry.isFile()) { fs.copyFileSync(from, path.join(root, entry.name)); continue; }
        if (!entry.isDirectory()) continue;
        if (builtinOnly && isGenerated(from)) continue;
        fs.cpSync(from, path.join(root, entry.name), { recursive: true });
    }
    return root;
}

function listSkillDirs(root) {
    return fs.readdirSync(root, { withFileTypes: true })
        .filter(e => e.isDirectory()).map(e => e.name).sort();
}

module.exports = { makeScratchSkills, listSkillDirs, isGenerated, LIVE };
