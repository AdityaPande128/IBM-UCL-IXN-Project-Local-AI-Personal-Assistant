const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const test = require('node:test');
const assert = require('node:assert');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-seal-'));
process.env.JARVIS_DIRECT = 'off';
process.env.PORT = '18093';
process.env.JARVIS_SOCKET_TOKEN_PATH = path.join(scratch, 'socket-token');
process.env.JARVIS_PAIRING_SECRET_PATH = path.join(scratch, 'pairing-secret');
process.env.JARVIS_CONVERSATIONS_DB = path.join(scratch, 'conversations.db');
process.env.JARVIS_INBOX_DIR = path.join(scratch, 'inbox');
process.env.JARVIS_SAVE_DIR = path.join(scratch, 'saved');
process.env.INFERENCE_URL = 'http://127.0.0.1:18092';
process.env.JARVIS_LOGS_DIR = path.join(scratch, 'logs');
fs.mkdirSync(process.env.JARVIS_LOGS_DIR, { recursive: true });
fs.mkdirSync(process.env.JARVIS_SAVE_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.JARVIS_LOGS_DIR, 'backend.log'), 'boot ok\n');
process.env.JARVIS_CONFIG_PATH = path.join(scratch, 'config.json');
fs.copyFileSync(path.resolve(__dirname, '../../config.json'), process.env.JARVIS_CONFIG_PATH);
{
    // The fixture must not inherit this machine's live choices.
    const seeded = JSON.parse(fs.readFileSync(process.env.JARVIS_CONFIG_PATH, 'utf8'));
    delete seeded.mail;
    delete seeded.profile;
    if (seeded.models) delete seeded.models.tiers;
    fs.writeFileSync(process.env.JARVIS_CONFIG_PATH, JSON.stringify(seeded, null, 2));
}
process.env.JARVIS_SETTINGS_RESTART = 'off';
process.env.JARVIS_DOWNLOADS_PATH = path.join(scratch, 'downloads.json');
process.env.JARVIS_SECURITY_DB = path.join(scratch, 'security.db');
process.env.JARVIS_TELEGRAM_TOKEN_PATH = path.join(scratch, 'telegram-token');
process.env.JARVIS_TELEGRAM_BINDING_PATH = path.join(scratch, 'telegram-chat.json');

const traceStore = require('../services/traceStore');
traceStore.open(path.join(scratch, 'traces.db'));
const watchers = require('../services/watchers');
watchers.open(path.join(scratch, 'watchers.db'));
const memoryStore = require('../services/memoryStore');
memoryStore.open(path.join(scratch, 'memory.db'));
const memoryService = require('../services/memoryService');
memoryService.setEmbedder(async texts => texts.map(() => [1, 0, 0, 0]));

const WebSocket = require('ws');
const directCrypto = require('../services/directCrypto');
const remoteSeal = require('../services/remoteSeal');
const channelFrames = require('../services/channelFrames');
const conversationStore = require('../services/conversationStore');
const aiPipeline = require('../services/aiPipeline');

const fakeInference = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
        if (req.url === '/tts') {
            res.setHeader('Content-Type', 'audio/wav');
            res.end(Buffer.from('RIFF-not-really-audio'));
        } else {
            res.statusCode = 404;
            res.end();
        }
    });
});

const { server } = require('../server');

function ready() {
    return Promise.all([
        new Promise(resolve => (server.listening ? resolve() : server.once('listening', resolve))),
        new Promise(resolve => fakeInference.listen(18092, '127.0.0.1', resolve))
    ]);
}

function token() {
    return fs.readFileSync(process.env.JARVIS_SOCKET_TOKEN_PATH, 'utf8').trim();
}

function secret() {
    return fs.readFileSync(process.env.JARVIS_PAIRING_SECRET_PATH, 'utf8').trim();
}

const clients = [];

