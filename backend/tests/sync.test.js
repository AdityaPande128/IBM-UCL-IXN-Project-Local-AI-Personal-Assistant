const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const test = require('node:test');
const assert = require('node:assert');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-sync-'));
process.env.PORT = '18097';
process.env.JARVIS_SOCKET_TOKEN_PATH = path.join(scratch, 'socket-token');
process.env.JARVIS_CONVERSATIONS_DB = path.join(scratch, 'conversations.db');
process.env.INFERENCE_URL = 'http://127.0.0.1:18096';
process.env.JARVIS_LOGS_DIR = path.join(scratch, 'logs');
process.env.JARVIS_DIAGNOSTICS_DIR = path.join(scratch, 'diagnostics');
fs.mkdirSync(process.env.JARVIS_LOGS_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.JARVIS_LOGS_DIR, 'backend.log'), 'boot ok\n');
process.env.JARVIS_CONFIG_PATH = path.join(scratch, 'config.json');
fs.copyFileSync(path.resolve(__dirname, '../../config.json'), process.env.JARVIS_CONFIG_PATH);
{
    const seeded = JSON.parse(fs.readFileSync(process.env.JARVIS_CONFIG_PATH, 'utf8'));
    delete seeded.mail;
    delete seeded.profile;
    if (seeded.models) delete seeded.models.tiers;
    fs.writeFileSync(process.env.JARVIS_CONFIG_PATH, JSON.stringify(seeded, null, 2));
}
process.env.JARVIS_SETTINGS_RESTART = 'off';
process.env.JARVIS_CHECKPOINTS_DIR = path.join(scratch, 'checkpoints');
process.env.JARVIS_DOWNLOADS_PATH = path.join(scratch, 'downloads.json');
process.env.JARVIS_SECURITY_DB = path.join(scratch, 'security.db');
process.env.JARVIS_TELEGRAM_TOKEN_PATH = path.join(scratch, 'telegram-token');
process.env.JARVIS_TELEGRAM_BINDING_PATH = path.join(scratch, 'telegram-chat.json');
process.env.JARVIS_INBOX_DIR = path.join(scratch, 'inbox');

const traceStore = require('../services/traceStore');
traceStore.open(path.join(scratch, 'traces.db'));
const watchers = require('../services/watchers');
watchers.open(path.join(scratch, 'watchers.db'));
const memoryStore = require('../services/memoryStore');
memoryStore.open(path.join(scratch, 'memory.db'));
const memoryService = require('../services/memoryService');
memoryService.setEmbedder(async texts => texts.map(() => [1, 0, 0, 0]));

const WebSocket = require('ws');
const conversationStore = require('../services/conversationStore');

const fakeInference = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.statusCode = 404; res.end(); });
});

const { server } = require('../server');

const clients = [];

let readiness = null;
function ready() {
    if (!readiness) {
        readiness = Promise.all([
            new Promise(resolve => (server.listening ? resolve() : server.once('listening', resolve))),
            new Promise(resolve => fakeInference.listen(18096, '127.0.0.1', resolve))
        ]);
    }
    return readiness;
}

function token() {
    return fs.readFileSync(process.env.JARVIS_SOCKET_TOKEN_PATH, 'utf8').trim();
}

function connect() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket('ws://127.0.0.1:18097');
        clients.push(ws);
        const received = [];
        const waiters = [];

        function check() {
            for (let i = waiters.length - 1; i >= 0; i--) {
                const waiter = waiters[i];
                const found = received.find(m => !m.__used && waiter.match(m));
                if (found) {
                    found.__used = true;
                    waiters.splice(i, 1);
                    waiter.resolve(found);
                }
            }
        }

        ws.on('message', (raw, isBinary) => {
            if (isBinary) return;
            received.push(JSON.parse(raw.toString()));
            check();
        });

        const api = {
            ws, received,
            send: obj => ws.send(JSON.stringify(obj)),
            next(match, timeoutMs = 10000) {
                return new Promise((resolveNext, rejectNext) => {
                    waiters.push({ match, resolve: resolveNext });
                    check();
                    setTimeout(() => rejectNext(new Error('timed out waiting for a message')),
                        timeoutMs).unref();
                });
            }
        };
        ws.on('open', () => resolve(api));
        ws.on('error', reject);
    });
}

async function authed() {
    const client = await connect();
    client.send({ type: 'auth', token: token() });
    await client.next(m => m.type === 'connected');
    return client;
}

function httpCall(method, url, { headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(`http://127.0.0.1:18097${url}`, { method, headers }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks)
            }));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

