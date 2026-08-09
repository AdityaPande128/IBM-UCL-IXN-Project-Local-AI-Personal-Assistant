const fs = require('fs');
const path = require('path');

const PROFILE_DIR = path.join(__dirname, '..', 'data', 'browser-profile');
const BOUND_TO = path.join(PROFILE_DIR, '.jarvis-browser');

const KNOWN_BROWSERS = [
    { name: 'Brave', binary: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' },
    { name: 'Chrome', binary: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }
];

function remembered() {
    try {
        const name = fs.readFileSync(BOUND_TO, 'utf8').trim();
        return KNOWN_BROWSERS.find(entry => entry.name === name && fs.existsSync(entry.binary)) || null;
    } catch {
        return null;
    }
}

function chosen() {
    return remembered() || KNOWN_BROWSERS.find(entry => fs.existsSync(entry.binary)) || null;
}

function bind(name) {
    try {
        fs.mkdirSync(PROFILE_DIR, { recursive: true });
        if (!fs.existsSync(BOUND_TO)) fs.writeFileSync(BOUND_TO, name);
    } catch {  }
}

function exists() {
    return fs.existsSync(PROFILE_DIR);
}

function heldBy() {
    try {
        const target = fs.readlinkSync(path.join(PROFILE_DIR, 'SingletonLock'));
        const pid = Number(String(target).split('-').pop());
        if (!Number.isInteger(pid) || pid <= 0) return null;
        try { process.kill(pid, 0); } catch { return null; }
        return pid;
    } catch {
        return null;
    }
}

function inUse() {
    return heldBy() !== null;
}

module.exports = {
    PROFILE_DIR, BOUND_TO, KNOWN_BROWSERS,
    remembered, chosen, bind, exists, heldBy, inUse
};
