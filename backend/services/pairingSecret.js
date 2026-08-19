const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_PATH = path.join(os.homedir(), '.jarvis', 'pairing-secret');

// Same contract as the socket token: an existing secret is reused, never
// rotated by a losing daemon, because rotating it strands every paired phone.
function issue(configuredPath) {
    const secretPath = configuredPath || DEFAULT_PATH;
    try {
        const existing = fs.readFileSync(secretPath, 'utf8').trim();
        if (/^[0-9a-f]{64}$/.test(existing)) return existing;
    } catch { /* no secret yet — mint one */ }
    const secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(secretPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(secretPath, secret, { mode: 0o600 });
    return secret;
}

module.exports = { issue, DEFAULT_PATH };
