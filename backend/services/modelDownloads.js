// Model downloads, one at a time, surviving restarts. The queue is written
// to disk on every status change because applying onboarding restarts the
// daemon mid-download — on boot the queue picks up where it left off, and
// the hub client resumes partial files rather than starting over. Progress
// arrives as JSON lines from a small python helper (the same runtime that
// will load the model) and is fanned out to subscribers.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const modelCatalog = require('./modelCatalog');

const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'downloads.json');
const DEFAULT_SCRIPT = path.join(__dirname, '..', 'inference', 'download.py');

const EMIT_EVERY_MS = 500;

function createManager(options = {}) {
    const file = options.file || process.env.JARVIS_DOWNLOADS_PATH || DEFAULT_FILE;
    const script = options.script || DEFAULT_SCRIPT;
    const python = options.python || 'python3';
    const isDownloaded = options.downloaded || modelCatalog.downloaded;

    const jobs = new Map();
    const order = [];
    const listeners = new Set();
    let child = null;
    let active = null;

    // A daemon restart must not leave a downloader running unowned — the
    // next boot resumes the queue and would race its orphan for the same
    // blobs.
    process.on('exit', () => {
        if (child) child.kill('SIGTERM');
    });

    function subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    function emit(job) {
        const snapshot = { ...job };
        for (const listener of listeners) {
            try { listener(snapshot); } catch { }
        }
    }

    function persist() {
        const queue = order.map(model => {
            const job = jobs.get(model);
            return { model: job.model, kind: job.kind, status: job.status };
        });
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify({ queue }, null, 2) + '\n');
        } catch (err) {
            console.warn(`[Downloads] could not persist the queue: ${err.message}`);
        }
    }

    function setStatus(job, status, error) {
        job.status = status;
        job.error = error || null;
        persist();
        emit(job);
    }

    function status() {
        return {
            active,
            queue: order.map(model => ({ ...jobs.get(model) }))
        };
    }

    function ensureJob(model, kind) {
        if (jobs.has(model)) return jobs.get(model);
        const job = {
            model, kind,
            status: 'queued',
            received_bytes: 0,
            total_bytes: null,
            error: null
        };
        jobs.set(model, job);
        order.push(model);
        return job;
    }

    // defer queues and persists without spawning — for the caller that is
    // about to restart the daemon and wants the next boot to do the work,
    // not an orphan of this one.
    function enqueue(items, opts = {}) {
        for (const { model, kind } of items) {
            if (!model) continue;
            const job = ensureJob(model, kind || 'model');
            if (job.status === 'downloading') continue;
            if (isDownloaded(model)) {
                job.status = 'done';
                if (job.total_bytes) job.received_bytes = job.total_bytes;
            } else if (job.status === 'done' || job.status === 'stopped') {
                // Done-but-gone re-downloads; a pause yields to the explicit
                // re-selection that asked for the model again.
                job.status = 'queued';
            }
            emit(job);
        }
        persist();
        if (!opts.defer) startNext();
    }

    function startNext() {
        if (child) return;
        const next = order.find(model => jobs.get(model).status === 'queued');
        if (!next) return;

        const job = jobs.get(next);
        active = job.model;
        setStatus(job, 'downloading');

        let lastEmit = 0;
        let buffered = '';

        child = spawn(python, [script, job.model], {
            cwd: path.dirname(script),
            env: { ...process.env, HF_HUB_DISABLE_XET: '1' }
        });

        child.stdout.on('data', chunk => {
            buffered += chunk.toString();
            const lines = buffered.split('\n');
            buffered = lines.pop();
            for (const line of lines) {
                let parsed;
                try { parsed = JSON.parse(line); } catch { continue; }
                if (parsed.total !== undefined) job.total_bytes = parsed.total;
                if (parsed.received !== undefined) job.received_bytes = parsed.received;
                if (parsed.done) continue;   // the close handler settles the status
                const now = Date.now();
                if (now - lastEmit >= EMIT_EVERY_MS) {
                    lastEmit = now;
                    emit(job);
                }
            }
        });

        let stderrTail = '';
        child.stderr.on('data', chunk => {
            stderrTail = (stderrTail + chunk.toString()).slice(-2000);
        });

        child.on('error', err => {
            child = null;
            active = null;
            setStatus(job, 'error', err.message);
            startNext();
        });

        child.on('close', (code, signal) => {
            child = null;
            active = null;
            if (signal || job.status === 'stopped') {
                setStatus(job, 'stopped');
            } else if (code === 0) {
                if (job.total_bytes) job.received_bytes = job.total_bytes;
                setStatus(job, 'done');
            } else {
                const lastLine = stderrTail.trim().split('\n').at(-1) || `exit ${code}`;
                setStatus(job, 'error', lastLine);
            }
            startNext();
        });
    }

    function stop(model) {
        const job = jobs.get(model);
        if (!job) return { status: 'unknown_model', model };
        if (job.status === 'downloading' && child) {
            // Persist before killing: a settings restart exits the process
            // before the async close handler would have written the pause.
            setStatus(job, 'stopped');
            child.kill('SIGTERM');
        } else if (job.status === 'queued') {
            setStatus(job, 'stopped');
        }
        return { status: job.status, model };
    }

    function start(model) {
        const job = jobs.get(model);
        if (!job) return { status: 'unknown_model', model };
        if (job.status === 'stopped' || job.status === 'error') {
            setStatus(job, 'queued');
            startNext();
        }
        return { status: job.status, model };
    }

    // On boot: reload the persisted queue. What finished is re-checked
    // against the disk, what was mid-flight resumes, what the user stopped
    // stays stopped.
    function resume() {
        let stored;
        try {
            stored = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
            return;
        }
        for (const entry of stored.queue || []) {
            if (!entry || !entry.model) continue;
            const job = ensureJob(entry.model, entry.kind);
            if (isDownloaded(entry.model)) job.status = 'done';
            else if (entry.status === 'stopped') job.status = 'stopped';
            else job.status = 'queued';
        }
        persist();
        startNext();
    }

    return { enqueue, stop, start, status, resume, subscribe };
}

module.exports = { createManager, manager: createManager() };
