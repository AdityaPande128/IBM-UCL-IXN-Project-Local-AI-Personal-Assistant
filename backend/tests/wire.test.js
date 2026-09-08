const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const test = require('node:test');
process.env.JARVIS_MEMORY_GB = '24';
const assert = require('node:assert');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-wire-'));
process.env.JARVIS_DIRECT = 'off';
process.env.PORT = '18099';
process.env.JARVIS_SOCKET_TOKEN_PATH = path.join(scratch, 'socket-token');
process.env.JARVIS_CONVERSATIONS_DB = path.join(scratch, 'conversations.db');
process.env.INFERENCE_URL = 'http://127.0.0.1:18098';
process.env.JARVIS_LOGS_DIR = path.join(scratch, 'logs');
process.env.JARVIS_DIAGNOSTICS_DIR = path.join(scratch, 'diagnostics');
fs.mkdirSync(process.env.JARVIS_LOGS_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.JARVIS_LOGS_DIR, 'backend.log'), 'boot ok\n');
process.env.JARVIS_CONFIG_PATH = path.join(scratch, 'config.json');
fs.copyFileSync(path.resolve(__dirname, '../../config.json'), process.env.JARVIS_CONFIG_PATH);
{
    // The fixture must not inherit this machine's live choices: the mail
    // provider test asserts the default, and the budget test assumes the
    // hardware-default tiers, not whatever engine is currently selected.
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

const traceStore = require('../services/traceStore');
traceStore.open(path.join(scratch, 'traces.db'));

const watchers = require('../services/watchers');
watchers.open(path.join(scratch, 'watchers.db'));


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
        const speech = Buffer.alloc(44 + 16000, 0);
        for (let i = 44; i < speech.length - 1; i += 2) {
            speech.writeInt16LE((i % 4 === 0) ? 2000 : -2000, i);
        }
        client.sendBinary(speech);

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
    assert.match(listing, /failures\.json/);
    assert.match(listing, /logs\/backend\.log/);
    assert.strictEqual(listing.includes('socket-token'), false);
    client.ws.close();
});

test('the permissions surface answers over the wire', async () => {
    const client = await authed();

    client.send({ type: 'permissions' });
    const permissions = await client.next(m => m.type === 'permissions_result');
    assert.ok(Array.isArray(permissions.skills));
    assert.ok(permissions.web && Array.isArray(permissions.web.blocked_hosts));

    client.send({ type: 'checkpoint', action: 'list' });
    const listed = await client.next(m => m.type === 'checkpoint_result');
    assert.ok(Array.isArray(listed.checkpoints));
    client.ws.close();
});

test('settings ride the abilities payload and edits land in config.json', async () => {
    const client = await authed();
    client.send({ type: 'abilities' });
    const abilities = await client.next(m => m.type === 'abilities_result');
    assert.ok(abilities.browser.installed.includes(abilities.browser.current));
    assert.ok(abilities.budget.measured_gb);

    client.send({
        type: 'settings_update',
        tiers: { engine: { policy: 'resident' } },
        desktop_browser: abilities.browser.current
    });
    const applied = await client.next(m => m.type === 'settings_update_result');
    assert.strictEqual(applied.status, 'applied');

    const written = JSON.parse(fs.readFileSync(process.env.JARVIS_CONFIG_PATH, 'utf8'));
    assert.strictEqual(written.models.tiers.engine.policy, 'resident');
    assert.strictEqual(written.web.desktop_browser, abilities.browser.current);
    client.ws.close();
});

test('a settings update that breaks the memory budget is refused', async () => {
    // Pinning the 14B smith next to the resident engine outgrows the
    // budget; the guard tier itself can no longer be edited directly.
    const client = await authed();
    client.send({
        type: 'settings_update',
        tiers: { smith: { model: 'mlx-community/Qwen2.5-Coder-14B-Instruct-4bit',
                          policy: 'pinned' } }
    });
    const refused = await client.next(m => m.type === 'settings_update_result');
    assert.strictEqual(refused.status, 'invalid');
    assert.match(refused.error, /GB/);

    const written = JSON.parse(fs.readFileSync(process.env.JARVIS_CONFIG_PATH, 'utf8'));
    assert.notStrictEqual((written.models.tiers || {}).smith?.policy, 'pinned');
    client.ws.close();
});

