const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const vectorIndex = require('../services/vectorIndex');
const corpusIndexer = require('../services/corpusIndexer');

const DIM = vectorIndex.DIM;

function tmpdir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-corpus-'));
}

function axis(i, value = 1) {
    const v = new Array(DIM).fill(0);
    v[i] = value;
    return v;
}


test('chunk splits on paragraphs and drops fragments', () => {
    const chunks = corpusIndexer.chunk(
        'This is the first paragraph, long enough to be kept in the index.\n\n' +
        'ok\n\n' +
        'And here is a second substantial paragraph with enough characters.'
    );

    assert.strictEqual(chunks.length, 2);
    assert.ok(chunks[0].startsWith('This is the first'));
    assert.ok(!chunks.some(c => c === 'ok'));
});

test('chunk breaks an oversized paragraph rather than emitting one huge vector', () => {
    const sentence = 'This sentence is of a very ordinary length indeed. ';
    const chunks = corpusIndexer.chunk(sentence.repeat(80), { maxChars: 300 });

    assert.ok(chunks.length > 1);
    for (const c of chunks) assert.ok(c.length <= 300, `chunk of ${c.length} exceeds the ceiling`);
});

test('chunk hard-splits a single sentence longer than the ceiling', () => {
    const chunks = corpusIndexer.chunk('x'.repeat(1000), { maxChars: 200 });

    assert.ok(chunks.length >= 5);
    for (const c of chunks) assert.ok(c.length <= 200);
});


test('parseEmlx extracts headers and body, dropping the length prefix and plist', () => {
    const raw = [
        '482',
        'From: Priya <priya@example.com>',
        'To: me@example.com',
        'Subject: Project deadline',
        'Date: Mon, 3 Mar 2025 09:12:00 +0000',
        '',
        'The deadline moved to the 14th.',
        '',
        '<?xml version="1.0"?><plist></plist>'
    ].join('\n');

    const mail = corpusIndexer.parseEmlx(raw);

    assert.strictEqual(mail.subject, 'Project deadline');
    assert.strictEqual(mail.from, 'Priya <priya@example.com>');
    assert.match(mail.body, /deadline moved to the 14th/);
    assert.ok(!mail.body.includes('plist'), 'the trailing plist must not be indexed');
});

test('parseEmlx keeps the plain-text part of a multipart message', () => {
    const raw = [
        '900',
        'From: a@example.com',
        'Subject: Multipart',
        'Content-Type: multipart/alternative; boundary="BOUND1"',
        '',
        '--BOUND1',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'The readable version of the message.',
        '--BOUND1',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<html><body>The HTML version</body></html>',
        '--BOUND1--'
    ].join('\n');

    const mail = corpusIndexer.parseEmlx(raw);

    assert.match(mail.body, /readable version/);
    assert.ok(!/<html>/.test(mail.body), 'HTML alternate must not be indexed');
});

test('parseEmlx returns null for a message with no body', () => {
    assert.strictEqual(corpusIndexer.parseEmlx('12\nSubject: empty\n\n'), null);
});


test('mail records carry sender and subject into the embedded text', () => {
    const dir = tmpdir();
    const file = path.join(dir, 'm.emlx');
    fs.writeFileSync(file, [
        '100',
        'From: Priya <priya@example.com>',
        'Subject: Project deadline',
        '',
        'We agreed to move everything to the fourteenth of the month.'
    ].join('\n'));

    const [record] = corpusIndexer.recordsForFile(file, { kind: 'mail' });

    assert.match(record.text, /Priya/);
    assert.match(record.text, /Project deadline/);
    assert.ok(!record.meta.text.includes('Email from'));
});

test('document records carry the filename into the embedded text', () => {
    const dir = tmpdir();
    const file = path.join(dir, 'thesis-outline.md');
    fs.writeFileSync(file, 'The chapters are ordered by when the experiments were run.');

    const [record] = corpusIndexer.recordsForFile(file);

    assert.match(record.text, /thesis-outline\.md/);
    assert.strictEqual(record.meta.name, 'thesis-outline.md');
});


test('discover skips dependency and build directories', () => {
    const dir = tmpdir();
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'notes', 'keep.md'), 'keep me');
    fs.writeFileSync(path.join(dir, 'node_modules', 'skip.md'), 'skip me');

    const found = corpusIndexer.discover(dir);

    assert.strictEqual(found.length, 1);
    assert.match(found[0], /keep\.md$/);
});

test('discover ignores binary and unknown extensions', () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'a.md'), 'text');
    fs.writeFileSync(path.join(dir, 'b.png'), 'not text');

    const found = corpusIndexer.discover(dir);

    assert.strictEqual(found.length, 1);
    assert.match(found[0], /a\.md$/);
});


test('search ranks by cosine similarity', () => {
    const dir = tmpdir();
    const collection = new vectorIndex.Collection('t', dir);

    collection.replace([
        { vector: axis(0), meta: { id: 'along-0' } },
        { vector: axis(1), meta: { id: 'along-1' } },
        { vector: axis(2), meta: { id: 'along-2' } }
    ]);

    const hits = collection.search(axis(1), { topK: 3 });

    assert.strictEqual(hits[0].meta.id, 'along-1');
    assert.ok(hits[0].score > 0.99);
});

