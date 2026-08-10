const { spawn } = require('child_process');
const configReader = require('../utils/configReader');

const config = configReader.readConfig();
const SETTINGS = config.availability || {};

// caffeinate -s asserts only while the machine is on AC power — macOS itself
// releases it on battery, which is exactly the contract: watchers may keep the
// machine awake at the desk, never at the cost of the battery. -w ties the
// assertion to this process, so a crashed backend cannot leave one behind.
const STAY_AWAKE = SETTINGS.stay_awake !== false;
const MAX_RESPAWNS = SETTINGS.max_respawns ?? 5;
const RESPAWN_DELAY_MS = SETTINGS.respawn_delay_ms ?? 5000;

let child = null;
let respawns = 0;
let stopped = true;
let spawner = null;

function setSpawner(fn) {
    spawner = fn;
}

function launch() {
    const run = spawner || spawn;
    let proc;
    try {
        proc = run('caffeinate', ['-s', '-w', String(process.pid)], { stdio: 'ignore' });
    } catch (err) {
        console.warn(`[Availability] caffeinate would not start: ${err.message}`);
        return null;
    }

    proc.on('error', err => {
        console.warn(`[Availability] caffeinate failed: ${err.message}`);
        if (child === proc) child = null;
    });

    proc.on('exit', () => {
        if (child === proc) child = null;
        if (stopped) return;
        if (respawns >= MAX_RESPAWNS) {
            console.warn('[Availability] caffeinate keeps exiting; the stay-awake assertion is dropped.');
            return;
        }
        respawns += 1;
        const timer = setTimeout(() => {
            if (!stopped && !child) child = launch();
        }, RESPAWN_DELAY_MS);
        if (timer.unref) timer.unref();
    });

    // The assertion must never keep the daemon itself alive: -w already ties
    // the child to this process, so nothing is lost by letting go.
    if (proc.unref) proc.unref();

    return proc;
}

function start() {
    if (!STAY_AWAKE) return status();
    stopped = false;
    if (!child) child = launch();
    return status();
}

function stop() {
    stopped = true;
    if (child) {
        child.kill();
        child = null;
    }
    return status();
}

function status() {
    return {
        stay_awake: STAY_AWAKE,
        holding: Boolean(child),
        respawns
    };
}

module.exports = { start, stop, status, setSpawner };
