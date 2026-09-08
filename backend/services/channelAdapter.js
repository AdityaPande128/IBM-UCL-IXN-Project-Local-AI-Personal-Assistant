const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const configReader = require('../utils/configReader');
const activityBus = require('./activityBus');

const config = configReader.readConfig();
const SETTINGS = (config.channel && config.channel.telegram) || {};

// The bot token is a credential: it lives in its own untracked file (or the
// environment), never in config.json, which is committed.
const TOKEN_PATH = process.env.JARVIS_TELEGRAM_TOKEN_PATH
    || SETTINGS.token_path
    || path.join(__dirname, '..', 'data', 'telegram-token');
const BINDING_PATH = process.env.JARVIS_TELEGRAM_BINDING_PATH
    || SETTINGS.binding_path
    || path.join(__dirname, '..', 'data', 'telegram-chat.json');

const ENABLED = SETTINGS.enabled !== false;
const POLL_TIMEOUT_S = SETTINGS.poll_timeout_s ?? 25;
const RETRY_MS = SETTINGS.retry_ms ?? 5000;
const MAX_TEXT = 4000;

let transport = null;
let binding = null;
let bindingPath = BINDING_PATH;
let pairingCode = null;
let pairingAttempts = 0;
let offset = 0;
let running = false;
let generation = 0;
let unsubscribe = null;
let deps = {};

// A pairing code is a short secret guessed over the network, so it cannot be
// left open to unlimited attempts. After a handful of wrong guesses the code
// is thrown away and a fresh one minted — which voids everything an attacker
// has tried, and makes a sustained attack visible as repeated regenerations
// in the log. A legitimate owner types the code once and never trips this.
const MAX_PAIRING_ATTEMPTS = 5;

function setTransport(fn) {
    transport = fn;
}

function useBinding(target) {
    bindingPath = target || BINDING_PATH;
    binding = null;
}

// The daemon exits on purpose after a settings apply; an offset held only in
// memory would re-deliver — and re-execute — every command since the last
// poll round-trip. Confirmed offsets live next to the binding.
function offsetPath() {
    return bindingPath.replace(/\.json$/, '') + '-offset';
}

function loadOffset() {
    try {
        return Number(fs.readFileSync(offsetPath(), 'utf8').trim()) || 0;
    } catch {
        return 0;
    }
}

function persistOffset() {
    try {
        fs.writeFileSync(offsetPath(), String(offset) + '\n');
    } catch { }
}

function resetOffset() {
    offset = 0;
    persistOffset();
}

function token() {
    if (process.env.JARVIS_TELEGRAM_TOKEN) return process.env.JARVIS_TELEGRAM_TOKEN.trim();
    try {
        return fs.readFileSync(TOKEN_PATH, 'utf8').trim() || null;
    } catch {
        return null;
    }
}

function call(method, params = {}) {
    if (transport) return transport(method, params);

    const secret = token();
    if (!secret) return Promise.reject(new Error('no telegram token'));

    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(params);
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${secret}/${method}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            },
            timeout: (POLL_TIMEOUT_S + 10) * 1000
        }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (!parsed.ok) return reject(new Error(parsed.description || 'telegram error'));
                    resolve(parsed.result);
                } catch (err) {
                    reject(new Error(`telegram transport: ${err.message}`));
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('telegram timeout')); });
        req.write(payload);
        req.end();
    });
}

function downloadFile(filePath) {
    const secret = token();
    if (!secret) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
        https.get({
            hostname: 'api.telegram.org',
            path: `/file/bot${secret}/${filePath}`
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(res.statusCode === 200 ? Buffer.concat(chunks) : null));
        }).on('error', reject);
    });
}

