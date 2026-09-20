#!/usr/bin/env node
// The candidate pool of the model study, and a way to bring one candidate into
// memory without touching config.json: the inference server loads any cached
// checkpoint on request, so "swapping" a model is a probe call.
//
//   node tools/study-model.js --list            cache status and size of every candidate
//   node tools/study-model.js <model-id>        load it with a probe call, print residency

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const HUB = process.env.HF_HUB_CACHE
    || (process.env.HF_HOME ? path.join(process.env.HF_HOME, 'hub') : path.join(os.homedir(), '.cache', 'huggingface', 'hub'));

// role: router (guard tier candidate), coder (smith tier candidate), both.
const POOL = [
    { id: 'mlx-community/Qwen3-4B-Instruct-2507-4bit', role: 'both', note: 'incumbent guard/engine' },
    { id: 'mlx-community/Qwen3-4B-Instruct-2507-8bit', role: 'router', note: 'quantisation factor' },
    { id: 'mlx-community/Qwen3.5-4B-MLX-4bit', role: 'both' },
    { id: 'mlx-community/Qwen3.5-4B-MLX-8bit', role: 'router', note: 'quantisation factor' },
    { id: 'mlx-community/Qwen3.5-9B-MLX-4bit', role: 'both' },
    { id: 'mlx-community/LFM2.5-2.6B-4bit', role: 'router' },
    { id: 'mlx-community/Nanbeige4.1-3B-8bit', role: 'router', note: 'no non-abliterated 4-bit MLX exists' },
    { id: 'mlx-community/gemma-4-E4B-it-qat-4bit', role: 'router' },
    { id: 'mlx-community/granite-4.1-8b-4bit', role: 'router', note: 'earlier engine choice' },
    { id: 'lmstudio-community/granite-4.2-3b-MLX-4bit', role: 'router' },
    { id: 'lmstudio-community/granite-4.2-8b-MLX-4bit', role: 'router' },
    { id: 'mlx-community/Qwen3.5-2B-MLX-4bit', role: 'router', note: 'small end of the current generation' },
    { id: 'mlx-community/Qwen2.5-Coder-7B-Instruct-4bit', role: 'coder', note: 'incumbent generation.model' },
    { id: 'mlx-community/Qwen2.5-Coder-14B-Instruct-4bit', role: 'coder', note: 'configured smith tier' },
    { id: 'mlx-community/Qwen2.5-Coder-3B-Instruct-4bit', role: 'coder' },
    { id: path.join(os.homedir(), '.cache', 'jarvis-models', 'Nemotron-3-Nano-4B-4bit'), role: 'router', note: 'local mlx_lm conversion of nvidia/NVIDIA-Nemotron-3-Nano-4B-BF16; present only if it succeeded' },
];

function cacheDir(id) {
    return path.join(HUB, 'models--' + id.replace('/', '--'));
}

function cached(id) {
    if (path.isAbsolute(id)) return fs.existsSync(path.join(id, 'config.json')) ? id : null;
    const snaps = path.join(cacheDir(id), 'snapshots');
    if (!fs.existsSync(snaps)) return null;
    for (const snap of fs.readdirSync(snaps)) {
        const dir = path.join(snaps, snap);
        if (fs.existsSync(path.join(dir, 'config.json'))) return dir;
    }
    return null;
}

function dirBytes(dir) {
    let total = 0;
    const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.isFile()) { try { total += fs.lstatSync(full).size; } catch {} }
        }
    };
    walk(dir);
    return total;
}

function request(method, pathname, body) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const req = http.request({ hostname: '127.0.0.1', port: 8787, path: pathname, method,
            headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
            timeout: 300000 }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        if (payload) req.write(payload);
        req.end();
    });
}

async function main() {
    const target = process.argv[2];
    if (!target || target === '--list') {
        for (const m of POOL) {
            const dir = cached(m.id);
            const size = dir ? (dirBytes(path.isAbsolute(m.id) ? m.id : cacheDir(m.id)) / 2 ** 30).toFixed(2) + ' GB' : '-';
            console.log(`${dir ? 'cached ' : 'absent '} ${m.id.padEnd(50)} ${m.role.padEnd(7)} ${size.padStart(9)}  ${m.note || ''}`);
        }
        return;
    }
    const dir = cached(target);
    if (!dir) {
        console.error(`${target} is not in the hub cache (${cacheDir(target)}); download it first`);
        process.exit(1);
    }
    const t0 = Date.now();
    const reply = await request('POST', '/v1/chat/completions', {
        model: target, messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
        max_tokens: 4, temperature: 0
    });
    const ms = Date.now() - t0;
    const content = reply?.choices?.[0]?.message?.content;
    console.log(`probe ${ms}ms → ${JSON.stringify(content ?? reply)}`);
    const residency = await request('GET', '/residency');
    console.log(JSON.stringify(residency, null, 2));
}

main().catch(err => { console.error(err.message); process.exit(1); });
