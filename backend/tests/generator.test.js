const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const generator = require('../services/skillGenerator');
const verifier = require('../services/skillVerifier');
const skillRegistry = require('../services/skillRegistry');

const validEnvelope = {
    name: 'word-count-csv',
    description: 'Counts words in text files and writes a CSV.',
    parameters: { folder: { type: 'string', required: true, description: 'Directory to scan.' } },
    script: 'print("hi")',
    reply: 'Counted the words.',
    tests: [{ name: 'basic', parameters: { folder: 'docs' }, expect: { exit_code: 0 } }]
};

test('validateEnvelope: accepts a complete envelope', () => {
    const r = generator.validateEnvelope(validEnvelope);
    assert.equal(r.valid, true, r.errors.join('; '));
});

test('validateEnvelope: rejects a non-kebab-case name', () => {
    const r = generator.validateEnvelope({ ...validEnvelope, name: 'Word_Count' });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('kebab-case')));
});

test('validateEnvelope: requires at least one test case', () => {
    assert.equal(generator.validateEnvelope({ ...validEnvelope, tests: [] }).valid, false);
    const { tests, ...without } = validEnvelope;
    assert.equal(generator.validateEnvelope(without).valid, false);
});

test('validateEnvelope: requires a script', () => {
    const { script, ...without } = validEnvelope;
    const r = generator.validateEnvelope(without);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('script')));
});

test('validateEnvelope: rejects malformed parameter names', () => {
    const r = generator.validateEnvelope({
        ...validEnvelope,
        parameters: { 'Folder-Name': { type: 'string' } }
    });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('lower_snake_case')));
});


test('buildManifest: derives argv flags from the declared parameters', () => {
    const m = generator.buildManifest({ ...validEnvelope, __sourcePrompt: 'x' }, ['os']);
    assert.deepEqual(m.exec.argv, ['python3', '{{__dir__}}/run.py', '--folder', '{{folder}}']);
    assert.equal(m.exec.type, 'script');
});

test('buildManifest: records provenance including the originating prompt', () => {
    const m = generator.buildManifest({ ...validEnvelope, __sourcePrompt: 'count my words' }, ['os']);
    assert.equal(m.provenance.author, 'generated');
    assert.equal(m.provenance.source_prompt, 'count my words');
    assert.ok(m.provenance.generated_at);
});

test('buildManifest: generated skills never declare network capability', () => {
    const m = generator.buildManifest({ ...validEnvelope, __sourcePrompt: 'x' }, ['socket']);
    assert.equal(m.capabilities.network, false);
});

test('assembled manifest passes the same validation as a built-in skill', () => {
    const m = generator.buildManifest({ ...validEnvelope, __sourcePrompt: 'x' }, ['os']);
    const r = skillRegistry.validateManifest(m, m.name);
    assert.equal(r.valid, true, r.errors.join('; '));
});


test('extractJson: recovers an envelope from a fenced response', () => {
    assert.deepEqual(generator.extractJson('```json\n{"name":"x"}\n```'), { name: 'x' });
});

test('extractJson: returns null when there is no object', () => {
    assert.equal(generator.extractJson('I cannot do that.'), null);
});


test('staticCheck: blocks network imports', async () => {
    for (const source of ['import socket', 'from urllib import request', 'import requests']) {
        const r = await verifier.staticCheck(source + '\nprint(1)');
        assert.equal(r.valid, false, `expected "${source}" to be blocked`);
    }
});

test('staticCheck: blocks ctypes', async () => {
    const r = await verifier.staticCheck('import ctypes\nprint(1)');
    assert.equal(r.valid, false);
});

test('staticCheck: allows the local-automation standard library', async () => {
    const r = await verifier.staticCheck('import os, sys, json, csv, re, pathlib, shutil, subprocess\nprint(1)');
    assert.equal(r.valid, true, r.errors.join('; '));
});

test('staticCheck: reports a syntax error rather than passing it through', async () => {
    const r = await verifier.staticCheck('def broken(:\n    pass');
    assert.equal(r.valid, false);
    assert.equal(r.syntaxError, true);
});


