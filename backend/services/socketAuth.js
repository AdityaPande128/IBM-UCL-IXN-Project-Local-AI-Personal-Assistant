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
