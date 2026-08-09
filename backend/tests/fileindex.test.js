const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fileIndex = require('../services/fileIndex');
const corpusIndexer = require('../services/corpusIndexer');
const store = require('../security/store');

function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-fi-'));
    fileIndex.open(path.join(dir, 'files.db'));
    store.open(path.join(dir, 'security.db'));

    const root = path.join(dir, 'tree');
    fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(root, '.ssh'), { recursive: true });

    fs.writeFileSync(path.join(root, 'notes', 'thesis-outline.md'), 'chapter list');
    fs.writeFileSync(path.join(root, 'notes', 'invoice-march.txt'), 'amount due');
    fs.writeFileSync(path.join(root, 'node_modules', 'junk.js'), 'dependency');
    fs.writeFileSync(path.join(root, '.ssh', 'id_rsa'), 'PRIVATE KEY');
    fs.writeFileSync(path.join(root, '.env'), 'API_KEY=secret');
    fs.writeFileSync(path.join(root, 'server.pem'), 'BEGIN PRIVATE KEY');
    fs.writeFileSync(path.join(root, 'compiled.pyc'), 'bytecode');

    return { dir, root };
}

function cleanup(dir) {
    fileIndex.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
}


test('the crawl lists ordinary files and nothing else', () => {
    const { dir, root } = fixture();
    fileIndex.crawl({ roots: [root] });

    const names = fileIndex.search({}).map(f => f.name).sort();
    assert.deepStrictEqual(names, ['invoice-march.txt', 'thesis-outline.md']);

    cleanup(dir);
});

test('credentials never appear in the metadata index', () => {
    const { dir, root } = fixture();
    fileIndex.crawl({ roots: [root] });

    for (const secret of ['.ssh/id_rsa', '.env', 'server.pem']) {
        assert.strictEqual(fileIndex.get(path.join(root, secret)), null,
            `${secret} must not be indexed`);
    }

    cleanup(dir);
});

test('dependency trees and build artefacts are skipped', () => {
    const { dir, root } = fixture();
    const result = fileIndex.crawl({ roots: [root] });

    assert.strictEqual(fileIndex.get(path.join(root, 'node_modules', 'junk.js')), null);
    assert.strictEqual(fileIndex.get(path.join(root, 'compiled.pyc')), null);
    assert.ok(result.skipped > 0, 'skips must be counted, not silent');

    cleanup(dir);
});


test('a filename is findable by any word in it', () => {
    const { dir, root } = fixture();
    fileIndex.crawl({ roots: [root] });

    assert.deepStrictEqual(fileIndex.search({ text: 'outline' }).map(f => f.name),
        ['thesis-outline.md']);
    assert.deepStrictEqual(fileIndex.search({ text: 'thesis' }).map(f => f.name),
        ['thesis-outline.md']);

    cleanup(dir);
});

test('search matches on a prefix, so a half-remembered name still works', () => {
    const { dir, root } = fixture();
    fileIndex.crawl({ roots: [root] });

    assert.deepStrictEqual(fileIndex.search({ text: 'invo' }).map(f => f.name),
        ['invoice-march.txt']);

    cleanup(dir);
});

test('punctuation in a query is not a syntax error', () => {
    const { dir, root } = fixture();
    fileIndex.crawl({ roots: [root] });

    assert.doesNotThrow(() => fileIndex.search({ text: 'where\'s the "thesis" (draft)?' }));
    assert.ok(fileIndex.search({ text: 'where\'s the "thesis" (draft)?' }).length >= 1);

    cleanup(dir);
});

test('a query of only noise matches nothing rather than everything', () => {
    const { dir, root } = fixture();
    fileIndex.crawl({ roots: [root] });

    assert.strictEqual(fileIndex.toMatchQuery('!!! ?'), null);

    cleanup(dir);
});