test('a browser that is not installed is refused', async () => {
    const client = await authed();
    client.send({ type: 'settings_update', desktop_browser: 'Netscape Navigator' });
    const refused = await client.next(m => m.type === 'settings_update_result');
    assert.strictEqual(refused.status, 'invalid');
    assert.match(refused.error, /not installed/);
    client.ws.close();
});

test('the mail provider is editable and unknown providers are refused', async () => {
    const client = await authed();
    client.send({ type: 'abilities' });
    const abilities = await client.next(m => m.type === 'abilities_result');
    assert.strictEqual(abilities.mail.current, 'gmail');
    assert.ok(abilities.mail.available.some(p => p.name === 'outlook'));

    client.send({ type: 'settings_update', mail_provider: 'hotmail' });
    const refused = await client.next(m => m.type === 'settings_update_result');
    assert.strictEqual(refused.status, 'invalid');
    assert.match(refused.error, /not a supported mail provider/);

    client.send({ type: 'settings_update', mail_provider: 'outlook' });
    const applied = await client.next(m => m.type === 'settings_update_result');
    assert.strictEqual(applied.status, 'applied');
    const written = JSON.parse(fs.readFileSync(process.env.JARVIS_CONFIG_PATH, 'utf8'));
    assert.strictEqual(written.mail.provider, 'outlook');
    client.ws.close();
});

test('another agent can borrow the browser lane over the wire', async () => {
    intentQueue.reset();
    const webAgent = require('../services/webAgent');
    const realBrowse = webAgent.browse;
    webAgent.browse = async (goal, options) => ({
        status: 'success', answer: `went after: ${goal}`,
        url: options.url || 'https://example.org', passages: []
    });
    try {
        const client = await authed();
        client.send({ type: 'browse', goal: 'find the opening hours', url: 'https://www.bl.uk' });
        const accepted = await client.next(m => m.type === 'browse_accepted');
        assert.ok(accepted.id);
        const result = await client.next(m => m.type === 'browse_result');
        assert.strictEqual(result.status, 'success');
        assert.match(result.answer, /opening hours/);
        assert.strictEqual(result.url, 'https://www.bl.uk');
        client.ws.close();
    } finally {
        webAgent.browse = realBrowse;
    }
});

test('a browse that stops carries its reason back over the wire', async () => {
    intentQueue.reset();
    const webAgent = require('../services/webAgent');
    const realBrowse = webAgent.browse;
    webAgent.browse = async () => ({
        status: 'refused', reason: 'stopped at a password field'
    });
    try {
        const client = await authed();
        client.send({ type: 'browse', goal: 'log into my bank' });
        const result = await client.next(m => m.type === 'browse_result');
        assert.strictEqual(result.status, 'refused');
        assert.match(result.reason, /password field/);
        assert.strictEqual(result.answer, null);
        client.ws.close();
    } finally {
        webAgent.browse = realBrowse;
    }
});

test('the jarvis-browse installer stamps this checkout\'s runner path', () => {
    const { execFileSync } = require('child_process');
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-skills-'));
    try {
        execFileSync('node', [path.join(__dirname, '..', 'eval', 'openclaw', 'install.js'), target]);
        const written = fs.readFileSync(path.join(target, 'jarvis-browse', 'SKILL.md'), 'utf8');
        assert.ok(written.includes(path.join('eval', 'openclaw', 'jarvis-browse', 'run.js')));
        assert.strictEqual(written.includes('%RUNNER%'), false);
    } finally {
        fs.rmSync(target, { recursive: true, force: true });
    }
});

test('artifacts ride the intent result to the client', async () => {
    intentQueue.reset();
    const realExecute = openclawBridge.executeIntent;
    openclawBridge.executeIntent = async () => ({
        status: 'success', response: 'On your Desktop.', action: 'skill',
        artifacts: { files: [{ path: '/tmp/x.png', name: 'x.png', bytes: 5 }] }
    });
    try {
        const client = await authed();
        client.send({ type: 'intent', text: 'take a screenshot' });
        const result = await client.next(m => m.type === 'intent_result');
        assert.strictEqual(result.status, 'success');
        assert.strictEqual(result.artifacts.files[0].name, 'x.png');
        client.ws.close();
    } finally {
        openclawBridge.executeIntent = realExecute;
    }
});