// A spoken reply goes back as audio: the local TTS wav, converted with the
// system's own afconvert — no third-party encoder enters the machine for this.
async function sendVoiceNote(chatId, wavBuffer) {
    if (transport) return transport('sendAudio', { chat_id: chatId, bytes: wavBuffer.length });

    const secret = token();
    if (!secret) throw new Error('no telegram token');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-voice-'));
    const wav = path.join(dir, 'reply.wav');
    const m4a = path.join(dir, 'reply.m4a');
    try {
        fs.writeFileSync(wav, wavBuffer);
        execFileSync('afconvert', [wav, m4a, '-f', 'm4af', '-d', 'aac']);
        const audio = fs.readFileSync(m4a);

        const boundary = '----JarvisChannel' + Date.now();
        const body = Buffer.concat([
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`),
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; `
                + 'filename="reply.m4a"\r\nContent-Type: audio/mp4\r\n\r\n'),
            audio,
            Buffer.from(`\r\n--${boundary}--\r\n`)
        ]);

        await new Promise((resolve, reject) => {
            const req = https.request({
                hostname: 'api.telegram.org',
                path: `/bot${secret}/sendAudio`,
                method: 'POST',
                headers: {
                    'Content-Type': `multipart/form-data; boundary=${boundary}`,
                    'Content-Length': body.length
                }
            }, res => {
                res.resume();
                res.on('end', resolve);
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function readBinding() {
    if (binding !== null) return binding;
    try {
        binding = JSON.parse(fs.readFileSync(bindingPath, 'utf8'));
    } catch {
        binding = {};
    }
    return binding;
}

function writeBinding(next) {
    binding = next;
    fs.mkdirSync(path.dirname(bindingPath), { recursive: true });
    fs.writeFileSync(bindingPath, JSON.stringify(next));
}

function boundChat() {
    return readBinding().chat_id ?? null;
}

// Pairing: the daemon shows a code; the first Telegram chat to send that code
// becomes THE chat. Everything from any other chat id is ignored without
// reply — an unpaired stranger must not even learn the bot is alive.
function currentPairingCode() {
    if (boundChat()) return null;
    if (!pairingCode) {
        pairingCode = String(crypto.randomInt(100000, 1000000));
        pairingAttempts = 0;
        console.log(`[Channel] Telegram unpaired. Send ${pairingCode} to the bot to pair this device.`);
    }
    return pairingCode;
}

function unpair() {
    writeBinding({});
    pairingCode = null;
    pairingAttempts = 0;
}

async function sendDocument(chatId, filePath, name) {
    if (transport) {
        return transport('sendDocument',
            { chat_id: chatId, name, bytes: fs.statSync(filePath).size });
    }
    const secret = token();
    if (!secret) throw new Error('no telegram token');
    const data = fs.readFileSync(filePath);
    const safe = String(name || path.basename(filePath)).replace(/["\r\n]/g, '');
    const boundary = '----JarvisChannel' + Date.now();
    const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="document"; `
            + `filename="${safe}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
        data,
        Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    await new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${secret}/sendDocument`,
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': body.length
            }
        }, res => {
            res.resume();
            res.on('end', resolve);
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

async function say(chatId, text) {
    await call('sendMessage', { chat_id: chatId, text: String(text).slice(0, MAX_TEXT) });
}

let pendingApproval = null; // { id, until } — the question still on the table

const SAYS_YES = /^\s*(yes|yeah|yep|sure|ok(ay)?|go ahead|do it|please do|build it)\b/i;
const SAYS_NO = /^\s*(no|nope|don't|do not|stop|leave it|cancel|skip)\b/i;

async function offerApproval(chatId, proposal) {
    await call('sendMessage', {
        chat_id: chatId,
        text: proposal.kind === 'build_skill'
            ? `I don't have a skill for that — want me to build one? It takes a minute or two. Reply yes or no, or use the buttons.`
            : `${proposal.summary || proposal.request || proposal.kind || 'An action'} — approve? Reply yes or no, or use the buttons.`,
        reply_markup: {
            inline_keyboard: [[
                { text: 'Approve', callback_data: `apr:yes:${proposal.id}` },
                { text: 'Decline', callback_data: `apr:no:${proposal.id}` }
            ]]
        }
    });
}

async function transcribe(fileId) {
    if (typeof deps.transcribe !== 'function') return null;
    const file = await call('getFile', { file_id: fileId });
    return deps.transcribe(file.file_path);
}

const PRIVATE_PREFIX = /^\/private\b\s*/i;

async function handleMessage(message) {
    const chatId = message.chat && message.chat.id;
    if (chatId == null) return;

    const bound = boundChat();

    if (!bound) {
        const code = currentPairingCode();
        if (String(message.text || '').trim() === code) {
            writeBinding({ chat_id: chatId, paired_at: Date.now() });
            pairingCode = null;
            pairingAttempts = 0;
            await say(chatId, 'Paired. This chat now speaks for you — text or voice.');
            activityBus.publish('channel', 'paired', { chat: chatId });
            return;
        }
        // A wrong guess, still in silence. Enough of them retires the code.
        if (++pairingAttempts >= MAX_PAIRING_ATTEMPTS) {
            pairingCode = null;
            pairingAttempts = 0;
            console.warn('[Channel] Too many wrong pairing codes; the code has been '
                + 'regenerated. If you did not just mistype, someone is guessing it.');
            currentPairingCode();
        }
        return;
    }

    if (chatId !== bound) return;

    let text = String(message.text || '').trim();
    let spokenBack = false;

    if (!text && message.voice && message.voice.file_id) {
        text = String(await transcribe(message.voice.file_id).catch(() => '') || '').trim();
        spokenBack = true;
        if (!text) {
            await say(chatId, 'I could not make out that voice note.');
            return;
        }
    }
    if (!text) return;

    if (pendingApproval && Date.now() < pendingApproval.until
            && typeof deps.answer === 'function') {
        const yes = SAYS_YES.test(text);
        const no = SAYS_NO.test(text);
        if (yes || no) {
            const { id, kind } = pendingApproval;
            pendingApproval = null;
            if (yes && !no && kind === 'build_skill') {
                await say(chatId, 'Building the skill now — this takes a minute or two.');
            }
            const outcome = await deps.answer(id, yes && !no ? 'yes' : 'no')
                .catch(err => ({ response: `That failed: ${err.message}` }));
            const reply = outcome.response
                || (yes && !no ? 'Approved and done.' : 'Okay, leaving it.');
            await say(chatId, reply);
            if (spokenBack && typeof deps.speak === 'function') {
                await deps.speak(chatId, reply, call).catch(() => null);
            }
            return;
        }
        // Anything else is a new request; the buttons still answer the old one.
    }

    if (typeof deps.execute !== 'function') {
        await say(chatId, 'The assistant is not taking requests right now.');
        return;
    }

    const privateAsk = PRIVATE_PREFIX.test(text);
    if (privateAsk) {
        text = text.replace(PRIVATE_PREFIX, '').trim();
        if (!text) {
            await say(chatId, 'Write the message after /private and nothing from it will be remembered.');
            return;
        }
    }

    const result = await deps.execute(text, { private: privateAsk }).catch(err => ({
        status: 'error', response: `That failed: ${err.message}`
    }));

    if (result && result.status === 'needs_approval' && result.proposal) {
        await offerApproval(chatId, result.proposal);
        pendingApproval = { id: result.proposal.id,
            kind: result.proposal.kind || null, until: Date.now() + 5 * 60000 };
        return;
    }

    const reply = (privateAsk ? '(private) ' : '')
        + ((result && (result.response || result.error)) || 'Done.');
    await say(chatId, reply);

    const files = (result && result.artifacts
        && Array.isArray(result.artifacts.files)) ? result.artifacts.files : [];
    for (const file of files.slice(0, 3)) {
        if (!file || !file.path) continue;
        let allowed = false;
        try { allowed = require('../security/store').isWithinGrantedRoot(file.path, 'documents'); } catch { allowed = false; }
        if (!allowed) { console.warn(`[Channel] not sending ${file.name || file.path}: outside the granted folders`); continue; }
        await sendDocument(chatId, file.path, file.name)
            .catch(err => say(chatId,
                `I could not attach ${file.name || 'the file'}: ${err.message}`));
    }

    if (spokenBack && typeof deps.speak === 'function') {
        await deps.speak(chatId, reply, call).catch(() => null);
    }
}

async function handleCallback(callback) {
    const chatId = callback.message && callback.message.chat && callback.message.chat.id;
    if (chatId == null || chatId !== boundChat()) return;

    const match = String(callback.data || '').match(/^apr:(yes|no):(.+)$/);
    if (!match || typeof deps.answer !== 'function') return;

    const [, decision, id] = match;
    if (pendingApproval && pendingApproval.id === id) pendingApproval = null;
    const outcome = await deps.answer(id, decision).catch(err => ({
        response: `That failed: ${err.message}`
    }));

    await call('answerCallbackQuery', { callback_query_id: callback.id })
        .catch(() => null);
    await say(chatId, outcome.response
        || (decision === 'yes' ? 'Approved and done.' : 'Declined.'));
}

async function handleUpdate(update) {
    if (update.message) return handleMessage(update.message);
    if (update.callback_query) return handleCallback(update.callback_query);
}

async function poll(alive = () => true) {
    const updates = await call('getUpdates', {
        offset, timeout: POLL_TIMEOUT_S, allowed_updates: ['message', 'callback_query']
    });
    // A stop() or token change mid-poll orphans this call: its updates
    // belong to the next loop, not to a consumer that no longer exists.
    if (!alive()) return 0;
    // Advance and persist before executing: at-most-once for commands with
    // side effects — a restart mid-handling drops rather than repeats.
    for (const update of updates || []) {
        offset = Math.max(offset, update.update_id + 1);
    }
    if ((updates || []).length) persistOffset();
    for (const update of updates || []) {
        try {
            await handleUpdate(update);
        } catch (err) {
            console.warn(`[Channel] update failed: ${err.message}`);
        }
    }
    return (updates || []).length;
}

async function loop() {
    const gen = generation;
    const alive = () => running && gen === generation;
    while (alive()) {
        try {
            await poll(alive);
        } catch (err) {
            if (!alive()) break;
            console.warn(`[Channel] poll failed: ${err.message}`);
            await new Promise(resolve => {
                const timer = setTimeout(resolve, RETRY_MS);
                if (timer.unref) timer.unref();
            });
        }
    }
}

function wire(dependencies = {}) {
    deps = dependencies;
}

function start(dependencies = {}) {
    wire(dependencies);
    if (!ENABLED) return { status: 'disabled' };
    if (!transport && !token()) {
        console.log('[Channel] No Telegram token; the phone channel stays off. '
            + `Put a bot token in ${TOKEN_PATH} to enable it.`);
        return { status: 'no_token' };
    }
    if (running) return { status: 'running' };

    running = true;
    generation += 1;
    offset = Math.max(offset, loadOffset());
    currentPairingCode();
    loop();

    if (!unsubscribe) {
        unsubscribe = activityBus.subscribe(event => {
            if (event.source === 'brief' && event.event === 'ready' && boundChat()) {
                say(boundChat(), event.text).catch(() => null);
            }
        });
    }

    return { status: 'running', paired: Boolean(boundChat()) };
}

function stop() {
    running = false;
    generation += 1;
    if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
    }
    deps = {};
}

function status() {
    return {
        enabled: ENABLED,
        running,
        paired: Boolean(boundChat()),
        has_token: Boolean(transport || token())
    };
}

module.exports = {
    start, stop, status, poll, handleUpdate, unpair, wire, resetOffset,
    setTransport, useBinding, currentPairingCode, boundChat,
    downloadFile, sendVoiceNote,
    sendDocument,
    TOKEN_PATH
};
