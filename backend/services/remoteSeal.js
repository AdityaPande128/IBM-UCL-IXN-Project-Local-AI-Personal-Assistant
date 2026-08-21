const crypto = require('crypto');
const directCrypto = require('./directCrypto');

// The remembered home door is a plain TCP port on the open internet. The
// pairing secret seals everything that crosses it: text frames ride the
// same deflated JSON envelope signaling uses, binary frames a compact
// form — [1B v=1][12B nonce][8B BE ts ms][ciphertext+tag], AAD = from‖ts.
// The socket token, every chat and every file crosses only as ciphertext.

const WINDOW_MS = directCrypto.WINDOW_MS;

let key = null;

function init(secretHex) {
    key = directCrypto.derive(secretHex, 'jarvis-remote/ws', 32);
}

function ready() {
    return key !== null;
}

function sealText(from, payload) {
    return directCrypto.seal(key, from, payload);
}

function openText(self, raw, seen) {
    return directCrypto.open(key, self, raw, seen);
}

function sealBinary(from, data) {
    const nonce = crypto.randomBytes(12);
    const ts = Buffer.alloc(8);
    ts.writeBigUInt64BE(BigInt(Date.now()));
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.concat([Buffer.from(from, 'utf8'), ts]));
    const sealed = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
    return Buffer.concat([Buffer.from([1]), nonce, ts, sealed]);
}

function openBinary(from, buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 1 + 12 + 8 + 16 || buf[0] !== 1) return null;
    const nonce = buf.subarray(1, 13);
    const ts = buf.subarray(13, 21);
    if (Math.abs(Date.now() - Number(ts.readBigUInt64BE())) > WINDOW_MS) return null;
    const sealed = buf.subarray(21);
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
        decipher.setAAD(Buffer.concat([Buffer.from(from, 'utf8'), ts]));
        decipher.setAuthTag(sealed.subarray(sealed.length - 16));
        return Buffer.concat([
            decipher.update(sealed.subarray(0, sealed.length - 16)),
            decipher.final()
        ]);
    } catch {
        return null;
    }
}

module.exports = { init, ready, sealText, openText, sealBinary, openBinary, WINDOW_MS };
