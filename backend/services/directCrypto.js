const crypto = require('crypto');
const zlib = require('zlib');

// The pairing QR moves one 32-byte secret over a camera — a channel the
// internet cannot see or alter. Everything Direct needs derives from it:
// the rendezvous topic nobody can guess and the key that seals signaling.
// The relay (ntfy) carries ciphertext addressed by hash; it can read
// nothing and forge nothing.

const WINDOW_MS = 120000;

function derive(secretHex, info, bytes) {
    const secret = Buffer.from(secretHex, 'hex');
    if (secret.length !== 32) throw new Error('pairing secret must be 32 bytes');
    return Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), info, bytes));
}

function topicFor(secretHex) {
    return 'jarvis-' + derive(secretHex, 'jarvis-direct/topic', 16).toString('hex');
}

function keyFor(secretHex) {
    return derive(secretHex, 'jarvis-direct/signal', 32);
}

function seal(key, from, payload) {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(from, 'utf8'));
    const packed = zlib.deflateRawSync(Buffer.from(JSON.stringify(payload), 'utf8'));
    const sealed = Buffer.concat([cipher.update(packed), cipher.final(), cipher.getAuthTag()]);
    return JSON.stringify({
        v: 1, from, ts: Date.now(),
        n: nonce.toString('base64'),
        c: sealed.toString('base64')
    });
}

// Returns the payload, or null with a reason for anything that must be
// ignored: our own echoes, stale replays, and anything the tag rejects.
function open(key, self, raw, seen) {
    let envelope;
    try { envelope = JSON.parse(raw); } catch { return { reason: 'not json' }; }
    if (!envelope || envelope.v !== 1) return { reason: 'wrong version' };
    if (envelope.from === self) return { reason: 'own echo' };
    if (typeof envelope.ts !== 'number' || Math.abs(Date.now() - envelope.ts) > WINDOW_MS) {
        return { reason: 'outside the replay window' };
    }
    if (seen && seen.has(envelope.n)) return { reason: 'replayed nonce' };
    try {
        const nonce = Buffer.from(envelope.n, 'base64');
        const sealed = Buffer.from(envelope.c, 'base64');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
        decipher.setAAD(Buffer.from(String(envelope.from), 'utf8'));
        decipher.setAuthTag(sealed.subarray(sealed.length - 16));
        const packed = Buffer.concat([
            decipher.update(sealed.subarray(0, sealed.length - 16)),
            decipher.final()
        ]);
        if (seen) {
            seen.set(envelope.n, envelope.ts);
            for (const [nonce_, ts] of seen) {
                if (Date.now() - ts > WINDOW_MS) seen.delete(nonce_);
            }
        }
        return { payload: JSON.parse(zlib.inflateRawSync(packed).toString('utf8')) };
    } catch {
        return { reason: 'bad seal' };
    }
}

module.exports = { derive, topicFor, keyFor, seal, open, WINDOW_MS };
