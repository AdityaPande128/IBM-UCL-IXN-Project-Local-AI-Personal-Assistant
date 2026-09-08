const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// Every store is redirected into scratch before any service loads.
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-trust-')));
const skillsDir = path.join(scratch, 'skills');
fs.mkdirSync(skillsDir, { recursive: true });
process.env.JARVIS_SKILLS_DIR = skillsDir;

const traceStore = require('../services/traceStore');
const securityStore = require('../security/store');
const watchers = require('../services/watchers');
const generationLog = require('../services/generationLog');
const checkpoints = require('../services/checkpoints');

traceStore.open(path.join(scratch, 'traces.db'));
securityStore.open(path.join(scratch, 'security.db'));
watchers.open(path.join(scratch, 'watchers.db'));
checkpoints.open(path.join(scratch, 'checkpoints'));

const skillPins = require('../services/skillPins');
skillPins.open(path.join(scratch, 'skill-pins.json'));
const skillRegistry = require('../services/skillRegistry');

const permissionsView = require('../services/permissionsView');
const channelAdapter = require('../services/channelAdapter');
const stateBundle = require('../services/stateBundle');

test('the permissions dashboard reads every grant from the store that enforces it', () => {
    securityStore.grantSite('mail.google.com', { label: 'Gmail' });
    securityStore.grantRoot(path.join(scratch, 'granted-folder'), 'files');

    const config = {
        security: { enforce_capabilities: 'generated' },
        web: { desktop_browser: 'Google Chrome', blocked_hosts: ['paypal.com'] },
        mail: { provider: 'gmail', accounts: { work: 'outlook-work' } },
        channel: { telegram: { enabled: true } }
    };
    // The binding lives in the adapter's own store, not in config — the
    // dashboard must read the file that actually gates incoming messages.
    const bindingPath = path.join(scratch, 'telegram-chat.json');
    fs.writeFileSync(bindingPath, JSON.stringify({ chat_id: 12345 }));
    channelAdapter.useBinding(bindingPath);
    const snapshot = permissionsView.snapshot(config);
    channelAdapter.useBinding(null);

    assert.ok(snapshot.web.sites.some(s => s.host === 'mail.google.com'));
    assert.deepStrictEqual(snapshot.web.blocked_hosts, ['paypal.com']);
    assert.ok((snapshot.roots.files || []).length >= 1);
    assert.strictEqual(snapshot.mail.default, 'gmail');
    assert.strictEqual(snapshot.mail.accounts[0].provider, 'outlook-work');
    assert.strictEqual(snapshot.channel.telegram.enabled, true);
    assert.strictEqual(snapshot.channel.telegram.bound_chat, '12345');
    assert.strictEqual(typeof snapshot.channel.telegram.token_present, 'boolean');
    assert.strictEqual(snapshot.enforce_mode, 'generated');
});