test('minScore keeps irrelevant context out rather than padding the answer', () => {
    const dir = tmpdir();
    const collection = new vectorIndex.Collection('t', dir);

    collection.replace([
        { vector: axis(0), meta: { id: 'orthogonal' } }
    ]);

    assert.deepStrictEqual(collection.search(axis(1), { minScore: 0.3 }), []);
});

test('vectors survive a save and reload unchanged', () => {
    const dir = tmpdir();

    new vectorIndex.Collection('t', dir)
        .replace([
            { vector: axis(5), meta: { id: 'five', text: 'hello' } },
            { vector: axis(9), meta: { id: 'nine', text: 'world' } }
        ])
        .save();

    const reopened = new vectorIndex.Collection('t', dir).load();

    assert.strictEqual(reopened.size, 2);
    const hits = reopened.search(axis(9), { topK: 1 });
    assert.strictEqual(hits[0].meta.id, 'nine');
    assert.strictEqual(hits[0].meta.text, 'world');
});

test('unnormalised vectors are normalised, so magnitude cannot outrank direction', () => {
    const dir = tmpdir();
    const collection = new vectorIndex.Collection('t', dir);

    collection.replace([
        { vector: axis(0, 100), meta: { id: 'loud-but-wrong' } },
        { vector: axis(1, 0.01), meta: { id: 'quiet-but-right' } }
    ]);

    const hits = collection.search(axis(1), { topK: 2 });
    assert.strictEqual(hits[0].meta.id, 'quiet-but-right');
});

test('a mismatched vector width is rejected rather than silently stored', () => {
    const collection = new vectorIndex.Collection('t', tmpdir());
    assert.throws(
        () => collection.replace([{ vector: [1, 2, 3], meta: {} }]),
        /dimensions/
    );
});

function writeLegacy(dir, name, rows) {
    const buffer = Buffer.alloc(rows.length * DIM * 4);
    rows.forEach((row, i) => {
        row.vector.forEach((value, d) => buffer.writeFloatLE(value, (i * DIM + d) * 4));
    });
    fs.writeFileSync(path.join(dir, `${name}.vec`), buffer);
    fs.writeFileSync(path.join(dir, `${name}.jsonl`),
        rows.map(row => JSON.stringify(row.meta)).join('\n') + '\n');
}

test('a legacy .vec/.jsonl pair is imported into sqlite once', () => {
    const dir = tmpdir();
    writeLegacy(dir, 't', [
        { vector: axis(3), meta: { id: 'three' } },
        { vector: axis(7), meta: { id: 'seven' } }
    ]);

    const imported = new vectorIndex.Collection('t', dir).load();
    assert.strictEqual(imported.size, 2);
    assert.strictEqual(imported.search(axis(7), { topK: 1 })[0].meta.id, 'seven');
    assert.ok(!fs.existsSync(path.join(dir, 't.vec')), 'legacy files must stop shadowing the db');
    assert.ok(fs.existsSync(path.join(dir, 't.vec.imported')), 'legacy bytes must survive the import');

    const again = new vectorIndex.Collection('t', dir).load();
    assert.strictEqual(again.size, 2);
});

test('legacy files that disagree are ignored, not imported and not fatal', () => {
    const dir = tmpdir();
    writeLegacy(dir, 't', [{ vector: axis(0), meta: { id: 'a' } }]);
    fs.appendFileSync(path.join(dir, 't.jsonl'), JSON.stringify({ id: 'orphan' }) + '\n');

    const reopened = new vectorIndex.Collection('t', dir).load();
    assert.strictEqual(reopened.size, 0);
    assert.ok(fs.existsSync(path.join(dir, 't.vec')), 'a refused import must leave the files alone');
});

test('a missing collection is empty rather than an error', () => {
    const collection = new vectorIndex.Collection('never-written', tmpdir()).load();
    assert.strictEqual(collection.size, 0);
    assert.deepStrictEqual(collection.search(axis(0)), []);
});

test('hashes reports what is already indexed, so unchanged files can be skipped', () => {
    const collection = new vectorIndex.Collection('t', tmpdir());
    collection.replace([
        { vector: axis(0), meta: { hash: 'abc' } },
        { vector: axis(1), meta: { hash: 'def' } }
    ]);

    assert.deepStrictEqual([...collection.hashes()].sort(), ['abc', 'def']);
});

test('the same chunk in the same file hashes identically across runs', () => {
    const dir = tmpdir();
    const file = path.join(dir, 'a.md');
    fs.writeFileSync(file, 'A paragraph with enough characters to be indexed properly.');

    const first = corpusIndexer.recordsForFile(file);
    const second = corpusIndexer.recordsForFile(file);

    assert.strictEqual(first[0].meta.hash, second[0].meta.hash);
});