test('a second surface hears the conversation grow, the origin does not echo', async () => {
    await ready();
    const phone = await authed();
    const mac = await authed();

    phone.send({ type: 'intent', text: 'hello from the phone' });

    const startedOnMac = await mac.next(m => m.type === 'conversation_event'
        && m.kind === 'started' && m.message && m.message.text === 'hello from the phone');
    assert.ok(startedOnMac.conversation.id, 'the event names the conversation');
    assert.ok(startedOnMac.conversation.title, 'a started event carries the title');
    assert.equal(startedOnMac.message.role, 'user');

    await mac.next(m => m.type === 'conversation_event' && m.kind === 'busy' && m.busy === true);
    const replyOnMac = await mac.next(m => m.type === 'conversation_event'
        && m.kind === 'message' && m.message.role !== 'user');
    assert.equal(replyOnMac.conversation.id, startedOnMac.conversation.id);
    await mac.next(m => m.type === 'conversation_event' && m.kind === 'busy' && m.busy === false);

    const result = await phone.next(m => m.type === 'intent_result');
    assert.equal(result.conversation, startedOnMac.conversation.id,
        'the result names the conversation it belongs to');
    assert.equal(phone.received.filter(m => m.type === 'conversation_event').length, 0,
        'the origin socket never hears its own conversation echoed');
});

test('the file lane takes an upload, refuses strangers, and serves it back', async () => {
    await ready();
    const bearer = { authorization: `Bearer ${token()}` };

    const refused = await httpCall('PUT', '/files', {
        headers: { 'x-filename': 'notes.txt' }, body: 'no token' });
    assert.equal(refused.status, 401);

    const wrongKind = await httpCall('PUT', '/files', {
        headers: { ...bearer, 'x-filename': 'payload.exe' }, body: 'nope' });
    assert.equal(wrongKind.status, 415);

    const sent = await httpCall('PUT', '/files', {
        headers: { ...bearer, 'x-filename': 'notes.txt' },
        body: 'jarvis on the phone' });
    assert.equal(sent.status, 200);
    const uploaded = JSON.parse(sent.body.toString());
    assert.match(uploaded.id, /^[0-9a-f]{12}$/);
    assert.equal(uploaded.name, 'notes.txt');

    const anonymous = await httpCall('GET', `/files/${uploaded.id}`);
    assert.equal(anonymous.status, 401);

    const fetched = await httpCall('GET', `/files/${uploaded.id}`, { headers: bearer });
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.toString(), 'jarvis on the phone');
    assert.match(fetched.headers['content-type'], /text\/plain/);
});

test('an attached upload rides the intent as an artifact every surface can see', async () => {
    await ready();
    const bearer = { authorization: `Bearer ${token()}` };
    const sent = await httpCall('PUT', '/files', {
        headers: { ...bearer, 'x-filename': 'report.md' }, body: '# quarterly' });
    const uploaded = JSON.parse(sent.body.toString());

    const phone = await authed();
    const mac = await authed();
    phone.send({ type: 'intent', text: 'what does this say',
        attachments: [uploaded.id] });

    const started = await mac.next(m => m.type === 'conversation_event'
        && m.kind === 'started' && m.message.text === 'what does this say');
    const chip = started.message.artifacts.files[0];
    assert.equal(chip.id, uploaded.id);
    assert.equal(chip.name, 'report.md');
    await phone.next(m => m.type === 'intent_result');
});

test('a recorded artifact is minted an id the file lane can serve', async () => {
    await ready();
    const made = path.join(scratch, 'made-by-a-skill.txt');
    fs.writeFileSync(made, 'skill output');
    const fakeWs = { conversationId: null };
    conversationStore.append(fakeWs, 'assistant', 'I made you a file.',
        { files: [{ path: made, name: 'made-by-a-skill.txt', bytes: 12 }] });

    const rows = conversationStore.messages(fakeWs.conversationId);
    const minted = rows[0].artifacts.files[0].id;
    assert.match(minted, /^[0-9a-f]{12}$/);
    assert.equal(conversationStore.artifactPath(minted).path, made);

    const fetched = await httpCall('GET', `/files/${minted}`, {
        headers: { authorization: `Bearer ${token()}` } });
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.toString(), 'skill output');
});

test('speak_replies is a per-socket switch with an honest ack', async () => {
    await ready();
    const phone = await authed();
    phone.send({ type: 'speak_replies', on: true });
    const ack = await phone.next(m => m.type === 'speak_replies_result');
    assert.equal(ack.on, true);
});

test.after(() => {
    for (const ws of clients) { try { ws.close(); } catch { /* closing */ } }
    try { fakeInference.close(); } catch { /* closing */ }
    try { server.close(); } catch { /* closing */ }
    setTimeout(() => process.exit(0), 250).unref();
});
