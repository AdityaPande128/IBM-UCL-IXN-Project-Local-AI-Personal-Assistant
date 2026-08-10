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
const TOKEN_PATH = SETTINGS.token_path
    || path.join(__dirname, '..', 'data', 'telegram-token');
const BINDING_PATH = SETTINGS.binding_path
    || path.join(__dirname, '..', 'data', 'telegram-chat.json');

const ENABLED = SETTINGS.enabled !== false;
const POLL_TIMEOUT_S = SETTINGS.poll_timeout_s ?? 25;
const RETRY_MS = SETTINGS.retry_ms ?? 5000;
const MAX_TEXT = 4000;

let transport = null;
let binding = null;
let bindingPath = BINDING_PATH;
let pairingCode = null;
let offset = 0;
let running = false;
let deps = {};

function setTransport(fn) {
    transport = fn;
}

function useBinding(target) {
    bindingPath = target || BINDING_PATH;
    binding = null;
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
        console.log(`[Channel] Telegram unpaired. Send ${pairingCode} to the bot to pair this device.`);
    }
    return pairingCode;
}

function unpair() {
    writeBinding({});
    pairingCode = null;
}

async function say(chatId, text) {
    await call('sendMessage', { chat_id: chatId, text: String(text).slice(0, MAX_TEXT) });
}

async function offerApproval(chatId, proposal) {
    await call('sendMessage', {
        chat_id: chatId,
        text: `${proposal.summary || proposal.request || proposal.kind || 'An action'} — approve?`,
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

async function handleMessage(message) {
    const chatId = message.chat && message.chat.id;
    if (chatId == null) return;

    const bound = boundChat();

    if (!bound) {
        const code = currentPairingCode();
        if (String(message.text || '').trim() === code) {
            writeBinding({ chat_id: chatId, paired_at: Date.now() });
            pairingCode = null;
            await say(chatId, 'Paired. This chat now speaks for you — text or voice.');
            activityBus.publish('channel', 'paired', { chat: chatId });
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

    if (typeof deps.execute !== 'function') {
        await say(chatId, 'The assistant is not taking requests right now.');
        return;
    }

    const result = await deps.execute(text).catch(err => ({
        status: 'error', response: `That failed: ${err.message}`
    }));

    if (result && result.status === 'needs_approval' && result.proposal) {
        await offerApproval(chatId, result.proposal);
        return;
    }

    const reply = (result && (result.response || result.error)) || 'Done.';
    await say(chatId, reply);

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

async function poll() {
    const updates = await call('getUpdates', {
        offset, timeout: POLL_TIMEOUT_S, allowed_updates: ['message', 'callback_query']
    });
    for (const update of updates || []) {
        offset = Math.max(offset, update.update_id + 1);
        try {
            await handleUpdate(update);
        } catch (err) {
            console.warn(`[Channel] update failed: ${err.message}`);
        }
    }
    return (updates || []).length;
}

async function loop() {
    while (running) {
        try {
            await poll();
        } catch (err) {
            if (!running) break;
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
    currentPairingCode();
    loop();

    activityBus.subscribe(event => {
        if (event.source === 'brief' && event.event === 'ready' && boundChat()) {
            say(boundChat(), event.text).catch(() => null);
        }
    });

    return { status: 'running', paired: Boolean(boundChat()) };
}

function stop() {
    running = false;
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
    start, stop, status, poll, handleUpdate, unpair, wire,
    setTransport, useBinding, currentPairingCode, boundChat,
    downloadFile, sendVoiceNote,
    TOKEN_PATH
};
