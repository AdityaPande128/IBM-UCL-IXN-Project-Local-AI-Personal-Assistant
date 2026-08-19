const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_PATH = path.join(os.homedir(), '.jarvis', 'socket-token');

function resolvePath(configured) {
    if (!configured) return DEFAULT_PATH;
    if (configured === '~') return os.homedir();
    if (configured.startsWith('~/')) return path.join(os.homedir(), configured.slice(2));
    return configured;
}

function issue(configuredPath) {
    const tokenPath = resolvePath(configuredPath);
    // A token that exists is reused, not rotated. Two daemons can race for
    // the port at startup; if the loser rotated the file on its way down,
    // every client would present the dead daemon's token to the living one
    // and be refused until someone restarted the world.
    try {
        const existing = fs.readFileSync(tokenPath, 'utf8').trim();
        if (/^[0-9a-f]{64}$/.test(existing)) return existing;
    } catch { /* no token yet — mint one */ }
    const token = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tokenPath, token, { mode: 0o600 });
    return token;
}

function verify(expected, presented) {
    if (typeof expected !== 'string' || typeof presented !== 'string') return false;
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(presented, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

module.exports = { issue, verify, resolvePath, DEFAULT_PATH };
