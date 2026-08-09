const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const test = require('node:test');
const assert = require('node:assert');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-wire-'));
process.env.PORT = '18099';
process.env.JARVIS_SOCKET_TOKEN_PATH = path.join(scratch, 'socket-token');
process.env.INFERENCE_URL = 'http://127.0.0.1:18098';
process.env.JARVIS_LOGS_DIR = path.join(scratch, 'logs');
process.env.JARVIS_DIAGNOSTICS_DIR = path.join(scratch, 'diagnostics');
fs.mkdirSync(process.env.JARVIS_LOGS_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.JARVIS_LOGS_DIR, 'backend.log'), 'boot ok\n');

const traceStore = require('../services/traceStore');
traceStore.open(path.join(scratch, 'traces.db'));

const WebSocket = require('ws');
const activityBus = require('../services/activityBus');
const intentQueue = require('../services/intentQueue');
const openclawBridge = require('../services/openclawBridge');

const fakeInference = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
        if (req.url === '/stt') {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ text: fakeInference.transcript }));
        } else if (req.url === '/tts') {
            res.setHeader('Content-Type', 'audio/wav');
            res.end(Buffer.from('RIFF-not-really-audio'));
        } else {
            res.statusCode = 404;
            res.end();
        }
    });
});
fakeInference.transcript = '';

const { server } = require('../server');

const clients = [];

function ready() {
    return Promise.all([
        new Promise(resolve => (server.listening ? resolve() : server.once('listening', resolve))),
        new Promise(resolve => fakeInference.listen(18098, '127.0.0.1', resolve))
    ]);
}

function token() {
    return fs.readFileSync(process.env.JARVIS_SOCKET_TOKEN_PATH, 'utf8').trim();
}

