const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const skillExecutor = require('../services/skillExecutor');

function stubOnPath(name, script) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stub-bin-'));
    const file = path.join(dir, name);
    fs.writeFileSync(file, script, { mode: 0o755 });

    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}:${originalPath}`;

    return () => {
        process.env.PATH = originalPath;
        fs.rmSync(dir, { recursive: true, force: true });
    };
}


test('a command substitution in the user\'s words is not executed', async () => {
    const sentinelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'injection-'));
    const sentinel = path.join(sentinelDir, 'executed');

    const restore = stubOnPath('openclaw', [
        '#!/bin/sh',
        'for arg in "$@"; do echo "ARG:$arg"; done'
    ].join('\n') + '\n');

    delete require.cache[require.resolve('../services/openclawBridge')];
    const bridge = require('../services/openclawBridge');

    try {
        const hostile = `summarise my notes $(touch ${sentinel}) \`touch ${sentinel}\` $HOME`;
        const output = await bridge.callOpenClawAgent(hostile);

        assert.ok(!fs.existsSync(sentinel),
            'a substitution embedded in the user\'s words was executed by a shell');
        assert.ok(output.includes(`ARG:${hostile}`),
            `the message should arrive as one literal argument, got:\n${output}`);
        assert.ok(!output.includes(`ARG:summarise my notes  ${os.homedir()}`),
            '$HOME in the message was expanded by a shell');
    } finally {
        restore();
        fs.rmSync(sentinelDir, { recursive: true, force: true });
        delete require.cache[require.resolve('../services/openclawBridge')];
    }
});

test('the message is passed as a single argument even when it contains spaces and quotes', async () => {
    const restore = stubOnPath('openclaw', [
        '#!/bin/sh',
        'for arg in "$@"; do echo "ARG:$arg"; done'
    ].join('\n') + '\n');

    delete require.cache[require.resolve('../services/openclawBridge')];
    const bridge = require('../services/openclawBridge');

    try {
        const message = 'rename "my file".txt to \'other file\'.md; rm -rf /';
        const output = await bridge.callOpenClawAgent(message);

        const args = output.split('\n').filter(l => l.startsWith('ARG:')).map(l => l.slice(4));
        assert.ok(args.includes(message),
            `expected one argument holding the whole message, got:\n${JSON.stringify(args, null, 2)}`);
        assert.strictEqual(args[args.indexOf('--message') + 1], message);
    } finally {
        restore();
        delete require.cache[require.resolve('../services/openclawBridge')];
    }
});


function makeSkill(argv, timeoutMs = 10000) {
    return {
        name: 'output-probe',
        version: '1.0.0',
        directory: os.tmpdir(),
        parameters: {},
        reply: 'done',
        capabilities: { exec: true, filesystem: [], network: false },
        provenance: { author: 'builtin' },
        exec: { type: 'command', argv, timeout_ms: timeoutMs }
    };
}

test('a skill producing more than 1MB of output still succeeds', async () => {
    const bytes = 3 * 1024 * 1024;
    const skill = makeSkill(['python3', '-c', `print("x" * ${bytes})`]);

    const result = await skillExecutor.execute(skill, {});

    assert.strictEqual(result.status, 'success',
        `expected success, got ${result.status}: ${result.response}`);
    assert.ok(result.stdout.length >= bytes,
        `expected the full ${bytes} bytes, got ${result.stdout.length}`);
});

test('a skill that exceeds its time budget is reported as a timeout', async () => {
    const skill = makeSkill(['python3', '-c', 'import time; time.sleep(30)'], 500);

    const result = await skillExecutor.execute(skill, {});

    assert.strictEqual(result.status, 'error');
    assert.match(result.response, /timed out/,
        `expected a timeout diagnostic, got: ${result.response}`);
});

test('a failing skill reports its own stderr rather than "Command failed"', async () => {
    const skill = makeSkill(['python3', '-c', 'import sys; sys.exit("no such column: amount")']);

    const result = await skillExecutor.execute(skill, {});

    assert.strictEqual(result.status, 'error');
    assert.match(result.response, /no such column: amount/);
});
