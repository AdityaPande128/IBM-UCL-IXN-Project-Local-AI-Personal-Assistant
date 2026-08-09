const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sandbox = require('../services/skillSandbox');
const skillRegistry = require('../services/skillRegistry');

const HOME = os.homedir();
const sandboxAvailable = fs.existsSync('/usr/bin/sandbox-exec');

function makeSkill(overrides = {}) {
    return {
        name: 'probe-skill',
        version: '1.0.0',
        directory: path.join(os.tmpdir(), 'probe-skill-dir'),
        capabilities: { exec: true, filesystem: [], network: false },
        provenance: { author: 'generated' },
        ...overrides
    };
}

function runUnderProfile(skill, source, parameters = {}) {
    const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbtest-')));
    try {
        fs.mkdirSync(skill.directory, { recursive: true });
        const profile = sandbox.buildProfile(skill, scratch, parameters);
        const profilePath = path.join(scratch, 'p.sb');
        fs.writeFileSync(profilePath, profile);

        const scriptPath = path.join(scratch, 'probe.py');
        fs.writeFileSync(scriptPath, source);

        try {
            const stdout = execFileSync('sandbox-exec', ['-f', profilePath, 'python3', scriptPath],
                { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
            return { ok: true, stdout: stdout.trim(), stderr: '' };
        } catch (err) {
            return { ok: false, stdout: (err.stdout || '').trim(), stderr: (err.stderr || '').toString() };
        }
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}


test('shouldEnforce: generated skills are confined, built-ins are not', () => {
    const generated = makeSkill({ provenance: { author: 'generated' } });
    const builtin = makeSkill({ provenance: { author: 'builtin' } });

    assert.equal(sandbox.shouldEnforce(generated, 'generated'), true);
    assert.equal(sandbox.shouldEnforce(builtin, 'generated'), false);
});

test('shouldEnforce: "always" confines built-ins too, "never" disables entirely', () => {
    const builtin = makeSkill({ provenance: { author: 'builtin' } });
    const generated = makeSkill({ provenance: { author: 'generated' } });

    assert.equal(sandbox.shouldEnforce(builtin, 'always'), true);
    assert.equal(sandbox.shouldEnforce(generated, 'never'), false);
});

test('shouldEnforce: a skill with no provenance is treated as untrusted only when explicit', () => {
    const unknown = makeSkill({ provenance: {} });
    assert.equal(sandbox.shouldEnforce(unknown, 'generated'), false);
    assert.equal(sandbox.shouldEnforce(unknown, 'always'), true);
});


test('isUnscoped: home and filesystem roots are not capabilities', { skip: !sandboxAvailable }, () => {
    for (const broad of [HOME, '/', '/Users', '/tmp', '/var', '/private', '/private/tmp', '/']) {
        assert.equal(sandbox.isUnscoped(broad), true, `${broad} should be rejected as unscoped`);
    }
    assert.equal(sandbox.isUnscoped(HOME + '/'), true);
    assert.equal(sandbox.isUnscoped(path.join(HOME, 'Documents')), false);
});

test('buildProfile: an over-broad declaration does not become a write grant', () => {
    const skill = makeSkill({ capabilities: { exec: true, filesystem: ['~'], network: false } });
    const profile = sandbox.buildProfile(skill, '/private/tmp/scratch', {});

    assert.ok(!profile.includes(`(allow file-write* (subpath "${HOME}"))`),
        'declaring ~ must not grant home-wide write access');
    assert.ok(profile.includes('Ignored over-broad declaration'));
});

test('deriveScopesFromParameters: scope follows the actual invocation', () => {
    const scopes = sandbox.deriveScopesFromParameters({
        input_directory: '/tmp/work/notes',
        output_csv: '/tmp/work/out.csv',
        mode: 'fast'
    });
    assert.ok(scopes.some(s => s.endsWith('/tmp/work/notes')));
    assert.ok(scopes.some(s => s.endsWith('/tmp/work/out.csv')));
    assert.ok(!scopes.includes('fast'));
});

test('deriveScopesFromParameters: a bare home parameter is not a scope', () => {
    assert.deepEqual(sandbox.deriveScopesFromParameters({ folder: '~' }), []);
});


test('enforcement: a write inside the invocation scope succeeds', { skip: !sandboxAvailable }, () => {
    const workdir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'allowed-')));
    try {
        const skill = makeSkill();
        const result = runUnderProfile(skill,
            `open(${JSON.stringify(path.join(workdir, 'out.txt'))}, 'w').write('ok')\nprint('wrote')`,
            { target: workdir });
        assert.equal(result.ok, true, `expected write to succeed: ${result.stderr}`);
    } finally {
        fs.rmSync(workdir, { recursive: true, force: true });
    }
});

test('enforcement: a write outside every declared scope is denied', { skip: !sandboxAvailable }, () => {
    const forbidden = path.join(HOME, '.jarvis-sandbox-escape-test');
    const skill = makeSkill();

    const result = runUnderProfile(skill,
        `open(${JSON.stringify(forbidden)}, 'w').write('escaped')\nprint('WROTE')`, {});

    assert.equal(result.ok, false, 'write outside scope must be denied');
    assert.equal(fs.existsSync(forbidden), false, 'the file must not exist');
});

test('enforcement: network access is denied when not declared', { skip: !sandboxAvailable }, () => {
    const result = runUnderProfile(makeSkill(),
        'import socket\nsocket.create_connection(("1.1.1.1", 53), timeout=3)\nprint("CONNECTED")');
    assert.equal(result.ok, false, 'network must be denied');
});

