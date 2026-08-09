const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const HELPER = path.join(__dirname, '..', 'native', 'jarvis-ax');
const SOURCE = path.join(__dirname, '..', 'native', 'ax.swift');

const REQUEST_TIMEOUT_MS = 15000;

let child = null;
let pending = Promise.resolve();
let buffer = '';
let waiting = null;

function available() {
    return fs.existsSync(HELPER);
}

function buildInstruction() {
    return fs.existsSync(SOURCE)
        ? `Build it with: sh ${path.relative(process.cwd(), path.dirname(SOURCE))}/build.sh`
        : 'The helper source is missing.';
}

function start() {
    if (child && !child.killed) return child;

    if (!available()) {
        throw new Error(`the accessibility helper is not built. ${buildInstruction()}`);
    }

    child = spawn(HELPER, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    buffer = '';

    child.stdout.on('data', chunk => {
        buffer += chunk.toString();
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line && waiting) {
                const settle = waiting;
                waiting = null;
                try { settle.resolve(JSON.parse(line)); }
                catch { settle.reject(new Error(`the helper said something that was not JSON: ${line.slice(0, 120)}`)); }
            }
            newline = buffer.indexOf('\n');
        }
    });

    const collapse = why => {
        child = null;
        if (waiting) {
            const settle = waiting;
            waiting = null;
            settle.reject(new Error(why));
        }
    };
    child.on('exit', code => collapse(`the accessibility helper exited (${code})`));
    child.on('error', err => collapse(`the accessibility helper failed: ${err.message}`));

    return child;
}

function send(request) {
    const run = () => new Promise((resolve, reject) => {
        let helper;
        try { helper = start(); }
        catch (err) { reject(err); return; }

        const timer = setTimeout(() => {
            waiting = null;
            try { helper.kill('SIGKILL'); } catch {  }
            child = null;
            reject(new Error(`${request.cmd} timed out after ${REQUEST_TIMEOUT_MS}ms`));
        }, REQUEST_TIMEOUT_MS);

        waiting = {
            resolve: value => { clearTimeout(timer); resolve(value); },
            reject: err => { clearTimeout(timer); reject(err); }
        };

        helper.stdin.write(`${JSON.stringify(request)}\n`);
    });

    const result = pending.then(run, run);
    pending = result.then(() => {}, () => {});
    return result;
}

async function trusted() {
    if (!available()) return false;
    try {
        const reply = await send({ cmd: 'trust' });
        return reply.trusted === true;
    } catch {
        return false;
    }
}

function why() {
    if (!available()) return `the accessibility helper is not built. ${buildInstruction()}`;
    return 'the accessibility helper has no permission to control the computer. '
        + 'Grant it in System Settings > Privacy & Security > Accessibility, '
        + `where it appears as jarvis-ax (${HELPER}).`;
}

function stop() {
    if (child && !child.killed) {
        try { child.stdin.end(); } catch {  }
        try { child.kill(); } catch {  }
    }
    child = null;
    waiting = null;
}

function isRunning() {
    return Boolean(child && !child.killed);
}

module.exports = { send, trusted, available, why, stop, isRunning, HELPER, REQUEST_TIMEOUT_MS };