// A test client speaking the phone's sealed dialect over a plain socket.
function connectSealed() {
    return new Promise((resolve, reject) => {
        const key = directCrypto.derive(secret(), 'jarvis-remote/ws', 32);
        const ws = new WebSocket('ws://127.0.0.1:18093');
        clients.push(ws);
        const seen = new Map();
        const received = [];
        const frames = [];
        const waiters = [];
        const assemble = channelFrames.assembler();

        function check() {
            for (let i = waiters.length - 1; i >= 0; i--) {
                const waiter = waiters[i];
                const pool = waiter.frame ? frames : received;
                const found = pool.find(m => !m.__used && waiter.match(m));
                if (found) {
                    found.__used = true;
                    waiters.splice(i, 1);
                    waiter.resolve(found);
                }
            }
        }

        ws.on('message', (raw, isBinary) => {
            if (isBinary) {
                const openedBin = openBinary(key, 'mac', raw);
                if (!openedBin) return;
                const whole = assemble(openedBin);
                if (whole) { frames.push(whole); check(); }
                return;
            }
            const opened = directCrypto.open(key, 'phone', raw.toString(), seen);
            if (!opened.payload) return;
            received.push(opened.payload);
            check();
        });

        function openBinary(binKey, from, buf) {
            const crypto = require('crypto');
            if (buf.length < 37 || buf[0] !== 1) return null;
            const nonce = buf.subarray(1, 13);
            const ts = buf.subarray(13, 21);
            const sealed = buf.subarray(21);
            try {
                const decipher = crypto.createDecipheriv('aes-256-gcm', binKey, nonce);
                decipher.setAAD(Buffer.concat([Buffer.from(from, 'utf8'), ts]));
                decipher.setAuthTag(sealed.subarray(sealed.length - 16));
                return Buffer.concat([
                    decipher.update(sealed.subarray(0, sealed.length - 16)),
                    decipher.final()]);
            } catch { return null; }
        }

        function sealBinary(binKey, from, data) {
            const crypto = require('crypto');
            const nonce = crypto.randomBytes(12);
            const ts = Buffer.alloc(8);
            ts.writeBigUInt64BE(BigInt(Date.now()));
            const cipher = crypto.createCipheriv('aes-256-gcm', binKey, nonce);
            cipher.setAAD(Buffer.concat([Buffer.from(from, 'utf8'), ts]));
            const sealed = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
            return Buffer.concat([Buffer.from([1]), nonce, ts, sealed]);
        }

        let sid = 100;
        const api = {
            ws,
            send: obj => ws.send(directCrypto.seal(key, 'phone', obj)),
            sendFrames: (tag, meta, body) => {
                for (const frame of channelFrames.chunk(tag, { ...meta, sid: ++sid }, body)) {
                    ws.send(sealBinary(key, 'phone', frame), { binary: true });
                }
            },
            next(match, timeoutMs = 8000) {
                return new Promise((resolveNext, rejectNext) => {
                    waiters.push({ match, resolve: resolveNext });
                    check();
                    setTimeout(() => rejectNext(new Error('timed out waiting (sealed text)')),
                        timeoutMs).unref();
                });
            },
            nextFrame(match, timeoutMs = 8000) {
                return new Promise((resolveNext, rejectNext) => {
                    waiters.push({ frame: true, match, resolve: resolveNext });
                    check();
                    setTimeout(() => rejectNext(new Error('timed out waiting (sealed frame)')),
                        timeoutMs).unref();
                });
            }
        };

        ws.on('open', () => {
            ws.send(JSON.stringify({ type: 'seal', v: 1 }));
            api.send({ type: 'auth', token: token() });
            resolve(api);
        });
        ws.on('error', reject);
    });
}

test('the sealed dialect: hello, auth and requests all cross as ciphertext', async () => {
    await ready();
    const phone = await connectSealed();
    const connected = await phone.next(m => m.type === 'connected');
    assert.equal(typeof connected.message, 'string');
    phone.send({ type: 'status' });
    const status = await phone.next(m => m.type === 'status_result');
    assert.equal(typeof status.clients, 'number');
});

test('the sealed file lane: an upload and its download round-trip framed', async () => {
    const phone = await connectSealed();
    await phone.next(m => m.type === 'connected');
    const body = Buffer.from('sealed lane payload, resting easy');
    phone.sendFrames(channelFrames.TAG.FILE_REQ,
        { op: 'put', name: 'sealed.txt', reqId: 'r1' }, body);
    const put = await phone.nextFrame(f => f.meta.reqId === 'r1');
    assert.equal(put.meta.status, 200);
    const { id } = JSON.parse(put.meta.json);
    phone.sendFrames(channelFrames.TAG.FILE_REQ,
        { op: 'get', id, reqId: 'r2' }, Buffer.alloc(0));
    const got = await phone.nextFrame(f => f.meta.reqId === 'r2');
    assert.equal(got.meta.status, 200);
    assert.equal(got.body.toString(), body.toString());
});

