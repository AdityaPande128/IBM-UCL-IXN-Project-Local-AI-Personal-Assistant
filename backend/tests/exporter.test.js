const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The registry binds its directory at require time, so the scratch world has
// to exist before any service loads.
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-exporter-')));
const sourceSkills = path.join(scratch, 'skills');
const otherSkills = path.join(scratch, 'other-skills');
const packsDir = path.join(scratch, 'packs');
const workspace = path.join(scratch, 'workspace');
const keyPath = path.join(scratch, 'signing.json');
fs.mkdirSync(sourceSkills, { recursive: true });
fs.mkdirSync(otherSkills, { recursive: true });
process.env.JARVIS_SKILLS_DIR = sourceSkills;

const skillPins = require('../services/skillPins');
skillPins.open(path.join(scratch, 'skill-pins.json'));
const skillExporter = require('../services/skillExporter');
const skillRegistry = require('../services/skillRegistry');

function writeSkill(name, { script, tests, description = 'Counts words in a file.' }) {
    const dir = path.join(sourceSkills, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---
name: "${name}"
version: "1.0.0"
description: "${description}"
parameters:
  target:
    type: "string"
    required: true
    description: "The file to read."
exec:
  type: "script"
  argv: ["python3","{{__dir__}}/run.py","--target","{{target}}"]
  timeout_ms: 15000
reply: "Done with {{target}}"
capabilities:
  exec: true
  filesystem: []
  network: false
provenance:
  author: "generated"
---

# ${name}
`);
    fs.writeFileSync(path.join(dir, 'run.py'), script);
    fs.writeFileSync(path.join(dir, 'test.json'), JSON.stringify(tests, null, 2));
    return dir;
}

const COUNTER = `import argparse
p = argparse.ArgumentParser()
p.add_argument('--target', required=True)
a = p.parse_args()
print(len(open(a.target).read().split()))
`;

const COUNTER_TESTS = [{
    name: 'counts three words',
    fixtures: [{ path: 'words.txt', content: 'a b c' }],
    parameters: { target: 'words.txt' },
    expect: { exit_code: 0, stdout_contains: '3' }
}];

writeSkill('word-count', { script: COUNTER, tests: COUNTER_TESTS });

function exportPack(name) {
    return skillExporter.exportPack(name, { destDir: packsDir, keyPath });
}

test('a pack survives the round trip: exported, verified, installed, pinned', async () => {
    const exported = exportPack('word-count');
    assert.strictEqual(exported.status, 'exported');
    assert.match(exported.signer, /^[0-9a-f]{16}$/);
    assert.ok(fs.existsSync(exported.path));

    const result = await skillExporter.importPack(exported.path, { skillsDir: otherSkills });
    assert.strictEqual(result.status, 'installed', result.reason);
    assert.strictEqual(result.name, 'word-count');
    assert.ok(result.tests.includes('passed'), 'the authored tests ran again on import');
    assert.ok(fs.existsSync(path.join(otherSkills, 'word-count', 'run.py')));

    // The pin was taken at install, at exactly the travelled hash.
    const pinned = skillPins.verify('word-count', path.join(otherSkills, 'word-count'));
    assert.strictEqual(pinned.ok, true);

    // Importing the same pack again is idempotent.
    const again = await skillExporter.importPack(exported.path, { skillsDir: otherSkills });
    assert.strictEqual(again.status, 'already_installed');
});

test('an altered file is caught by the hash before anything runs', async () => {
    const exported = exportPack('word-count');
    const pack = JSON.parse(fs.readFileSync(exported.path, 'utf8'));
    pack.files['run.py'].text = 'import os\nprint("changed")\n';
    const tampered = path.join(packsDir, 'tampered.jarvispack.json');
    fs.writeFileSync(tampered, JSON.stringify(pack));

    const result = await skillExporter.importPack(tampered, { skillsDir: path.join(scratch, 'x1') });
    assert.strictEqual(result.status, 'refused');
    assert.ok(result.reason.includes('altered'), result.reason);
});

test('a recomputed hash is caught by the signature', async () => {
    const exported = exportPack('word-count');
    const pack = JSON.parse(fs.readFileSync(exported.path, 'utf8'));
    pack.files['run.py'].text = 'print("changed")\n';

    // The attacker rebuilds the hash over their altered files…
    const rehash = fs.mkdtempSync(path.join(scratch, 'rehash-'));
    for (const [rel, entry] of Object.entries(pack.files)) {
        fs.writeFileSync(path.join(rehash, rel), entry.text);
    }
    pack.hash = skillPins.hashDirectory(rehash);

    const forged = path.join(packsDir, 'forged.jarvispack.json');
    fs.writeFileSync(forged, JSON.stringify(pack));

    // …but cannot re-sign it without the private key.
    const result = await skillExporter.importPack(forged, { skillsDir: path.join(scratch, 'x2') });
    assert.strictEqual(result.status, 'refused');
    assert.ok(result.reason.includes('signature'), result.reason);
});

test('a pack that tries to write outside its directory is refused', async () => {
    const exported = exportPack('word-count');
    const pack = JSON.parse(fs.readFileSync(exported.path, 'utf8'));
    pack.files['../evil.py'] = { text: 'print(1)' };
    const traversal = path.join(packsDir, 'traversal.jarvispack.json');
    fs.writeFileSync(traversal, JSON.stringify(pack));

    const result = await skillExporter.importPack(traversal, { skillsDir: path.join(scratch, 'x3') });
    assert.strictEqual(result.status, 'refused');
    assert.ok(result.reason.includes('unsafe path'), result.reason);
});

test('a skill that fails its own tests here does not install', async () => {
    writeSkill('wrong-count', {
        script: 'print("nothing useful")\n',
        tests: COUNTER_TESTS,
        description: 'Claims to count words but does not.'
    });
    skillRegistry.reload();
    const exported = exportPack('wrong-count');
    assert.strictEqual(exported.status, 'exported', 'export does not re-verify; import does');

    const target = path.join(scratch, 'x4');
    const result = await skillExporter.importPack(exported.path, { skillsDir: target });
    assert.strictEqual(result.status, 'refused');
    assert.ok(result.reason.includes('failed its own tests'), result.reason);
    assert.ok(!fs.existsSync(path.join(target, 'wrong-count')), 'nothing was installed');
});

test('a name already taken by a different skill is not overwritten', async () => {
    const exported = exportPack('word-count');
    const taken = path.join(scratch, 'x5');
    fs.mkdirSync(path.join(taken, 'word-count'), { recursive: true });
    fs.writeFileSync(path.join(taken, 'word-count', 'SKILL.md'), 'something else entirely');

    const result = await skillExporter.importPack(exported.path, { skillsDir: taken });
    assert.strictEqual(result.status, 'refused');
    assert.ok(result.reason.includes('already installed'), result.reason);
    assert.strictEqual(fs.readFileSync(path.join(taken, 'word-count', 'SKILL.md'), 'utf8'),
        'something else entirely', 'the resident skill was untouched');
});

test('the wrapper sends OpenClaw through the shim, never the script', () => {
    const result = skillExporter.exportWrapper('word-count', { workspaceDir: workspace });
    assert.strictEqual(result.status, 'exported');

    const manifest = fs.readFileSync(path.join(workspace, 'word-count', 'SKILL.md'), 'utf8');
    assert.ok(manifest.includes('skill-shim.js'), 'the shim is the entry point');
    assert.ok(manifest.includes('--target'), 'parameters are documented as flags');
    assert.ok(manifest.includes('never any script directly'),
        'the wrapper forbids bypassing the shim');
    assert.ok(!manifest.includes('{{'), 'no unexpanded template tokens leak into the wrapper');
});

test('the builder meta-skill installs with the absolute pipeline path stamped in', () => {
    const { execFileSync } = require('child_process');
    const target = path.join(scratch, 'builder-workspace');
    execFileSync('node', [path.resolve(__dirname, '..', 'tools', 'install-builder.js'), target]);

    const manifest = fs.readFileSync(
        path.join(target, 'jarvis-skill-builder', 'SKILL.md'), 'utf8');
    assert.ok(manifest.includes(path.resolve(__dirname, '..', 'tools', 'skill-build.js')),
        'the builder command carries this checkout\'s absolute path');
    assert.ok(!manifest.includes('%BUILDER%'), 'the template token was stamped');
    assert.ok(manifest.includes('do not write the script yourself'),
        'the meta-skill routes building through the pipeline, not around it');
});

test('the signing key is created once, kept private, and reused', () => {
    const first = skillExporter.signingKeys(keyPath);
    const second = skillExporter.signingKeys(keyPath);
    assert.strictEqual(first.publicKey, second.publicKey, 'the key is stable across exports');
    const mode = fs.statSync(keyPath).mode & 0o777;
    assert.strictEqual(mode, 0o600, 'the private key is not group- or world-readable');
});
