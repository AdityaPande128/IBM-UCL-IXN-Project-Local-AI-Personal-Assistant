const dgram = require('dgram');
const { execFile } = require('child_process');

// NAT-PMP (RFC 6886): ask the home router, politely and with no third party
// anywhere, to map a public port onto this Mac. Where the router agrees, the
// Mac becomes its own server — reachable from any network in the world with
// nothing in the path but the user's own hardware. Routers that refuse
// (campus, hotels) simply leave current() null and the ladder moves on.

const NATPMP_PORT = 5351;
const LIFETIME_S = 3600;
const RETRY_MS = 10 * 60 * 1000;

let state = null;

function log(line) {
    console.log(`[NAT-PMP] ${line}`);
}

function buildExternalRequest() {
    return Buffer.from([0, 0]);
}

function parseExternalResponse(buf) {
    if (!buf || buf.length < 12 || buf[0] !== 0 || buf[1] !== 128) return null;
    if (buf.readUInt16BE(2) !== 0) return null;
    return `${buf[8]}.${buf[9]}.${buf[10]}.${buf[11]}`;
}

function buildMapRequest(internalPort, externalPort, lifetime = LIFETIME_S) {
    const buf = Buffer.alloc(12);
    buf[0] = 0;
    buf[1] = 2; // TCP
    buf.writeUInt16BE(internalPort, 4);
    buf.writeUInt16BE(externalPort, 6);
    buf.writeUInt32BE(lifetime, 8);
    return buf;
}

function parseMapResponse(buf) {
    if (!buf || buf.length < 16 || buf[0] !== 0 || buf[1] !== 130) return null;
    if (buf.readUInt16BE(2) !== 0) return null;
    return {
        internalPort: buf.readUInt16BE(8),
        externalPort: buf.readUInt16BE(10),
        lifetime: buf.readUInt32BE(12)
    };
}

function gateway() {
    return new Promise(resolve => {
        execFile('route', ['-n', 'get', 'default'], { timeout: 3000 }, (err, out) => {
            if (err) return resolve(null);
            const match = /gateway: ([\d.]+)/.exec(String(out || ''));
            resolve(match ? match[1] : null);
        });
    });
}

function exchange(gw, payload, timeoutMs = 2500) {
    return new Promise(resolve => {
        const sock = dgram.createSocket('udp4');
        const timer = setTimeout(() => { try { sock.close(); } catch { } resolve(null); }, timeoutMs);
        timer.unref();
        sock.once('message', msg => {
            clearTimeout(timer);
            try { sock.close(); } catch { }
            resolve(msg);
        });
        sock.once('error', () => {
            clearTimeout(timer);
            try { sock.close(); } catch { }
            resolve(null);
        });
        sock.send(payload, NATPMP_PORT, gw, err => { if (err) resolve(null); });
    });
}

async function refresh() {
    if (!state) return;
    const gw = await gateway();
    if (!gw) return schedule('no default gateway', RETRY_MS);

    const ip = parseExternalResponse(await exchange(gw, buildExternalRequest()));
    if (!ip) return schedule('router does not speak NAT-PMP', RETRY_MS);

    const mapped = parseMapResponse(await exchange(
        gw, buildMapRequest(state.port, state.port)));
    if (!mapped) return schedule('router refused the mapping', RETRY_MS);

    const fresh = !state.current
        || state.current.ip !== ip || state.current.port !== mapped.externalPort;
    state.current = { ip, port: mapped.externalPort };
    if (fresh) log(`mapped ${ip}:${mapped.externalPort} -> :${state.port} for ${mapped.lifetime}s`);
    // Renew at half-life so the mapping never lapses while the daemon lives.
    schedule(null, Math.max(30, (mapped.lifetime || LIFETIME_S) / 2) * 1000);
}

function schedule(reason, delayMs) {
    if (!state) return;
    if (reason) {
        if (!state.quiet) log(`${reason}; retrying every ${RETRY_MS / 60000} min`);
        state.quiet = true;
        state.current = null;
    } else {
        state.quiet = false;
    }
    clearTimeout(state.timer);
    state.timer = setTimeout(refresh, delayMs);
    state.timer.unref();
}

function start({ port }) {
    if (state) return;
    state = { port, current: null, timer: null, quiet: false };
    refresh();
}

function stop() {
    if (!state) return;
    clearTimeout(state.timer);
    state = null;
}

function current() {
    return state ? state.current : null;
}

module.exports = {
    start, stop, current,
    buildExternalRequest, parseExternalResponse, buildMapRequest, parseMapResponse
};