test('watchers answer over the wire and refuse an unknown recipe', async () => {
    const client = await authed();

    client.send({ type: 'watchers' });
    const listed = await client.next(m => m.type === 'watchers_result');
    assert.ok(Array.isArray(listed.watchers));
    assert.ok(Array.isArray(listed.notices));

    client.send({ type: 'watcher_add', target: 'no-such-recipe' });
    const refused = await client.next(m => m.type === 'watcher_add_result');
    assert.strictEqual(refused.status, 'refused');
    assert.match(refused.response, /no such recipe/);

    client.send({ type: 'watcher_remove', id: 'not-there' });
    const removed = await client.next(m => m.type === 'watcher_remove_result');
    assert.strictEqual(removed.status, 'unknown_watcher');

    client.ws.close();
});

test('a private chat answers over the wire and leaves no conversation behind', async () => {
    intentQueue.reset();
    const realExecute = openclawBridge.executeIntent;
    let seenPrivate = null;
    openclawBridge.executeIntent = async (text, options) => {
        seenPrivate = options.private === true;
        return { status: 'success', response: `heard: ${text}` };
    };
    try {
        const client = await authed();
        client.send({ type: 'conversations_list' });
        const before = await client.next(m => m.type === 'conversations_result');

        client.send({ type: 'private_chat', on: true });
        const opened = await client.next(m => m.type === 'private_chat_result');
        assert.strictEqual(opened.on, true);

        client.send({ type: 'intent', text: 'something I would rather forget' });
        const result = await client.next(m => m.type === 'intent_result');
        assert.strictEqual(result.private, true);
        assert.strictEqual(result.conversation, null);
        assert.strictEqual(seenPrivate, true, 'the intent ran inside the private scope');

        client.send({ type: 'conversations_list' });
        const after = await client.next(m => m.type === 'conversations_result');
        assert.strictEqual(after.conversations.length, before.conversations.length, 'no chat row was created');

        client.send({ type: 'private_chat', on: false });
        await client.next(m => m.type === 'private_chat_result');
        client.ws.close();
    } finally {
        openclawBridge.executeIntent = realExecute;
    }
});

test('wake mode gates binary audio: idle speech vanishes, the phrase wakes', async () => {
    intentQueue.reset();
    const realExecute = openclawBridge.executeIntent;
    const asked = [];
    openclawBridge.executeIntent = async text => {
        asked.push(text);
        return { status: 'success', response: 'It is three.' };
    };

    try {
        const client = await authed();
        client.send({ type: 'wake_mode', on: true });
        const armed = await client.next(m => m.type === 'wake_mode_result');
        assert.strictEqual(armed.on, true);

        fakeInference.transcript = 'talking to someone else entirely about lunch';
        client.sendBinary(Buffer.alloc(8).buffer);
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.ok(!client.received.some(m => m.type === 'wake' || m.type === 'stt_result'),
            'idle speech must produce no message of any kind');
        assert.strictEqual(asked.length, 0);

        fakeInference.transcript = 'hey jarvis what time is it';
        client.sendBinary(Buffer.alloc(8).buffer);
        const woke = await client.next(m => m.type === 'wake');
        assert.strictEqual(woke.command, 'what time is it');
        await client.next(m => m.type === 'intent_result');
        assert.deepStrictEqual(asked, ['what time is it']);

        client.send({ type: 'wake_mode', on: false });
        await client.next(m => m.type === 'wake_mode_result' && m.on === false);
        client.ws.close();
    } finally {
        openclawBridge.executeIntent = realExecute;
    }
});