test('enforcement: credential stores cannot be read', { skip: !sandboxAvailable }, () => {
    const sshDir = path.join(HOME, '.ssh');
    if (!fs.existsSync(sshDir)) return;

    const result = runUnderProfile(makeSkill(),
        `import os\nprint(os.listdir(${JSON.stringify(sshDir)}))`);
    assert.equal(result.ok, false, '~/.ssh must not be readable by a generated skill');
});

test('enforcement: a skill cannot rewrite its own manifest or script', { skip: !sandboxAvailable }, () => {
    const skillDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'selfmod-')));
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'original');

    try {
        const skill = makeSkill({ directory: skillDir });
        const result = runUnderProfile(skill,
            `open(${JSON.stringify(path.join(skillDir, 'SKILL.md'))}, 'w').write('rewritten')\nprint('MODIFIED')`,
            { target: skillDir });

        assert.equal(result.ok, false, 'a skill must not modify itself');
        assert.equal(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'), 'original');
    } finally {
        fs.rmSync(skillDir, { recursive: true, force: true });
    }
});

test('enforcement: files outside $HOME remain readable (scope of the guarantee)', { skip: !sandboxAvailable }, () => {
    const doc = path.join(os.tmpdir(), 'jarvis-readable-probe.txt');
    fs.writeFileSync(doc, 'readable');

    try {
        const result = runUnderProfile(makeSkill(),
            `print(open(${JSON.stringify(doc)}).read())`);
        assert.equal(result.ok, true, 'reads outside $HOME are expected to succeed');
    } finally {
        fs.rmSync(doc, { force: true });
    }
});


test('the registered generated skill runs correctly under enforcement', { skip: !sandboxAvailable }, async () => {
    const skill = skillRegistry.get('word-counts-to-csv');
    if (!skill) return;

    const executor = require('../services/skillExecutor');
    const workdir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-')));
    try {
        fs.mkdirSync(path.join(workdir, 'notes'));
        fs.writeFileSync(path.join(workdir, 'notes', 'a.txt'), 'one two three');

        const result = await executor.execute(skill, {
            input_directory: path.join(workdir, 'notes'),
            output_csv: path.join(workdir, 'out.csv')
        });

        assert.equal(result.status, 'success', result.response);
        assert.equal(result.sandboxed, true, 'a generated skill must run confined');
        assert.ok(fs.existsSync(path.join(workdir, 'out.csv')));
    } finally {
        fs.rmSync(workdir, { recursive: true, force: true });
    }
});


test('enforcement: arbitrary home documents are NOT readable', { skip: !sandboxAvailable }, () => {
    const doc = path.join(HOME, '.jarvis-read-probe.txt');
    fs.writeFileSync(doc, 'private user data');

    try {
        const result = runUnderProfile(makeSkill(),
            `print(open(${JSON.stringify(doc)}).read())`);
        assert.equal(result.ok, false, 'a home document must not be readable');
    } finally {
        fs.rmSync(doc, { force: true });
    }
});

test('enforcement: a file inside the invocation scope IS readable', { skip: !sandboxAvailable }, () => {
    const workdir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'readscope-')));
    try {
        fs.writeFileSync(path.join(workdir, 'in.txt'), 'expected');
        const result = runUnderProfile(makeSkill(),
            `print(open(${JSON.stringify(path.join(workdir, 'in.txt'))}).read())`,
            { source: workdir });
        assert.equal(result.ok, true, `scoped read should succeed: ${result.stderr}`);
        assert.match(result.stdout, /expected/);
    } finally {
        fs.rmSync(workdir, { recursive: true, force: true });
    }
});

test('enforcement: the skill can still read its own script', { skip: !sandboxAvailable }, () => {
    const skillDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ownread-')));
    fs.writeFileSync(path.join(skillDir, 'helper.txt'), 'helper data');
    try {
        const result = runUnderProfile(makeSkill({ directory: skillDir }),
            `print(open(${JSON.stringify(path.join(skillDir, 'helper.txt'))}).read())`);
        assert.equal(result.ok, true, `skill dir must stay readable: ${result.stderr}`);
    } finally {
        fs.rmSync(skillDir, { recursive: true, force: true });
    }
});

test('enforcement: naming a credential store as a parameter does not expose it', { skip: !sandboxAvailable }, () => {
    const sshDir = path.join(HOME, '.ssh');
    if (!fs.existsSync(sshDir)) return;

    const result = runUnderProfile(makeSkill(),
        `import os; print(os.listdir(${JSON.stringify(sshDir)}))`,
        { folder: sshDir });

    assert.equal(result.ok, false, 'a parameter must not unlock a credential store');
});

test('the assistant\'s own stores are denied to skills, which still read themselves', { skip: !sandboxAvailable }, () => {
    const skill = makeSkill();
    const ownData = path.join(__dirname, '..', 'data', 'procedures', 'mail-search.json');

    const denied = runUnderProfile(skill, `
open(${JSON.stringify(ownData)}).read()
print("READ OK")
`);
    assert.strictEqual(denied.ok, false, 'reading backend/data must be denied');

    fs.writeFileSync(path.join(skill.directory, 'note.txt'), 'own file');
    const own = runUnderProfile(skill, `
import os
print(open(os.path.join(${JSON.stringify(skill.directory)}, "note.txt")).read())
`);
    assert.strictEqual(own.ok, true, 'a skill must still read its own directory');

    const profile = sandbox.buildProfile(skill, '/private/tmp/scratch', {});
    const dataDir = fs.realpathSync(path.join(__dirname, '..', 'data'));
    assert.ok(profile.includes(`(deny file-read* (subpath "${dataDir}"))`));
    assert.ok(profile.includes(`(deny file-write* (subpath "${dataDir}"))`));
});
