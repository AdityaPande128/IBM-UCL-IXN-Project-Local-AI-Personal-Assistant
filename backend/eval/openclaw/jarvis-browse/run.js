#!/usr/bin/env node
// OpenClaw's side of the borrowed browser: sends one browse goal to the Jarvis
// daemon over its authenticated socket and prints what came back. OpenClaw's
// own loop decides when to call this and what to do with the answer.

const fs = require('fs');
const os = require('os');
const path = require('path');

const backend = path.resolve(__dirname, '..', '..', '..');
const WebSocket = require(path.join(backend, 'node_modules', 'ws'));
const configReader = require(path.join(backend, 'utils', 'configReader'));

function argValue(flag) {
    const index = process.argv.indexOf(flag);
    return index !== -1 ? process.argv[index + 1] : undefined;
}

const goal = argValue('--goal');
const url = argValue('--url');
if (!goal) {
    console.error('usage: run.js --goal "<what to achieve>" [--url <where to start>]');
    process.exit(2);
}

const port = configReader.readConfig().ports.backend;
const token = fs.readFileSync(path.join(os.homedir(), '.jarvis', 'socket-token'), 'utf8').trim();
const ws = new WebSocket(`ws://127.0.0.1:${port}`);

ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
ws.on('error', (err) => { console.error(`jarvis daemon unreachable: ${err.message}`); process.exit(1); });
ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.type === 'connected') {
        ws.send(JSON.stringify({ type: 'browse', goal, ...(url ? { url } : {}) }));
        return;
    }
    if (msg.type === 'browse_result') {
        if (msg.status === 'success') {
            console.log(msg.answer || '');
            if (msg.url) console.log(`\n[finished at ${msg.url}]`);
            process.exit(0);
        }
        console.error(msg.reason || `browsing ${msg.status}`);
        process.exit(1);
    }
});

setTimeout(() => { console.error('timed out waiting for the browse result'); process.exit(1); },
    Number(process.env.JARVIS_BROWSE_TIMEOUT_MS || 300000));