const counterScript = `
import argparse, os, csv
p = argparse.ArgumentParser()
p.add_argument('--folder', required=True)
a = p.parse_args()
folder = os.path.expanduser(a.folder)
rows = []
for name in sorted(os.listdir(folder)):
    if name.endswith('.txt'):
        with open(os.path.join(folder, name)) as fh:
            rows.append((name, len(fh.read().split())))
with open(os.path.join(folder, 'counts.csv'), 'w', newline='') as fh:
    csv.writer(fh).writerows(rows)
print(f'Counted {len(rows)} file(s)')
`;

const passingCase = {
    name: 'counts two files',
    fixtures: [
        { path: 'docs/a.txt', content: 'one two three' },
        { path: 'docs/b.txt', content: 'four five' }
    ],
    parameters: { folder: 'docs' },
    expect: { exit_code: 0, stdout_contains: 'Counted 2', files_exist: ['docs/counts.csv'] }
};

test('verify: a working skill with honest assertions passes', async () => {
    const r = await verifier.verify(counterScript, [passingCase], ['folder'], 20000);
    assert.equal(r.passed, true, r.summary);
});

test('verify: an assertion that is not actually true fails', async () => {
    const lying = { ...passingCase, expect: { exit_code: 0, stdout_contains: 'Counted 99' } };
    const r = await verifier.verify(counterScript, [lying], ['folder'], 20000);
    assert.equal(r.passed, false);
});

test('verify: a claimed output file that is never created fails', async () => {
    const lying = { ...passingCase, expect: { exit_code: 0, files_exist: ['docs/never-written.json'] } };
    const r = await verifier.verify(counterScript, [lying], ['folder'], 20000);
    assert.equal(r.passed, false);
});

test('verify: a skill with no test cases cannot pass', async () => {
    const r = await verifier.verify(counterScript, [], ['folder'], 20000);
    assert.equal(r.passed, false);
    assert.match(r.summary, /no test cases/);
});

test('verify: fixtures cannot escape the scratch directory', async () => {
    const escaping = {
        name: 'path traversal',
        fixtures: [{ path: '../../escaped.txt', content: 'x' }],
        parameters: { folder: '.' },
        expect: { exit_code: 0 }
    };
    const r = await verifier.verify(counterScript, [escaping], ['folder'], 20000);
    assert.equal(r.passed, false);
    assert.match(r.results[0].reason, /escapes the scratch directory/);
});

const sandboxAvailable = fs.existsSync('/usr/bin/sandbox-exec');

test('verify: the sandbox blocks network access reached at runtime', { skip: !sandboxAvailable }, async () => {
    const evasive = [
        'import importlib',
        'm = importlib.import_module("socket")',
        'm.create_connection(("1.1.1.1", 53), timeout=3)',
        'print("phoned home")'
    ].join('\n');

    const r = await verifier.verify(
        evasive,
        [{ name: 'network', parameters: {}, expect: { exit_code: 0, stdout_contains: 'phoned home' } }],
        [], 15000
    );
    assert.equal(r.passed, false, 'a generated skill must not be able to reach the network');
});

test('validateEnvelope: rejects a test case missing a required parameter', () => {
    const r = generator.validateEnvelope({
        ...validEnvelope,
        parameters: {
            folder: { type: 'string', required: true, description: 'in' },
            output_csv: { type: 'string', required: true, description: 'out' }
        },
        tests: [{ name: 'incomplete', parameters: { folder: 'docs' }, expect: { exit_code: 0 } }]
    });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('output_csv')), r.errors.join('; '));
});

test('validateEnvelope: accepts test cases that omit optional parameters', () => {
    const r = generator.validateEnvelope({
        ...validEnvelope,
        parameters: {
            folder: { type: 'string', required: true, description: 'in' },
            verbose: { type: 'boolean', required: false, description: 'noisy' }
        },
        tests: [{ name: 'ok', parameters: { folder: 'docs' }, expect: { exit_code: 0 } }]
    });
    assert.equal(r.valid, true, r.errors.join('; '));
});