test('onboarding round-trip: profile, tiers, queue and completion', async () => {
    const client = await authed();
    client.send({ type: 'onboarding' });
    const state = await client.next(m => m.type === 'onboarding_result');
    assert.strictEqual(state.profile.onboarded, false);
    assert.ok(state.catalog.engines.length >= 2, 'the catalog offers engines');
    assert.ok(state.catalog.smiths.length >= 2, 'the catalog offers improvers');

    // The recommended pair is what the wizard pre-selects; by construction it
    // fits whatever machine the test runs on.
    const engine = state.catalog.engines.find(e => e.recommended)
        ?? state.catalog.engines[0];
    const smith = state.catalog.smiths.find(e => e.recommended)
        ?? state.catalog.smiths[0];

    client.send({
        type: 'onboarding_apply',
        name: 'Wire Tester', theme: 'light', mode: 'jarvis',
        improvement: true, engine: engine.model, smith: smith.model,
        voice: { enabled: true, tts: true }
    });
    const applied = await client.next(m => m.type === 'onboarding_apply_result');
    assert.strictEqual(applied.status, 'applied', applied.error);

    const written = JSON.parse(fs.readFileSync(process.env.JARVIS_CONFIG_PATH, 'utf8'));
    assert.strictEqual(written.profile.name, 'Wire Tester');
    assert.strictEqual(written.profile.theme, 'light');
    assert.strictEqual(written.models.tiers.engine.model, engine.model);
    assert.deepStrictEqual(written.models.tiers.guard, written.models.tiers.engine,
        'the guard rides the chosen engine');

    // The queue was persisted for the next boot, base model ahead of the
    // improver.
    const queue = JSON.parse(
        fs.readFileSync(process.env.JARVIS_DOWNLOADS_PATH, 'utf8')).queue;
    const kinds = queue.map(entry => entry.kind);
    assert.ok(kinds.includes('engine'));
    if (kinds.includes('smith')) {
        assert.ok(kinds.indexOf('engine') < kinds.indexOf('smith'));
    }

    client.send({ type: 'download', action: 'status' });
    const status = await client.next(m => m.type === 'download_status');
    assert.ok(Array.isArray(status.queue) && status.queue.length >= 1);

    // A chat recorded before anyone finished onboarding is nobody's history:
    // the first completion starts the profile clean.
    const conversationStore = require('../services/conversationStore');
    conversationStore.append({}, 'user', 'a pre-profile stray');
    assert.ok(conversationStore.list().length >= 1);

    client.send({ type: 'onboarding_complete', fresh: true });
    const done = await client.next(m => m.type === 'onboarding_complete_result');
    assert.strictEqual(done.status, 'applied');
    assert.strictEqual(done.profile.onboarded, true);
    assert.strictEqual(conversationStore.list().length, 0,
        'the first completion cleared pre-profile chats');
    client.ws.close();
});

test('a rejected onboarding selection reports why and writes nothing', async () => {
    const before = fs.readFileSync(process.env.JARVIS_CONFIG_PATH, 'utf8');
    const client = await authed();
    client.send({
        type: 'onboarding_apply',
        name: 'X', theme: 'dark', mode: 'jarvis',
        improvement: false, engine: 'mlx-community/NotInTheCatalog-70B',
        voice: { enabled: false, tts: false }
    });
    const refused = await client.next(m => m.type === 'onboarding_apply_result');
    assert.strictEqual(refused.status, 'invalid');
    assert.match(refused.error, /not one of the offered/);
    assert.strictEqual(fs.readFileSync(process.env.JARVIS_CONFIG_PATH, 'utf8'), before,
        'a refused apply must not touch the config');
    client.ws.close();
});

test('an egress approval is answered over the wire and unblocks one retry', async () => {
    const client = await authed();
    try {
        const egress = require('../security/egress');
        const labels = require('../security/labels');
        const flow = {
            channel: egress.CHANNEL.MESSAGE, action: 'mail.send',
            destination: 'wire-test@example.com',
            inputs: [labels.label(labels.ORIGIN.FILE, labels.SENSITIVITY.PERSONAL)],
            summary: 'send the summary'
        };
        const blocked = egress.guard(flow);
        assert.strictEqual(blocked.allowed, false);
        assert.ok(blocked.approvalId);

        client.send({ type: 'egress_resolve', id: blocked.approvalId, decision: 'yes' });
        const answered = await client.next(m => m.type === 'egress_resolve_result');
        assert.strictEqual(answered.allowed, true);

        const retry = egress.guard(flow);
        assert.strictEqual(retry.allowed, true, 'the grant lets the retry through');
    } finally {
        client.ws.close();
    }
});

test('the phone channel is configured over the wire and refuses a junk token', async () => {
    const client = await authed();
    try {
        client.send({ type: 'channel_status' });
        const before = await client.next(m => m.type === 'channel_status_result');
        assert.strictEqual(typeof before.has_token, 'boolean');
        assert.strictEqual(typeof before.running, 'boolean');

        client.send({ type: 'channel_set_token', token: 'not-a-token' });
        const refused = await client.next(m => m.type === 'channel_status_result' && m.error);
        assert.match(refused.error, /BotFather/);
        assert.strictEqual(refused.has_token, before.has_token,
            'a refused token changes nothing');
    } finally {
        client.ws.close();
    }
});
