const http = require('http');
const https = require('https');
const WebSocket = require('ws');

const directCrypto = require('./directCrypto');
const frames = require('./channelFrames');

// Jarvis Direct, the Mac's half: listen on an unguessable rendezvous topic
// for a sealed WebRTC offer, answer it, and let the phone punch straight
// through both NATs. Once the channel opens it is bridged 1:1 onto the
// local websocket, so every protocol above this line is unchanged. The
// rendezvous relay carries only ciphertext; STUN learns only addresses.

const NTFY = process.env.JARVIS_NTFY_BASE || 'https://ntfy.sh';
const STUN = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'];
const SELF = 'mac';

let state = null;

function log(line) {
    console.log(`[Direct] ${line}`);
}

function publish(payload) {
    if (!state) return;
    const body = directCrypto.seal(state.key, SELF, payload);
    const req = https.request(`${NTFY}/${state.topic}`, { method: 'POST' },
        res => res.resume());
    req.on('error', err => log(`publish failed: ${err.message}`));
    req.end(body);
}

// A long-lived JSON stream of everything published to the topic; ntfy sends
// keepalives, we send reconnects. Quiet resilience over cleverness.
function subscribe() {
    if (!state) return;
    const req = https.get(`${NTFY}/${state.topic}/json`, res => {
        if (res.statusCode !== 200) {
            res.resume();
            return retrySubscribe(`stream refused (${res.statusCode})`);
        }
        log('signaling armed');
        let carry = '';
        res.on('data', piece => {
            carry += piece.toString('utf8');
            const lines = carry.split('\n');
            carry = lines.pop();
            for (const line of lines) {
                if (!line.trim()) continue;
                let event;
                try { event = JSON.parse(line); } catch { continue; }
                if (event.event === 'message' && event.message) handleSignal(event.message);
            }
        });
        res.on('end', () => retrySubscribe('stream ended'));
        res.on('error', err => retrySubscribe(err.message));
    });
    req.on('error', err => retrySubscribe(err.message));
    state.stream = req;
}

function retrySubscribe(reason) {
    if (!state) return;
    log(`signaling dropped (${reason}); back in 5s`);
    clearTimeout(state.retry);
    state.retry = setTimeout(subscribe, 5000);
    state.retry.unref();
}

function handleSignal(raw) {
    const opened = directCrypto.open(state.key, SELF, raw, state.seen);
    if (!opened.payload) return;
    const signal = opened.payload;
    if (signal.kind === 'offer' && typeof signal.sdp === 'string') {
        answerOffer(signal);
    } else if (signal.kind === 'candidate' && state.pc && typeof signal.candidate === 'string') {
        try { state.pc.addRemoteCandidate(signal.candidate, signal.mid || '0'); }
        catch (err) { log(`candidate refused: ${err.message}`); }
    }
}

function teardown(reason) {
    if (!state) return;
    if (state.session) {
        log(`session closed (${reason})`);
        try { state.session.ws.close(); } catch { /* closing */ }
        try { state.session.dc.close(); } catch { /* closing */ }
        state.session = null;
    }
    if (state.pc) {
        try { state.pc.close(); } catch { /* closing */ }
        state.pc = null;
    }
}

function answerOffer(signal) {
    let nodeDataChannel;
    try { nodeDataChannel = require('node-datachannel'); }
    catch (err) { return log(`node-datachannel unavailable: ${err.message}`); }

    // One phone, one session: a fresh offer is the phone reconnecting, and
    // the stale session must not linger holding the old channel.
    teardown('replaced by a new offer');
    log('offer received; answering');

    const pc = new nodeDataChannel.PeerConnection('jarvis-mac', { iceServers: STUN });
    state.pc = pc;
    pc.onLocalDescription((sdp, type) => publish({ kind: type, sdp }));
    pc.onLocalCandidate((candidate, mid) => publish({ kind: 'candidate', candidate, mid }));
    pc.onDataChannel(dc => bridge(dc));
    pc.onStateChange(pcState => {
        // A replaced connection announces its own death after the next one
        // is already alive; only the current session may tear itself down.
        if ((pcState === 'failed' || pcState === 'closed')
            && state && state.pc === pc) {
            teardown(`peer ${pcState}`);
        }
    });
    try {
        pc.setRemoteDescription(signal.sdp, 'offer');
    } catch (err) {
        log(`offer rejected: ${err.message}`);
        teardown('bad offer');
    }
}

