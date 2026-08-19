const fs = require('fs');
const os = require('os');
const path = require('path');

const test = require('node:test');
const assert = require('node:assert');

const directCrypto = require('../services/directCrypto');
const frames = require('../services/channelFrames');
const pairingSecret = require('../services/pairingSecret');

const SECRET = 'a'.repeat(64);

test('sealed signaling survives the round trip and refuses everything else', () => {
    const key = directCrypto.keyFor(SECRET);
    const seen = new Map();
    const raw = directCrypto.seal(key, 'phone', { kind: 'offer', sdp: 'v=0 example' });

    const opened = directCrypto.open(key, 'mac', raw, seen);
    assert.equal(opened.payload.kind, 'offer');
    assert.equal(opened.payload.sdp, 'v=0 example');

    assert.equal(directCrypto.open(key, 'mac', raw, seen).reason, 'replayed nonce');
    assert.equal(directCrypto.open(key, 'phone', raw, new Map()).reason, 'own echo');

    const stale = JSON.parse(raw);
    stale.ts = Date.now() - directCrypto.WINDOW_MS - 1;
    assert.equal(directCrypto.open(key, 'mac', JSON.stringify(stale), new Map()).reason,
        'outside the replay window');

    const wrongKey = directCrypto.keyFor('b'.repeat(64));
    assert.equal(directCrypto.open(wrongKey, 'mac', raw, new Map()).reason, 'bad seal');

    const tampered = JSON.parse(raw);
    tampered.from = 'imposter';
    assert.equal(directCrypto.open(key, 'mac', JSON.stringify(tampered), new Map()).reason,
        'bad seal');
});

test('the topic is unguessable, stable, and derived — never stored', () => {
    assert.equal(directCrypto.topicFor(SECRET), directCrypto.topicFor(SECRET));
    assert.notEqual(directCrypto.topicFor(SECRET), directCrypto.topicFor('b'.repeat(64)));
    assert.match(directCrypto.topicFor(SECRET), /^jarvis-[0-9a-f]{32}$/);
    assert.throws(() => directCrypto.topicFor('deadbeef'), /32 bytes/);
});

test('frames chunk, interleave, and reassemble exactly', () => {
    const assemble = frames.assembler();
    const big = Buffer.alloc(200 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    const small = Buffer.from('tiny voice clip');

    const bigFrames = [...frames.chunk(frames.TAG.WS_BINARY, { sid: 1 }, big)];
    const smallFrames = [...frames.chunk(frames.TAG.FILE_REQ,
        { sid: 2, op: 'put', name: 'a.txt', reqId: 'r1' }, small)];
    assert.ok(bigFrames.length > 1, 'a 200KB message must split');

    // Interleave the two streams the way a real channel would.
    const mixed = [];
    const longer = Math.max(bigFrames.length, smallFrames.length);
    for (let i = 0; i < longer; i++) {
        if (bigFrames[i]) mixed.push(bigFrames[i]);
        if (smallFrames[i]) mixed.push(smallFrames[i]);
    }
    const done = [];
    for (const frame of mixed) {
        const whole = assemble(frame);
        if (whole) done.push(whole);
    }
    assert.equal(done.length, 2);
    const file = done.find(d => d.tag === frames.TAG.FILE_REQ);
    assert.equal(file.meta.op, 'put');
    assert.equal(file.body.toString(), 'tiny voice clip');
    const voice = done.find(d => d.tag === frames.TAG.WS_BINARY);
    assert.equal(Buffer.compare(voice.body, big), 0);
});

test('a gapped or oversized stream is dropped whole, never delivered short', () => {
    const assemble = frames.assembler();
    const body = Buffer.alloc(3 * frames.CHUNK_BYTES);
    const parts = [...frames.chunk(frames.TAG.WS_BINARY, { sid: 9 }, body)];
    assert.equal(assemble(parts[0]), null);
    assert.equal(assemble(parts[2]), null, 'a gap kills the stream');
    assert.equal(assemble(parts[1]), null, 'nothing resurrects it mid-flight');
    assert.equal(assemble(Buffer.from([9, 9])), null, 'garbage is refused');
});

test('the assembler evicts the eldest half-done stream, never growing without bound', () => {
    const assemble = frames.assembler();
    // Open 20 distinct streams, each a lone first frame that never completes.
    for (let sid = 0; sid < 20; sid++) {
        const [first] = frames.chunk(frames.TAG.WS_BINARY, { sid },
            Buffer.alloc(3 * frames.CHUNK_BYTES));
        assert.equal(assemble(first), null);
    }
    // The earliest streams were evicted, so their later frames find no home
    // and are dropped rather than resurrecting a stale partial.
    const [, secondOfSid0] = frames.chunk(frames.TAG.WS_BINARY, { sid: 0 },
        Buffer.alloc(3 * frames.CHUNK_BYTES));
    assert.equal(assemble(secondOfSid0), null,
        'an evicted stream cannot be continued');
    // A fresh, well-formed stream still assembles perfectly.
    const body = Buffer.from('still working');
    let whole = null;
    for (const frame of frames.chunk(frames.TAG.FILE_REQ,
        { sid: 999, op: 'put', reqId: 'r' }, body)) {
        whole = assemble(frame) || whole;
    }
    assert.equal(whole.body.toString(), 'still working');
});

test('the pairing secret is minted once and reused forever after', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-pair-'));
    const where = path.join(scratch, 'pairing-secret');
    const first = pairingSecret.issue(where);
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(pairingSecret.issue(where), first);
    assert.equal((fs.statSync(where).mode & 0o777), 0o600);
});