function connect() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket('ws://127.0.0.1:18099');
        clients.push(ws);
        const received = [];
        const waiters = [];
        let binaryFrames = 0;

        function check() {
            for (let i = waiters.length - 1; i >= 0; i--) {
                const waiter = waiters[i];
                if (waiter.binary) {
                    if (binaryFrames > 0) { waiters.splice(i, 1); waiter.resolve(binaryFrames); }
                    continue;
                }
                const found = received.find(m => !m.__used && waiter.match(m));
                if (found) {
                    found.__used = true;
                    waiters.splice(i, 1);
                    waiter.resolve(found);
                }
            }
        }

        ws.on('message', (raw, isBinary) => {
            if (isBinary) { binaryFrames++; check(); return; }
            received.push(JSON.parse(raw.toString()));
            check();
        });

        const api = {
            ws,
            received,
            send: obj => ws.send(JSON.stringify(obj)),
            sendBinary: buf => ws.send(buf, { binary: true }),
            next(match, timeoutMs = 8000) {
                return new Promise((resolveNext, rejectNext) => {
                    waiters.push({ match, resolve: resolveNext });
                    check();
                    setTimeout(() => rejectNext(new Error('timed out waiting for a message')),
                        timeoutMs).unref();
                });
            },
            binaryFrame(timeoutMs = 8000) {
                return new Promise((resolveNext, rejectNext) => {
                    waiters.push({ binary: true, resolve: resolveNext });
                    check();
                    setTimeout(() => rejectNext(new Error('timed out waiting for audio')),
                        timeoutMs).unref();
                });
            },
            closed: () => new Promise(resolve => ws.once('close', code => resolve(code)))
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

test.before(async () => {
    await ready();
});

test.after(() => {
    for (const ws of clients) {
        try { ws.terminate(); } catch { }
    }
    server.close();
    fakeInference.close();
});

test('an unauthenticated message closes the socket before anything flows', async () => {
    const client = await connect();
    client.send({ type: 'status' });
    assert.strictEqual(await client.closed(), 4401);
    assert.strictEqual(client.received.length, 0);
});

test('a wrong token is refused the same way', async () => {
    const client = await connect();
    client.send({ type: 'auth', token: 'f'.repeat(64) });
    assert.strictEqual(await client.closed(), 4401);
    assert.strictEqual(client.received.length, 0);
});

test('the issued token opens the session and status answers', async () => {
    const client = await authed();
    client.send({ type: 'status' });
    const status = await client.next(m => m.type === 'status_result');
    assert.ok(status.clients >= 1);
    client.ws.close();
});

test('intents serialize over the wire, stream activity, and abort cleanly', async () => {
    intentQueue.reset();
    const gates = [];
    const realExecute = openclawBridge.executeIntent;
    openclawBridge.executeIntent = (text, options) => new Promise(resolve => {
        activityBus.publish('router', 'decision', { route: 'fake' });
        options.signal.addEventListener('abort',
            () => resolve({ status: 'success', tainted: true }), { once: true });
        gates.push({ text, options, resolve });
    });

    try {
        const client = await authed();

        client.send({ type: 'abort' });
        const idle = await client.next(m => m.type === 'abort_result');
        assert.strictEqual(idle.state, 'not_found');

        client.send({ type: 'intent', text: 'first request' });
        client.send({ type: 'intent', text: 'second request' });
        const first = await client.next(m => m.type === 'intent_accepted' && m.position === 1);
        const second = await client.next(m => m.type === 'intent_accepted' && m.position === 2);

        await client.next(m => m.type === 'activity' && m.source === 'router');
        assert.strictEqual(gates.length, 1, 'only the first intent may run');
        assert.strictEqual(gates[0].options.interactive, true);
        assert.ok(gates[0].options.signal instanceof AbortSignal);

        client.send({ type: 'abort', id: second.id });
        const aborted = await client.next(m => m.type === 'abort_result' && m.id === second.id);
        assert.strictEqual(aborted.state, 'aborted');
        const resultB = await client.next(m => m.type === 'intent_result' && m.id === second.id);
        assert.strictEqual(resultB.status, 'aborted');

        gates[0].resolve({ status: 'success', response: 'done', skill: null });
        const resultA = await client.next(m => m.type === 'intent_result' && m.id === first.id);
        assert.strictEqual(resultA.status, 'success');
        assert.strictEqual(gates.length, 1, 'the aborted intent must never start');

        client.send({ type: 'intent', text: 'third request' });
        await client.next(m => m.type === 'intent_accepted');
        await client.next(m => m.type === 'activity' && m.source === 'router');
        client.send({ type: 'abort' });
        const running = await client.next(m => m.type === 'abort_result');
        assert.strictEqual(running.state, 'aborting');
        const resultC = await client.next(m => m.type === 'intent_result' && m.status === 'aborted');
        assert.ok(gates[1].options.signal.aborted, 'the running job must see the abort signal');
        assert.ok(resultC);

        client.ws.close();
    } finally {
        openclawBridge.executeIntent = realExecute;
        intentQueue.reset();
    }
});

test('voice goes through the same consent gate and speaks its proposal', async () => {
    intentQueue.reset();
    fakeInference.transcript = 'turn my meeting notes into a pdf';
    let seen = null;
    const realExecute = openclawBridge.executeIntent;
    openclawBridge.executeIntent = (text, options) => {
        seen = { text, interactive: options.interactive };
        return Promise.resolve({
            status: 'needs_approval',
            action: 'proposed_skill_build',
            proposal: { id: 'p-wire', kind: 'build_skill', request: text },
            response: 'I do not have a skill for that. I can build one. Want me to?'
        });
    };

    try {
        const client = await authed();
        client.sendBinary(Buffer.from('pretend this is speech'));

        const stt = await client.next(m => m.type === 'stt_result');
        assert.strictEqual(stt.text, fakeInference.transcript);

        await client.next(m => m.type === 'intent_accepted');
        const result = await client.next(m => m.type === 'intent_result' && m.proposal);
        assert.strictEqual(result.status, 'needs_approval');
        assert.strictEqual(result.proposal.kind, 'build_skill');

        await client.next(m => m.type === 'pipeline_complete');
        assert.strictEqual(seen.interactive, true, 'voice must run interactive');
        assert.strictEqual(seen.text, fakeInference.transcript);
        assert.ok(await client.binaryFrame() >= 1, 'the offer must be spoken back');

        client.ws.close();
    } finally {
        openclawBridge.executeIntent = realExecute;
        intentQueue.reset();
    }
});

test('abilities are listed over the wire and builtins refuse removal', async () => {
    const client = await authed();
    client.send({ type: 'abilities' });
    const abilities = await client.next(m => m.type === 'abilities_result');

    assert.ok(abilities.skills.length > 0);
    const builtin = abilities.skills.find(s => s.author === 'builtin');
    assert.ok(builtin, 'the repo ships builtin skills');
    assert.ok(abilities.tiers.length >= 1);
    assert.strictEqual(typeof abilities.openclaw.connected, 'boolean');
    assert.match(abilities.openclaw.dashboard, /^http:\/\/127\.0\.0\.1:\d+$/);

    client.send({ type: 'skill_remove', name: builtin.name });
    const refused = await client.next(m => m.type === 'skill_remove_result');
    assert.strictEqual(refused.status, 'refused');

    client.send({ type: 'skill_remove', name: 'no-such-skill' });
    const unknown = await client.next(m =>
        m.type === 'skill_remove_result' && m.status === 'unknown_skill');
    assert.ok(unknown);
    client.ws.close();
});

test('a generated skill can be removed and vanishes from the registry', async () => {
    const skillRegistry = require('../services/skillRegistry');
    const dir = path.join(__dirname, '..', 'skills', 'wire-probe-skill');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), [
        '---',
        'name: wire-probe-skill',
        'version: 1.0.0',
        'description: Probe skill installed by the wire tests.',
        'exec:',
        '  type: command',
        '  argv: ["/usr/bin/true"]',
        'reply: "Done."',
        'capabilities:',
        '  exec: true',
        '  filesystem: []',
        '  network: false',
        'provenance:',
        '  author: generated',
        '---',
        'Probe.'
    ].join('\n'));
    skillRegistry.reload();

    try {
        const client = await authed();
        client.send({ type: 'abilities' });
        const before = await client.next(m => m.type === 'abilities_result');
        assert.ok(before.skills.some(s => s.name === 'wire-probe-skill'));

        client.send({ type: 'skill_remove', name: 'wire-probe-skill' });
        const removed = await client.next(m => m.type === 'skill_remove_result');
        assert.strictEqual(removed.status, 'removed');
        assert.strictEqual(fs.existsSync(dir), false, 'the skill directory must be deleted');

        client.send({ type: 'abilities' });
        const after = await client.next(m => m.type === 'abilities_result');
        assert.strictEqual(after.skills.some(s => s.name === 'wire-probe-skill'), false);
        client.ws.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        skillRegistry.reload();
    }
});

test('a diagnostics bundle collects logs, config and recent runs — never the token', async () => {
    const { execFileSync } = require('child_process');
    const client = await authed();
    client.send({ type: 'diagnostics' });
    const result = await client.next(m => m.type === 'diagnostics_result');
    assert.strictEqual(result.status, 'saved');
    assert.ok(fs.existsSync(result.path));
    assert.ok(result.path.startsWith(process.env.JARVIS_DIAGNOSTICS_DIR));

    const listing = execFileSync('unzip', ['-l', result.path]).toString();
    assert.match(listing, /system\.txt/);
    assert.match(listing, /config\.json/);
    assert.match(listing, /recent-plans\.json/);
    assert.match(listing, /logs\/backend\.log/);
    assert.strictEqual(listing.includes('socket-token'), false);
    client.ws.close();
});
