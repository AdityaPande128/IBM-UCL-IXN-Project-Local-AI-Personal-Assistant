const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const skillPins = require('../services/skillPins');
const skillExecutor = require('../services/skillExecutor');

function freshStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-pins-'));
    skillPins.open(path.join(dir, 'skill-pins.json'));
    return dir;
}

function fakeSkillDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-skill-'));
    fs.writeFileSync(path.join(dir, 'SKILL.md'), 'manifest');
    fs.mkdirSync(path.join(dir, 'lib'));
    fs.writeFileSync(path.join(dir, 'lib', 'run.py'), 'print("ok")');
    return dir;
}

test('the directory hash is stable and sensitive to every file', () => {
    freshStore();
    const dir = fakeSkillDir();

    const first = skillPins.hashDirectory(dir);
    assert.strictEqual(skillPins.hashDirectory(dir), first);

    fs.writeFileSync(path.join(dir, 'lib', 'run.py'), 'print("changed")');
    assert.notStrictEqual(skillPins.hashDirectory(dir), first);

    fs.rmSync(dir, { recursive: true, force: true });
});

test('a pinned skill verifies until its content drifts', () => {
    freshStore();
    const dir = fakeSkillDir();

    skillPins.pin('probe', dir, '1.0.0');
    assert.deepStrictEqual(skillPins.verify('probe', dir), { ok: true });

    fs.appendFileSync(path.join(dir, 'SKILL.md'), '\ntampered');
    assert.deepStrictEqual(skillPins.verify('probe', dir), { ok: false, reason: 'drifted' });

    assert.deepStrictEqual(skillPins.verify('never-pinned', dir), { ok: false, reason: 'unpinned' });
    fs.rmSync(dir, { recursive: true, force: true });
});

test('ensurePinned trusts on first sight and holds afterwards', () => {
    freshStore();
    const dir = fakeSkillDir();

    assert.deepStrictEqual(skillPins.ensurePinned('legacy', dir, '1.0.0'),
        { ok: true, reason: 'first_seen' });
    assert.deepStrictEqual(skillPins.ensurePinned('legacy', dir, '1.0.0'), { ok: true });

    fs.appendFileSync(path.join(dir, 'lib', 'run.py'), '\n# extra');
    assert.deepStrictEqual(skillPins.ensurePinned('legacy', dir, '1.0.0'),
        { ok: false, reason: 'drifted' });

    fs.rmSync(dir, { recursive: true, force: true });
});

test('the executor refuses a generated skill whose content drifted', async () => {
    freshStore();
    const dir = fakeSkillDir();
    const skill = {
        name: 'drifted-skill',
        version: '1.0.0',
        directory: dir,
        parameters: {},
        exec: { type: 'script', argv: ['python3', 'lib/run.py'], timeout_ms: 5000 },
        reply: 'Done.',
        capabilities: { exec: true, filesystem: [], network: false },
        provenance: { author: 'generated' }
    };

    skillPins.pin(skill.name, dir, skill.version);
    fs.writeFileSync(path.join(dir, 'lib', 'run.py'), 'import os; os.system("true")');

    const result = await skillExecutor.execute(skill, {});
    assert.strictEqual(result.status, 'refused');
    assert.match(result.response, /changed on disk/);

    fs.rmSync(dir, { recursive: true, force: true });
});

test('a builtin skill is not subject to pinning', async () => {
    freshStore();
    const dir = fakeSkillDir();
    const skill = {
        name: 'builtin-probe',
        version: '1.0.0',
        directory: dir,
        parameters: {},
        exec: { type: 'command', argv: ['/usr/bin/true'], timeout_ms: 5000 },
        reply: 'Done.',
        capabilities: { exec: true, filesystem: [], network: false },
        provenance: { author: 'builtin' }
    };

    const result = await skillExecutor.execute(skill, {});
    assert.notStrictEqual(result.status, 'refused');

    fs.rmSync(dir, { recursive: true, force: true });
});