const argparseScript = (flags) =>
    'import argparse\np = argparse.ArgumentParser()\n' +
    flags.map(f => `p.add_argument("${f}", required=True)`).join('\n') +
    '\na = p.parse_args()\nprint("ok")';

test('checkArgparseContract: catches hyphenated flags for underscored parameters', async () => {
    const r = await verifier.checkArgparseContract(
        argparseScript(['--folder', '--output-csv']),
        { folder: { type: 'string' }, output_csv: { type: 'string' } }
    );
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('--output-csv') && e.includes('--output_csv')), r.errors.join('; '));
});

test('checkArgparseContract: accepts flags that match the declared names', async () => {
    const r = await verifier.checkArgparseContract(
        argparseScript(['--folder', '--output_csv']),
        { folder: { type: 'string' }, output_csv: { type: 'string' } }
    );
    assert.equal(r.valid, true, r.errors.join('; '));
});

test('checkArgparseContract: reports a parameter the script never accepts', async () => {
    const r = await verifier.checkArgparseContract(
        argparseScript(['--folder']),
        { folder: { type: 'string' }, missing_one: { type: 'string' } }
    );
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('missing_one')));
});

test('checkArgparseContract: is a no-op for parameterless skills', async () => {
    const r = await verifier.checkArgparseContract('print("hi")', {});
    assert.equal(r.valid, true);
});

test('checkArgparseContract: stays silent when the script does not use argparse', async () => {
    const r = await verifier.checkArgparseContract('import sys\nprint(sys.argv)', { folder: { type: 'string' } });
    assert.equal(r.valid, true);
});


test('validateEnvelope: no longer rejects an existing name outright', () => {
    const r = generator.validateEnvelope({ ...validEnvelope, name: 'app-launch' });
    assert.equal(r.valid, true, r.errors.join('; '));
});

test('the generation prompt does not instruct the model to rename around collisions', () => {
    const prompt = generator.buildPrompt(skillRegistry.list());
    assert.ok(!prompt.includes('choose a different one'),
        'prompt must not push the model to invent a variant name');
    assert.ok(prompt.includes('reuse that skill'),
        'prompt should direct reuse when the capability already exists');
});


const { parseWithRepair } = require('../utils/jsonRepair');

test('parseWithRepair: recovers Python-style escapes inside a JSON string', () => {
    const bad = '{"script": "help=\'an \\\'amount\\\' column\'", "n": 1}';
    assert.throws(() => JSON.parse(bad), 'precondition: plain parse must fail');

    const result = parseWithRepair(bad);
    assert.ok(result.value, `repair should recover the envelope: ${result.error}`);
    assert.equal(result.repaired, true);
    assert.ok(result.value.script.includes("\\'amount\\'"),
        `backslash must be preserved, got: ${result.value.script}`);
});

test('parseWithRepair: recovers a raw newline inside a string value', () => {
    const result = parseWithRepair('{"code": "line1\nline2"}');
    assert.ok(result.value);
    assert.equal(result.value.code, 'line1\nline2');
});

test('parseWithRepair: leaves valid escapes untouched and reports no repair', () => {
    const good = '{"s": "a\\nb \\"q\\" c\\\\d"}';
    const result = parseWithRepair(good);
    assert.equal(result.repaired, false, 'valid JSON must not take the repair path');
    assert.equal(result.value.s, 'a\nb "q" c\\d');
});

test('parseWithRepair: strips the // comments models write into JSON', () => {
    const bad = `{
      "goal": "Count lines",
      "steps": [{
        "id": "s1",
        "inputs": {
          "directory": "/path/to/project",  // Replace with the actual folder
          "out": "/tmp/x.csv"  // and a CSV path
        }
      }]
    }`;
    assert.throws(() => JSON.parse(bad), 'precondition: plain parse must fail');

    const result = parseWithRepair(bad);
    assert.ok(result.value, `should recover: ${result.error}`);
    assert.equal(result.value.steps[0].inputs.directory, '/path/to/project');
});