// The channel is a wire; the daemon stays the authority. Every session is
// piped onto a fresh local websocket and authenticates like any client —
// the pairing secret opened the tunnel, the socket token still opens Jarvis.
function bridge(dc) {
    log('channel open; bridging to the local socket');
    const ws = new WebSocket(`ws://127.0.0.1:${state.port}`);
    const assemble = frames.assembler();
    const queued = [];
    const session = { dc, ws, sid: 1 };
    state.session = session;

    ws.on('open', () => {
        for (const item of queued.splice(0)) forward(item.text, item.data);
    });
    function forward(text, data) {
        if (ws.readyState !== WebSocket.OPEN) { queued.push({ text, data }); return; }
        if (text !== null) ws.send(text);
        else ws.send(data, { binary: true });
    }

    dc.onMessage(message => {
        if (typeof message === 'string') return forward(message, null);
        const whole = assemble(Buffer.from(message));
        if (!whole) return;
        if (whole.tag === frames.TAG.WS_BINARY) return forward(null, whole.body);
        if (whole.tag === frames.TAG.FILE_REQ) return fileRequest(session, whole);
    });
    dc.onClosed(() => {
        if (state && state.session === session) teardown('channel closed');
    });

    ws.on('message', (data, isBinary) => {
        try {
            if (!isBinary) return dc.sendMessage(data.toString());
            for (const frame of frames.chunk(frames.TAG.WS_BINARY,
                { sid: session.sid++ }, Buffer.from(data))) {
                dc.sendMessageBinary(frame);
            }
        } catch (err) {
            log(`bridge send failed: ${err.message}`);
        }
    });
    ws.on('close', () => {
        if (state && state.session === session) teardown('local socket closed');
    });
    ws.on('error', err => log(`local socket error: ${err.message}`));
}

// File-lane ops arrive framed over the channel and are replayed against the
// local HTTP routes with the daemon's own token — the same code path, the
// same caps, the same refusals as a LAN client.
function fileRequest(session, whole) {
    const { meta, body } = whole;
    const sid = session.sid++;
    const respond = (status, header, payload) => {
        try {
            for (const frame of frames.chunk(frames.TAG.FILE_RES,
                { sid, reqId: meta.reqId, status, ...header }, payload)) {
                session.dc.sendMessageBinary(frame);
            }
        } catch (err) { log(`file response failed: ${err.message}`); }
    };
    const options = { headers: { authorization: `Bearer ${state.token}` } };
    if (meta.op === 'put') {
        options.method = 'PUT';
        options.headers['x-filename'] = String(meta.name || 'upload');
        const req = http.request(`http://127.0.0.1:${state.port}/files`, options, res => {
            const pieces = [];
            res.on('data', piece => pieces.push(piece));
            res.on('end', () => respond(res.statusCode, {
                json: Buffer.concat(pieces).toString('utf8') }));
        });
        req.on('error', err => respond(502, { json: JSON.stringify({ error: err.message }) }));
        req.end(body);
        return;
    }
    if (meta.op === 'get' && /^[0-9a-f]{12,16}$/.test(String(meta.id || ''))) {
        const req = http.request(`http://127.0.0.1:${state.port}/files/${meta.id}`, options, res => {
            const pieces = [];
            res.on('data', piece => pieces.push(piece));
            res.on('end', () => respond(res.statusCode, {
                mime: res.headers['content-type'] || 'application/octet-stream',
                name: meta.id
            }, Buffer.concat(pieces)));
        });
        req.on('error', err => respond(502, { json: JSON.stringify({ error: err.message }) }));
        req.end();
        return;
    }
    respond(400, { json: JSON.stringify({ error: 'unknown file op' }) });
}

function start({ secret, port, token }) {
    if (state) return;
    state = {
        key: directCrypto.keyFor(secret),
        topic: directCrypto.topicFor(secret),
        port, token,
        seen: new Map(),
        pc: null, session: null, stream: null, retry: null
    };
    subscribe();
}

function stop() {
    if (!state) return;
    teardown('transport stopped');
    clearTimeout(state.retry);
    if (state.stream) try { state.stream.destroy(); } catch { /* closing */ }
    state = null;
}

module.exports = { start, stop };
