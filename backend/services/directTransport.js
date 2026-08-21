const http = require('http');
const https = require('https');
const WebSocket = require('ws');

const directCrypto = require('./directCrypto');
const frames = require('./channelFrames');
const fileLaneReplay = require('./fileLaneReplay');

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
// keepalives, we send reconnects. The watchdog exists because a NAT can
// kill an idle stream without either end hearing a close — the socket
// looks established while nothing will ever arrive again. Keepalives come
// every ~45s, so 100s of silence means the stream is dead, not quiet.
const SILENCE_MS = 100 * 1000;

function watchdog() {
    if (!state) return;
    if (Date.now() - state.lastHeard > SILENCE_MS) {
        if (state.stream) try { state.stream.destroy(); } catch { /* dead */ }
        return retrySubscribe('keepalives stopped');
    }
    state.watch = setTimeout(watchdog, 30 * 1000);
    state.watch.unref();
}

function subscribe() {
    if (!state) return;
    const req = https.get(`${NTFY}/${state.topic}/json`, res => {
        if (res.statusCode !== 200) {
            res.resume();
            return retrySubscribe(`stream refused (${res.statusCode})`);
        }
        log('signaling armed');
        state.lastHeard = Date.now();
        clearTimeout(state.watch);
        watchdog();
        let carry = '';
        res.on('data', piece => {
            state.lastHeard = Date.now();
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
    clearTimeout(state.watch);
    state.retry = setTimeout(subscribe, 5000);
    state.retry.unref();
}

function candidateType(candidate) {
    const match = / typ (\w+)/.exec(candidate);
    const type = match ? match[1] : 'unknown';
    // candidate:<foundation> <component> <proto> <priority> <address> <port> typ …
    const address = String(candidate).split(' ')[4] || '';
    return `${type}/${address.includes(':') ? 'v6' : 'v4'}`;
}

function handleSignal(raw) {
    const opened = directCrypto.open(state.key, SELF, raw, state.seen);
    if (!opened.payload) return;
    const signal = opened.payload;
    if (signal.kind === 'offer' && typeof signal.sdp === 'string') {
        answerOffer(signal);
    } else if (signal.kind === 'candidate' && typeof signal.candidate === 'string') {
        // Candidates for an offer still being negotiated belong to that pc;
        // once it is promoted, later candidates go to the live one.
        const target = state.pending || state.pc;
        if (!target) return;
        log(`phone candidate in (${candidateType(signal.candidate)})`);
        try { target.addRemoteCandidate(signal.candidate, signal.mid || '0'); }
        catch (err) { log(`candidate refused: ${err.message}`); }
    }
}

function closeSession(session, pc, reason) {
    if (session) {
        log(`session closed (${reason})`);
        try { session.ws.close(); } catch { /* closing */ }
        try { session.dc.close(); } catch { /* closing */ }
    }
    if (pc) { try { pc.close(); } catch { /* closing */ } }
}

function teardown(reason) {
    if (!state) return;
    closeSession(state.session, state.pc, reason);
    state.session = null;
    state.pc = null;
}

function answerOffer(signal) {
    let nodeDataChannel;
    try { nodeDataChannel = require('node-datachannel'); }
    catch (err) { return log(`node-datachannel unavailable: ${err.message}`); }

    log('offer received; answering');
    // The replacement is negotiated alongside the live session, not on its
    // grave: a garbage or dead-on-arrival offer — which any secret-holder
    // can publish — must not drop a phone that is still connected. Only when
    // the new channel actually opens does the old session retire.
    if (state.pending) { try { state.pending.close(); } catch { /* stale */ } }
    const pc = new nodeDataChannel.PeerConnection('jarvis-mac',
        { iceServers: [...STUN, ...state.turn] });
    state.pending = pc;
    pc.onLocalDescription((sdp, type) => { log(`${type} published`); publish({ kind: type, sdp }); });
    pc.onLocalCandidate((candidate, mid) => {
        log(`our candidate out (${candidateType(candidate)})`);
        publish({ kind: 'candidate', candidate, mid });
    });
    pc.onIceStateChange(ice => log(`ice: ${ice}`));
    pc.onDataChannel(dc => {
        // The new peer is really here now: retire whatever was live, then
        // promote this one and bridge it.
        if (state.pc && state.pc !== pc) {
            closeSession(state.session, state.pc, 'replaced by a live connection');
            state.session = null;
        }
        state.pc = pc;
        state.pending = null;
        bridge(dc);
    });
    pc.onStateChange(pcState => {
        log(`pc: ${pcState}`);
        if (pcState !== 'failed' && pcState !== 'closed') return;
        if (state && state.pending === pc) {
            // A negotiation that never arrived: drop it, keep the live one.
            try { pc.close(); } catch { /* closing */ }
            state.pending = null;
        } else if (state && state.pc === pc) {
            teardown(`peer ${pcState}`);
        }
    });
    // Alongside the answer, tell the phone where the router's mapped port
    // is (when NAT-PMP won one): a direct TCP door with no relay behind it.
    const spot = typeof state.endpoint === 'function' ? state.endpoint() : null;
    if (spot) publish({ kind: 'endpoint', host: spot.ip, port: spot.port });
    try {
        pc.setRemoteDescription(signal.sdp, 'offer');
    } catch (err) {
        log(`offer rejected: ${err.message}`);
        try { pc.close(); } catch { /* closing */ }
        if (state && state.pending === pc) state.pending = null;
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
    // The channel opened because the peer had the pairing secret; that
    // buys the tunnel, not Jarvis. The file lane stays shut until the
    // bridged socket has proven the socket token — signalled by the
    // daemon's own post-auth "connected" flowing back up the pipe.
    const session = { dc, ws, sid: 1, authed: false };
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
        if (whole.tag === frames.TAG.WS_TEXT) return forward(whole.body.toString('utf8'), null);
        // A file op before the socket authenticated is a peer with the
        // secret but not the token: refuse it, do not replay it.
        if (whole.tag === frames.TAG.FILE_REQ) {
            if (!session.authed) return log('file op refused: socket not authenticated');
            return fileRequest(session, whole);
        }
    });
    dc.onClosed(() => {
        if (state && state.session === session) teardown('channel closed');
    });

    ws.on('message', (data, isBinary) => {
        try {
            if (!isBinary) {
                // The daemon sends "connected" only after a good token, so
                // seeing it means this session cleared auth. A 4401 close
                // (bad token) simply never flips the flag.
                const text = data.toString();
                if (!session.authed) {
                    try {
                        if (JSON.parse(text).type === 'connected') session.authed = true;
                    } catch { /* not the frame we're watching for */ }
                }
                // libwebrtc refuses messages past a quarter megabyte; a long
                // conversation snapshot rides framed instead of vanishing.
                if (Buffer.byteLength(text, 'utf8') > 60000) {
                    for (const frame of frames.chunk(frames.TAG.WS_TEXT,
                        { sid: session.sid++ }, Buffer.from(text, 'utf8'))) {
                        dc.sendMessageBinary(frame);
                    }
                    return;
                }
                return dc.sendMessage(text);
            }
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
    const sid = session.sid++;
    fileLaneReplay.replay({ port: state.port, token: state.token },
        whole.meta, whole.body, (status, header, payload) => {
            try {
                for (const frame of frames.chunk(frames.TAG.FILE_RES,
                    { sid, reqId: whole.meta.reqId, status, ...header }, payload)) {
                    session.dc.sendMessageBinary(frame);
                }
            } catch (err) { log(`file response failed: ${err.message}`); }
        });
}

// TURN entries arrive as libdatachannel URIs — turn:user:pass@host:port,
// optionally ?transport=tcp. A relay is the honest rung under a symmetric
// NAT: the punch cannot land, and the relay carries only DTLS ciphertext.
function start({ secret, port, token, turn = [], endpoint = null }) {
    if (state) return;
    state = {
        key: directCrypto.keyFor(secret),
        topic: directCrypto.topicFor(secret),
        port, token, turn, endpoint,
        seen: new Map(),
        pc: null, session: null, pending: null, stream: null, retry: null,
        watch: null, lastHeard: Date.now()
    };
    subscribe();
}

function stop() {
    if (!state) return;
    if (state.pending) { try { state.pending.close(); } catch { /* closing */ } }
    teardown('transport stopped');
    clearTimeout(state.retry);
    clearTimeout(state.watch);
    if (state.stream) try { state.stream.destroy(); } catch { /* closing */ }
    state = null;
}

module.exports = { start, stop };