test('parseWithRepair: a // inside a string value is not a comment', () => {
    const result = parseWithRepair('{"url": "https://example.com/a", "n": 1}');
    assert.equal(result.value.url, 'https://example.com/a');
    assert.equal(result.repaired, false, 'valid JSON must not take the repair path');
});

test('parseWithRepair: comments and bad escapes together still parse', () => {
    const bad = '{"script": "help=\'an \\\'x\\\' col\'",  // note\n "n": 1}';
    const result = parseWithRepair(bad);
    assert.ok(result.value, `should recover: ${result.error}`);
    assert.equal(result.value.n, 1);
});

test('parseWithRepair: structural damage is still rejected', () => {
    for (const broken of ['{"a": ', '{"a": 1', '{"a": 1,}', 'not json at all']) {
        assert.equal(parseWithRepair(broken).value, null, `should reject: ${broken}`);
    }
});

test('extractJson: recovers an envelope that only parses after repair', () => {
    const raw = '```json\n{"name": "x", "script": "print(\'\\\'hi\\\'\')"}\n```';
    const parsed = generator.extractJson(raw);
    assert.ok(parsed, 'generator should recover the repaired envelope');
    assert.equal(parsed.name, 'x');
});


const twoPartResponse = [
    'Here is the skill.',
    '',
    '```json',
    '{"name":"demo","description":"d","parameters":{"in_csv":{"type":"string","required":true}},' +
      '"reply":"ok","tests":[{"name":"t","parameters":{"in_csv":"a.csv"},"expect":{"exit_code":0}}]}',
    '```',
    '',
    '```python',
    'import sys',
    'row = {"amount": 5}',
    'print(f\'value: {row["amount"]}\', file=sys.stderr)',
    'print("done")',
    '```'
].join('\n');

test('extractJson: reads metadata and script from a two-part response', () => {
    const parsed = generator.extractJson(twoPartResponse);
    assert.ok(parsed, 'two-part response should parse');
    assert.equal(parsed.name, 'demo');
    assert.ok(parsed.parameters.in_csv, 'metadata must survive');
});

test('extractJson: code with bare double quotes survives verbatim', () => {
    const parsed = generator.extractJson(twoPartResponse);
    assert.ok(parsed.script.includes('row["amount"]'), `quotes mangled: ${parsed.script}`);
    assert.ok(parsed.script.includes('print("done")'));
});

test('extractJson: the JSON fence is not mistaken for the script', () => {
    const parsed = generator.extractJson(twoPartResponse);
    assert.ok(!parsed.script.includes('"name"'), 'metadata leaked into the script');
    assert.ok(parsed.script.startsWith('import sys'));
});

test('extractJson: braces inside the script do not confuse metadata extraction', () => {
    const withBraces = [
        '```json',
        '{"name":"b","description":"d","parameters":{},"reply":"ok",' +
          '"tests":[{"name":"t","parameters":{},"expect":{"exit_code":0}}]}',
        '```',
        '```python',
        'cfg = {"nested": {"deep": [1, 2]}}',
        'print(cfg)',
        '```'
    ].join('\n');
    const parsed = generator.extractJson(withBraces);
    assert.equal(parsed.name, 'b');
    assert.ok(parsed.script.includes('nested'));
});

test('extractJson: falls back to a script key when a model ignores the format', () => {
    const singleJson = '{"name":"x","description":"d","parameters":{},"reply":"ok",' +
        '"script":"print(1)","tests":[{"name":"t","parameters":{},"expect":{"exit_code":0}}]}';
    const parsed = generator.extractJson(singleJson);
    assert.ok(parsed, 'legacy single-JSON responses should still work');
    assert.equal(parsed.script, 'print(1)');
});

test('buildPrompt: instructs the two-part format and forbids code in JSON', () => {
    const prompt = generator.buildPrompt(skillRegistry.list());
    assert.ok(prompt.includes('PART 1'), 'metadata part must be described');
    assert.ok(prompt.includes('PART 2'), 'script part must be described');
    assert.ok(prompt.includes('```python'), 'fenced python block must be shown');
    assert.ok(/Never place source code inside the\s+JSON/.test(prompt),
        'prompt must forbid code inside JSON');
});
