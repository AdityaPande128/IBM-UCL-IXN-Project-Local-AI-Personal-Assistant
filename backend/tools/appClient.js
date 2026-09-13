// A client for the running daemon's own socket: the same door the Mac
// window, the phones and Telegram come through. Nothing here loads a
// service in-process; every request is the app's to handle, and every
// answer is what a surface would have shown.
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const configReader = require('../utils/configReader');

function tokenPath() {
    const configured = (configReader.readConfig().security || {}).socket_token_path;
    if (!configured) return path.join(os.homedir(), '.jarvis', 'socket-token');
    return configured.startsWith('~/') ? path.join(os.homedir(), configured.slice(2)) : configured;
}

// The token is read for the handshake and never logged or returned.
function readToken() {
    return fs.readFileSync(tokenPath(), 'utf8').trim();
}

class AppClient {
    constructor({ url = 'ws://127.0.0.1:8080', timeoutMs = 10 * 60 * 1000 } = {}) {
        this.url = url;
        this.timeoutMs = timeoutMs;
        this.ws = null;
        this.conversation = null;
        this.frames = [];
        this.waiters = [];
    }

    connect(timeoutMs = 20000) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(this.url);
            const fail = (err) => reject(new Error(`daemon socket: ${err && err.message || err}`));
            // A daemon that accepts the connection but never says hello is
            // wedged; waiting on it forever would wedge the harness too.
            const timer = setTimeout(() => { try { ws.close(); } catch {} fail(new Error(`no welcome within ${timeoutMs} ms`)); }, timeoutMs);
            ws.once('error', fail);
            ws.once('open', () => ws.send(JSON.stringify({ type: 'auth', token: readToken() })));
            ws.on('message', raw => {
                let frame; try { frame = JSON.parse(raw.toString()); } catch { return; }
                this.frames.push(frame);
                if (frame.type === 'connected') { clearTimeout(timer); this.ws = ws; resolve(this); }
                if (frame.type === 'conversation_started' && frame.id != null) this.conversation = frame.id;
                for (const waiter of [...this.waiters]) if (waiter(frame)) this.waiters.splice(this.waiters.indexOf(waiter), 1);
            });
            ws.once('close', (code) => { if (!this.ws) fail(new Error(`closed ${code} before welcome`)); });
        });
    }

    waitFor(match, timeoutMs = this.timeoutMs) {
        return new Promise((resolve) => {
            const timer = setTimeout(() => { this.waiters.splice(this.waiters.indexOf(waiter), 1); resolve(null); }, timeoutMs);
            const waiter = (frame) => { if (!match(frame)) return false; clearTimeout(timer); resolve(frame); return true; };
            this.waiters.push(waiter);
        });
    }

    // One request, the way a surface sends it: text plus optional inbox
    // attachment ids, in the socket's current conversation. Resolves with
    // the result frame, the acknowledgement delay and the total wall time;
    // a proposal card is answered when `approve` says so and the follow-on
    // result is returned in its place, with the card kept on `card`.
    async intent(text, { attachments = [], approve = false, timeoutMs = this.timeoutMs } = {}) {
        const t0 = Date.now();
        this.ws.send(JSON.stringify({ type: 'intent', text, attachments,
            ...(this.conversation != null ? { conversation: this.conversation } : {}) }));
        const accepted = await this.waitFor(f => f.type === 'intent_accepted', 30000);
        const ackMs = accepted ? Date.now() - t0 : null;
        if (!accepted) return { status: 'timeout', response: 'no acknowledgement', ackMs, ms: Date.now() - t0 };
        let result = await this.waitFor(f => f.type === 'intent_result' && f.id === accepted.id, timeoutMs);
        if (!result) return { status: 'timeout', response: 'no result within the window', ackMs, ms: Date.now() - t0 };
        if (approve && result.status === 'needs_approval' && result.proposal && result.proposal.id) {
            const card = result;
            this.ws.send(JSON.stringify({ type: 'approval', id: result.proposal.id, decision: 'yes' }));
            const again = await this.waitFor(f => f.type === 'intent_accepted', 30000);
            result = again ? await this.waitFor(f => f.type === 'intent_result' && f.id === again.id, timeoutMs) : null;
            if (!result) return { status: 'timeout', response: 'no result after approval', card, ackMs, ms: Date.now() - t0 };
            result.card = card;
        }
        return { ...result, ackMs, ms: Date.now() - t0 };
    }

    async abilities() {
        this.ws.send(JSON.stringify({ type: 'abilities' }));
        return this.waitFor(f => f.type === 'abilities_result', 10000);
    }

    close() { try { this.ws && this.ws.close(); } catch {} }
}

module.exports = { AppClient, tokenPath };