test('results can be narrowed by extension and by directory', () => {
    const { dir, root } = fixture();
    fileIndex.crawl({ roots: [root] });

    assert.deepStrictEqual(fileIndex.search({ ext: 'md' }).map(f => f.name),
        ['thesis-outline.md']);
    assert.deepStrictEqual(fileIndex.search({ ext: '.md' }).map(f => f.name),
        ['thesis-outline.md']);
    assert.strictEqual(fileIndex.search({ dir: path.join(root, 'notes') }).length, 2);
    assert.strictEqual(fileIndex.search({ dir: path.join(root, 'nowhere') }).length, 0);

    cleanup(dir);
});

test('results can be narrowed by modification time', () => {
    const { dir, root } = fixture();
    fileIndex.crawl({ roots: [root] });

    assert.strictEqual(fileIndex.search({ modifiedAfter: Date.now() + 60000 }).length, 0);
    assert.strictEqual(fileIndex.search({ modifiedAfter: Date.now() - 60000 }).length, 2);

    cleanup(dir);
});


test('a deleted file is dropped on the next crawl', () => {
    const { dir, root } = fixture();
    fileIndex.crawl({ roots: [root] });
    fs.unlinkSync(path.join(root, 'notes', 'invoice-march.txt'));

    const result = fileIndex.crawl({ roots: [root] });

    assert.strictEqual(result.removed, 1);
    assert.deepStrictEqual(fileIndex.search({}).map(f => f.name), ['thesis-outline.md']);

    cleanup(dir);
});

test('crawling one root does not evict another', () => {
    const { dir, root } = fixture();
    const other = path.join(dir, 'other');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'elsewhere.md'), 'kept');

    fileIndex.crawl({ roots: [root] });
    fileIndex.crawl({ roots: [other] });

    assert.strictEqual(fileIndex.search({}).length, 3);

    cleanup(dir);
});

test('re-crawling picks up a changed size', () => {
    const { dir, root } = fixture();
    fileIndex.crawl({ roots: [root] });
    const before = fileIndex.get(path.join(root, 'notes', 'thesis-outline.md')).size;

    fs.writeFileSync(path.join(root, 'notes', 'thesis-outline.md'), 'a much longer chapter list');
    fileIndex.crawl({ roots: [root] });

    assert.ok(fileIndex.get(path.join(root, 'notes', 'thesis-outline.md')).size > before);
    cleanup(dir);
});

test('content-indexed files are flagged, so the tiers are distinguishable', () => {
    const { dir, root } = fixture();
    fileIndex.crawl({ roots: [root] });
    const target = path.join(root, 'notes', 'thesis-outline.md');

    assert.strictEqual(fileIndex.get(target).content_indexed, false);
    assert.strictEqual(fileIndex.markContentIndexed([target]), 1);
    assert.strictEqual(fileIndex.get(target).content_indexed, true);

    cleanup(dir);
});

test('stats report what is covered by each tier', () => {
    const { dir, root } = fixture();
    fileIndex.crawl({ roots: [root] });
    fileIndex.markContentIndexed([path.join(root, 'notes', 'thesis-outline.md')]);

    const s = fileIndex.stats();
    assert.strictEqual(s.files, 2);
    assert.strictEqual(s.content_indexed, 1);
    assert.ok(s.lastCrawl, 'a crawl must leave a record of itself');

    cleanup(dir);
});


test('content indexing refuses a directory that was never granted', async () => {
    const { dir, root } = fixture();

    await assert.rejects(
        () => corpusIndexer.build({ name: 'documents', roots: [root], dir }),
        /not granted/
    );

    cleanup(dir);
});

test('a granted directory passes the consent check, and revoking closes it again', async () => {
    const { dir, root } = fixture();

    store.grantRoot(root, 'documents');
    assert.ok(store.isWithinGrantedRoot(path.join(root, 'notes', 'thesis-outline.md'), 'documents'));

    store.revokeRoot(root, 'documents');
    await assert.rejects(
        () => corpusIndexer.build({ name: 'documents', roots: [root], dir }),
        /not granted/
    );

    cleanup(dir);
});

test('the refusal names the command that would grant access', async () => {
    const { dir, root } = fixture();

    await assert.rejects(
        () => corpusIndexer.build({ name: 'documents', roots: [root], dir }),
        err => /index-corpus/.test(err.message)
    );

    cleanup(dir);
});