test('the pin column tells unpinned from drifted, and only drift refuses', () => {
    const dir = path.join(skillsDir, 'tiny-skill');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---
name: "tiny-skill"
version: "1.0.0"
description: "Prints a word."
exec:
  type: "script"
  argv: ["python3","{{__dir__}}/run.py"]
capabilities:
  exec: true
provenance:
  author: "generated"
---
`);
    fs.writeFileSync(path.join(dir, 'run.py'), 'print("hi")\n');
    skillRegistry.reload();

    const config = { security: { enforce_capabilities: 'generated' } };
    const find = () =>
        permissionsView.snapshot(config).skills.find(s => s.name === 'tiny-skill');

    // Never run, never pinned: it pins on first run, it is not refused.
    assert.strictEqual(find().pin, 'unpinned');

    skillPins.pin('tiny-skill', dir, '1.0.0');
    assert.strictEqual(find().pin, 'pinned');

    fs.appendFileSync(path.join(dir, 'run.py'), '# changed\n');
    assert.strictEqual(find().pin, 'drifted');
});

function seedDataDir(name) {
    const dir = path.join(scratch, name);
    fs.mkdirSync(path.join(dir, 'index'), { recursive: true });
    const db = new DatabaseSync(path.join(dir, 'store.db'));
    db.exec('CREATE TABLE t (v TEXT); INSERT INTO t VALUES (\'alpha\');');
    db.close();
    const nested = new DatabaseSync(path.join(dir, 'index', 'index.db'));
    nested.exec('CREATE TABLE n (v TEXT); INSERT INTO n VALUES (\'beta\');');
    nested.close();
    fs.writeFileSync(path.join(dir, 'skill-pins.json'), '{"a":1}\n');
    fs.writeFileSync(path.join(dir, 'telegram-token'), 'SECRET');
    fs.mkdirSync(path.join(dir, 'browser-profile'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'browser-profile', 'cookies'), 'SECRET');
    return dir;
}

test('a checkpoint snapshots every store consistently and never a secret', () => {
    const dataDir = seedDataDir('data-a');
    const created = checkpoints.create('first', { dataDir });

    assert.ok(created.name.endsWith('-first'));
    const manifest = JSON.parse(fs.readFileSync(
        path.join(scratch, 'checkpoints', created.name, 'manifest.json'), 'utf8'));
    const names = Object.keys(manifest.files);
    assert.ok(names.includes(path.join('data', 'store.db')));
    assert.ok(names.includes(path.join('data', 'index', 'index.db')));
    assert.ok(names.includes(path.join('data', 'skill-pins.json')));
    assert.ok(!names.some(n => n.includes('telegram-token')), 'the token never travels');
    assert.ok(!names.some(n => n.includes('browser-profile')), 'the browser profile never travels');

    // The snapshotted database is a working database.
    const copy = new DatabaseSync(
        path.join(scratch, 'checkpoints', created.name, 'data', 'store.db'),
        { readOnly: true });
    assert.strictEqual(copy.prepare('SELECT v FROM t').get().v, 'alpha');
    copy.close();

    assert.strictEqual(checkpoints.verify(created.name).ok, true);
});

test('pruning keeps the newest and a tampered checkpoint refuses to verify', () => {
    const dataDir = path.join(scratch, 'data-a');
    const second = checkpoints.create('second', { dataDir });
    const removed = checkpoints.prune(1);
    assert.ok(removed.length >= 1, 'older checkpoints were pruned');
    assert.ok(checkpoints.list().some(c => c.name === second.name), 'the newest survives');

    fs.appendFileSync(
        path.join(scratch, 'checkpoints', second.name, 'data', 'skill-pins.json'), 'x');
    const checked = checkpoints.verify(second.name);
    assert.strictEqual(checked.ok, false);
    assert.ok(checked.reason.includes('altered'));
});

test('a restore is staged, applied on boot, and always leaves an undo', () => {
    const dataDir = seedDataDir('data-b');
    const good = checkpoints.create('good', { dataDir });

    // The store then drifts.
    const db = new DatabaseSync(path.join(dataDir, 'store.db'));
    db.exec('UPDATE t SET v = \'drifted\'');
    db.close();

    const staged = checkpoints.restore(good.name);
    assert.strictEqual(staged.status, 'staged');
    assert.strictEqual(staged.restarting, true);

    const configCopy = path.join(scratch, 'config-restore.json');
    const applied = checkpoints.applyPending({
        dataDir, skillsDir: path.join(scratch, 'skills-restore'),
        configPath: configCopy, log: () => { }
    });
    assert.strictEqual(applied.status, 'restored');
    assert.ok(applied.undo.endsWith('-pre-restore'), 'the displaced state was checkpointed first');

    const restored = new DatabaseSync(path.join(dataDir, 'store.db'), { readOnly: true });
    assert.strictEqual(restored.prepare('SELECT v FROM t').get().v, 'alpha');
    restored.close();

    // The undo checkpoint holds the drifted value.
    const undo = new DatabaseSync(
        path.join(scratch, 'checkpoints', applied.undo, 'data', 'store.db'),
        { readOnly: true });
    assert.strictEqual(undo.prepare('SELECT v FROM t').get().v, 'drifted');
    undo.close();

    // With nothing staged, boot does nothing.
    assert.strictEqual(checkpoints.applyPending({ dataDir, log: () => { } }).status, 'none');

    // A name that is not a checkpoint refuses to stage.
    assert.strictEqual(checkpoints.restore('../outside').status, 'refused');
    assert.strictEqual(checkpoints.restore('never-existed').status, 'refused');
});

test('a state bundle round-trips, refuses tampering, and rejects unsafe members', () => {
    const dataDir = seedDataDir('data-c');
    const bundles = path.join(scratch, 'bundles');

    const exported = stateBundle.exportBundle({ destDir: bundles, dataDir });
    assert.strictEqual(exported.status, 'exported');
    assert.ok(fs.existsSync(exported.path));

    const staged = stateBundle.importBundle(exported.path,
        { checkpointRoot: path.join(scratch, 'checkpoints') });
    assert.strictEqual(staged.status, 'staged', staged.reason);
    // Clear what the import staged so later boots in this suite stay clean.
    fs.rmSync(path.join(scratch, 'checkpoints', 'pending-restore.json'), { force: true });

    // Tampering with the archive's contents is caught by the manifest.
    const tamperDir = fs.mkdtempSync(path.join(scratch, 'tamper-'));
    require('child_process').execFileSync('/usr/bin/tar',
        ['-xzf', exported.path, '-C', tamperDir]);
    fs.appendFileSync(path.join(tamperDir, 'data', 'skill-pins.json'), 'x');
    const tampered = path.join(bundles, 'tampered.tar.gz');
    require('child_process').execFileSync('/usr/bin/tar',
        ['-czf', tampered, '-C', tamperDir, '.']);
    const refused = stateBundle.importBundle(tampered,
        { checkpointRoot: path.join(scratch, 'checkpoints') });
    assert.strictEqual(refused.status, 'refused');
    assert.ok(refused.reason.includes('hash'), refused.reason);

    // Member-name safety is judged before extraction.
    assert.strictEqual(stateBundle.unsafeMember('../evil'), true);
    assert.strictEqual(stateBundle.unsafeMember('/etc/passwd'), true);
    assert.strictEqual(stateBundle.unsafeMember('data/nested/../../evil'), true);
    assert.strictEqual(stateBundle.unsafeMember('./data/store.db'), false);
    assert.strictEqual(stateBundle.unsafeMember('data/store.db'), false);

    assert.strictEqual(
        stateBundle.importBundle(path.join(bundles, 'never.tar.gz')).status, 'refused');
});

test('a manifest path that steps outside invalidates the whole checkpoint', () => {
    // The payload sits inside the checkpoint, but its manifest rel walks out —
    // verify() must refuse it before restore can ever write beyond its roots.
    const dir = path.join(scratch, 'checkpoints', 'escape');
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'payload'), 'owned');
    const hash = require('crypto').createHash('sha256')
        .update(fs.readFileSync(path.join(dir, 'payload'))).digest('hex');
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        format: 'jarvis-checkpoint/1', name: 'escape',
        createdAt: new Date().toISOString(),
        files: { 'data/../payload': hash }
    }) + '\n');

    const checked = checkpoints.verify('escape');
    assert.strictEqual(checked.ok, false);
    assert.ok(checked.reason.includes('unsafe'), checked.reason);
    assert.strictEqual(checkpoints.restore('escape').status, 'refused');

    // The same rule holds for a bundle's manifest keys.
    const bundles = path.join(scratch, 'bundles');
    const build = fs.mkdtempSync(path.join(scratch, 'evil-bundle-'));
    fs.mkdirSync(path.join(build, 'data'));
    fs.writeFileSync(path.join(build, 'payload'), 'owned');
    fs.writeFileSync(path.join(build, 'bundle-manifest.json'), JSON.stringify({
        format: stateBundle.FORMAT, createdAt: new Date().toISOString(),
        files: { 'data/../payload': hash }
    }) + '\n');
    const evil = path.join(bundles, 'evil.tar.gz');
    require('child_process').execFileSync('/usr/bin/tar', ['-czf', evil, '-C', build, '.']);
    const refused = stateBundle.importBundle(evil,
        { checkpointRoot: path.join(scratch, 'checkpoints') });
    assert.strictEqual(refused.status, 'refused');
    assert.ok(refused.reason.includes('unsafe'), refused.reason);
});

test('a restore that displaces skills saves them into the undo first', () => {
    const dataDir = seedDataDir('data-d');
    const liveSkills = path.join(scratch, 'skills-live');
    fs.mkdirSync(path.join(liveSkills, 'greeter'), { recursive: true });
    fs.writeFileSync(path.join(liveSkills, 'greeter', 'run.py'), 'print("mine")\n');

    // A checkpoint that carries a different version of the same skill —
    // the shape a bundle import lands as.
    const name = 'with-skills';
    const dir = path.join(scratch, 'checkpoints', name);
    fs.mkdirSync(path.join(dir, 'skills', 'greeter'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills', 'greeter', 'run.py'), 'print("theirs")\n');
    const hash = require('crypto').createHash('sha256')
        .update(fs.readFileSync(path.join(dir, 'skills', 'greeter', 'run.py'))).digest('hex');
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        format: 'jarvis-checkpoint/1', name, createdAt: new Date().toISOString(),
        files: { 'skills/greeter/run.py': hash }
    }) + '\n');

    assert.strictEqual(checkpoints.restore(name).status, 'staged');
    const applied = checkpoints.applyPending({
        dataDir, skillsDir: liveSkills,
        configPath: path.join(scratch, 'config-skills.json'), log: () => { }
    });
    assert.strictEqual(applied.status, 'restored');
    assert.strictEqual(
        fs.readFileSync(path.join(liveSkills, 'greeter', 'run.py'), 'utf8'),
        'print("theirs")\n');

    // The displaced skill rode into the undo checkpoint, hashed like the rest.
    const undoDir = path.join(scratch, 'checkpoints', applied.undo);
    assert.strictEqual(
        fs.readFileSync(path.join(undoDir, 'skills', 'greeter', 'run.py'), 'utf8'),
        'print("mine")\n');
    const undoManifest = JSON.parse(
        fs.readFileSync(path.join(undoDir, 'manifest.json'), 'utf8'));
    assert.ok(undoManifest.files['skills/greeter/run.py']);
    assert.strictEqual(checkpoints.verify(applied.undo).ok, true);
});
