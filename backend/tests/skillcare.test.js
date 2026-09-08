const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const skillCare = require('../services/skillCare');
const profile = require('../services/profile');

function makeSkill(argv, { author = 'builtin' } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-care-'));
    return {
        name: 'care-fixture',
        version: '1.0.0',
        description: 'a fixture that fails on purpose',
        reply: 'ran',
        directory: dir,
        parameters: {},
        capabilities: { exec: true, filesystem: [], network: false },
        provenance: { author },
        exec: { type: 'command', argv, timeout_ms: 5000 }
    };
}

test('a crashing skill answers in plain words, never a traceback', async () => {
    const skill = makeSkill(['python3', '-c',
        'raise ValueError("boom at line 7")']);

    const result = await skillCare.run(skill, {});

    assert.strictEqual(result.status, 'error');
    assert.match(result.response, /Sorry — I couldn't do that/);
    assert.ok(!/Traceback|ValueError/.test(result.response),
        'the trace belongs in the log, not the reply');
    assert.match(String(result.stderr), /ValueError/,
        'the diagnostic must survive on the result for the ledger');
});

test('a permissions wall becomes a card naming the blocked folder', async () => {
    const skill = makeSkill(['python3', '-c',
        `import sys; print("PermissionError: [Errno 13] Permission denied: '/Users/nobody/reports/file.txt'", file=sys.stderr); sys.exit(1)`]);

    const result = await skillCare.run(skill, {});

    assert.strictEqual(result.status, 'needs_approval');
    assert.ok(result.proposal && result.proposal.id, 'an approval card is offered');
    assert.match(result.response, /permissions wall/);
    assert.match(result.response, /\/Users\/nobody\/reports/);
    assert.ok(!/Errno|Traceback/.test(result.response));
});

test('a permissions wall at a credential folder gets no card at all', async () => {
    for (const blocked of [`${os.homedir()}/.ssh/id_rsa`, '/Users/nobody/secrets/vault.txt']) {
        const skill = makeSkill(['python3', '-c',
            `import sys; print("PermissionError: [Errno 13] Permission denied: '${blocked}'", file=sys.stderr); sys.exit(1)`]);

        const result = await skillCare.run(skill, {});

        assert.strictEqual(result.status, 'error', blocked);
        assert.strictEqual(result.proposal, undefined, `no access card for ${blocked}`);
        assert.ok(!/Errno|Traceback/.test(result.response));
    }
});

test('a broken generated skill with improvement off still fails politely', async (t) => {
    const real = profile.improvementEnabled;
    profile.improvementEnabled = () => false;
    t.after(() => { profile.improvementEnabled = real; });

    const skill = makeSkill(['python3', '-c', 'raise RuntimeError("bad code")'],
        { author: 'generated' });

    const result = await skillCare.run(skill, {});

    assert.strictEqual(result.status, 'error');
    assert.match(result.response, /Sorry — I couldn't do that/);
    assert.ok(!/RuntimeError/.test(result.response));
});