test('file_save resolves an artifact id to a real copy under the chosen name', async () => {
    const phone = await connectSealed();
    await phone.next(m => m.type === 'connected');
    const original = path.join(scratch, 'Iron Story.pdf');
    fs.writeFileSync(original, 'twelve pages of ferritin');
    const fakeWs = { conversationId: null };
    conversationStore.append(fakeWs, 'assistant', 'Attached Iron Story.pdf.',
        { files: [{ name: 'Iron Story.pdf', path: original }] });
    const rows = conversationStore.messages(fakeWs.conversationId);
    const stampedId = rows.at(-1).artifacts.files[0].id;
    assert.match(stampedId, /^[0-9a-f]{12}$/);
    phone.send({ type: 'file_save', id: stampedId, name: 'Iron Story.pdf', to: 'downloads' });
    const saved = await phone.next(m => m.type === 'file_save_result');
    assert.equal(saved.status, 'saved');
    assert.equal(fs.readFileSync(saved.path, 'utf8'), 'twelve pages of ferritin');
    // A second save under the same name steps aside, never overwrites.
    phone.send({ type: 'file_save', id: stampedId, name: 'Iron Story.pdf', to: 'downloads' });
    const again = await phone.next(m => m.type === 'file_save_result' && !m.__used
        && m.path !== saved.path);
    assert.match(path.basename(again.path), /Iron Story \(2\)\.pdf$/);
});

test('a decision mid-sentence silences the rest of the reply', async () => {
    const sent = [];
    const fakeWs = {
        readyState: 1,
        conversationId: 7,
        send(data) {
            if (Buffer.isBuffer(data)) {
                sent.push('audio');
                // The user answers while the first chunk is still playing.
                aiPipeline.silence();
            } else {
                sent.push(JSON.parse(data).type);
            }
        }
    };
    const spoken = await aiPipeline.speakText(
        'First sentence here. Second sentence follows. Third never speaks.', fakeWs);
    assert.equal(spoken, 1);
    assert.ok(sent.includes('speak_start'));
    assert.equal(sent.filter(k => k === 'audio').length, 1);
});

test('garbage on a sealed socket is dropped, never fatal', async () => {
    const phone = await connectSealed();
    await phone.next(m => m.type === 'connected');
    phone.ws.send(Buffer.from([9, 9, 9, 9]), { binary: true });
    phone.ws.send('not an envelope at all');
    phone.send({ type: 'status' });
    const status = await phone.next(m => m.type === 'status_result');
    assert.equal(typeof status.clients, 'number');
});

test('the binary envelope: pinned bytes, round trip, tamper and replay refusal', () => {
    const crypto = require('crypto');
    const key = directCrypto.derive('a'.repeat(64), 'jarvis-remote/ws', 32);
    assert.equal(key.toString('hex'),
        'ea0caf873be8104371102f25ab03bca882b65273db18dfe99919602926382103');
    // The same fixed nonce and timestamp must produce the same bytes the
    // phone's implementation pins — a byte of drift is silent field failure.
    const nonce = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const ts = Buffer.alloc(8);
    ts.writeBigUInt64BE(1755700000000n);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.concat([Buffer.from('mac', 'utf8'), ts]));
    const fixed = Buffer.concat([Buffer.from([1]), nonce, ts,
        cipher.update(Buffer.from('sealed door', 'utf8')), cipher.final(), cipher.getAuthTag()]);
    assert.equal(fixed.toString('base64'),
        'AQABAgMEBQYHCAkKCwAAAZjH3/UAzFQwSFH6esZo6kDlDhKYtQqZeQW9/zF03opd');

    remoteSeal.init('a'.repeat(64));
    const sealed = remoteSeal.sealBinary('phone', Buffer.from('round trip'));
    assert.equal(remoteSeal.openBinary('phone', sealed).toString(), 'round trip');
    assert.equal(remoteSeal.openBinary('mac', sealed), null, 'AAD binds the sender');
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] ^= 0xff;
    assert.equal(remoteSeal.openBinary('phone', tampered), null);
    const stale = Buffer.from(sealed);
    stale.writeBigUInt64BE(1000000n, 13);
    assert.equal(remoteSeal.openBinary('phone', stale), null, 'the window closes replays');
});

test.after(() => {
    for (const ws of clients) { try { ws.close(); } catch { /* closing */ } }
    fakeInference.close();
    server.close();
});
