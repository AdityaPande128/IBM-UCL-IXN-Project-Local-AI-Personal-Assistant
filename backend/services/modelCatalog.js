// What this machine can run, and what it should. The catalog (config data,
// never code) lists the models the pickers may offer; the hardware_defaults
// table names the recommended pick for this machine's memory class; and one
// budget formula decides whether a selection fits — the same formula whether
// the choice arrives from onboarding or from settings later.

const fs = require('fs');
const os = require('os');
const path = require('path');

const modelTiers = require('./modelTiers');

const GB = 1024 ** 3;

function hfCacheDir() {
    if (process.env.HF_HUB_CACHE) return process.env.HF_HUB_CACHE;
    if (process.env.HF_HOME) return path.join(process.env.HF_HOME, 'hub');
    return path.join(os.homedir(), '.cache', 'huggingface', 'hub');
}

function repoDir(modelId) {
    return path.join(hfCacheDir(), `models--${String(modelId).replace(/\//g, '--')}`);
}

// A repo counts as downloaded when a snapshot exists whose every file
// resolves (a dangling symlink means its blob never finished) and no blob
// is still marked incomplete. This judges models fetched outside Jarvis
// too, so a user who already has a model skips its download entirely.
function downloaded(modelId) {
    const dir = repoDir(modelId);
    try {
        const revisions = fs.readdirSync(path.join(dir, 'snapshots'));
        if (!revisions.length) return false;

        const blobsDir = path.join(dir, 'blobs');
        if (fs.existsSync(blobsDir)
            && fs.readdirSync(blobsDir).some(name => name.endsWith('.incomplete'))) {
            return false;
        }

        const snapshot = path.join(dir, 'snapshots', revisions.sort().at(-1));
        const stack = [snapshot];
        while (stack.length) {
            const current = stack.pop();
            for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
                const full = path.join(current, entry.name);
                if (entry.isDirectory()) stack.push(full);
                else if (!fs.existsSync(full)) return false;
            }
        }
        return true;
    } catch {
        return false;
    }
}

function freeDiskGb() {
    try {
        const stats = fs.statfsSync(os.homedir());
        return (stats.bsize * stats.bavail) / GB;
    } catch {
        return null;
    }
}

function machine(config, totalBytes) {
    const total = totalBytes ?? modelTiers.totalMemory();
    const defaults = (config.models || {}).hardware_defaults || {};
    return {
        total_gb: Math.round(total / GB),
        class: Object.keys(defaults).length
            ? modelTiers.memoryClass(defaults, total)
            : null,
        free_disk_gb: freeDiskGb()
    };
}

function budgetGb(config, totalBytes) {
    const models = config.models || {};
    const byClass = models.budget_by_class || {};
    const cls = machine(config, totalBytes).class;
    if (cls !== null && byClass[String(cls)] !== undefined) return byClass[String(cls)];
    return models.budget_gb ?? null;
}

function catalogEntry(config, modelId) {
    const catalog = (config.models || {}).catalog || {};
    for (const list of Object.values(catalog)) {
        const found = (list || []).find(entry => entry.model === modelId);
        if (found) return found;
    }
    return null;
}

// A measured footprint always beats a catalog estimate.
function sizeOf(config, modelId) {
    const measured = ((config.models || {}).measured_gb || {})[modelId];
    if (measured !== undefined) return measured;
    const entry = catalogEntry(config, modelId);
    return entry ? entry.ram_gb : undefined;
}

// The one memory formula. Tiers may share a model (the guard rides the
// engine), so sizes are summed per unique model, never per tier — counting
// the same weights twice would refuse selections that actually fit.
function budgetError(config, tiers, options = {}) {
    const budget = options.budget_gb ?? budgetGb(config);
    if (typeof budget !== 'number') return null;

    const reserve = options.voice === false
        ? 0
        : ((config.models || {}).voice_reserve_gb || 0);
    const available = budget - reserve;

    const byModel = new Map();
    for (const spec of Object.values(tiers)) {
        if (!spec || !spec.model) continue;
        const policies = byModel.get(spec.model) || new Set();
        policies.add(spec.policy || 'transient');
        byModel.set(spec.model, policies);
    }

    let base = 0;
    let pinned = 0;
    for (const [model, policies] of byModel) {
        const size = sizeOf(config, model);
        if (size === undefined) continue;
        if (policies.has('pinned') || policies.has('resident')) base += size;
        if (policies.has('pinned')) pinned += size;
    }
    if (base > available) {
        return `The always-loaded models need ${base.toFixed(1)} GB together `
            + `but only ${available.toFixed(1)} GB is available for models.`;
    }

    for (const [model, policies] of byModel) {
        const size = sizeOf(config, model);
        if (size === undefined) continue;
        if (policies.has('pinned') || policies.has('resident')) continue;
        if (pinned + size > available) {
            return `Loading ${model.split('/').at(-1)} alongside the pinned models needs `
                + `${(pinned + size).toFixed(1)} GB but only `
                + `${available.toFixed(1)} GB is available for models.`;
        }
    }
    return null;
}

// The tier table a selection would produce: the guard mirrors the engine —
// same model, same policy, one set of weights — and the smith only exists
// when improvement is on.
function tiersFor(selection) {
    const engine = { model: selection.engine, policy: 'resident' };
    const tiers = { guard: { ...engine }, engine };
    if (selection.smith) tiers.smith = { model: selection.smith, policy: 'transient' };
    return tiers;
}

const DISK_MARGIN_GB = 2;

function diskError(config, selection) {
    const free = freeDiskGb();
    if (free === null) return null;

    const wanted = [selection.engine, selection.smith];
    if (selection.voice) {
        const voice = (config.models || {}).voice || {};
        if (voice.stt) wanted.push(voice.stt.model);
        if (selection.tts && voice.tts) wanted.push(voice.tts.model);
    }

    let needed = 0;
    for (const modelId of wanted) {
        if (!modelId || downloaded(modelId)) continue;
        const entry = catalogEntry(config, modelId);
        const voice = (config.models || {}).voice || {};
        const voiceEntry = [voice.stt, voice.tts].find(v => v && v.model === modelId);
        needed += (entry && entry.disk_gb) || (voiceEntry && voiceEntry.disk_gb) || 0;
    }
    if (needed && needed + DISK_MARGIN_GB > free) {
        return `The selected downloads need about ${needed.toFixed(1)} GB of disk `
            + `but only ${free.toFixed(1)} GB is free.`;
    }
    return null;
}

// selection: { engine, smith?, voice, tts }
function checkSelection(config, selection, totalBytes) {
    const catalog = (config.models || {}).catalog || {};
    const engines = (catalog.engine || []).map(e => e.model);
    const smiths = (catalog.smith || []).map(e => e.model);

    if (!engines.includes(selection.engine)) {
        return { ok: false, error: `"${selection.engine}" is not one of the offered base models.` };
    }
    if (selection.smith && !smiths.includes(selection.smith)) {
        return { ok: false, error: `"${selection.smith}" is not one of the offered improvement models.` };
    }

    const memory = budgetError(config, tiersFor(selection), {
        voice: selection.voice !== false,
        budget_gb: budgetGb(config, totalBytes)
    });
    if (memory) return { ok: false, error: memory };

    const disk = diskError(config, selection);
    if (disk) return { ok: false, error: disk };

    return { ok: true, error: null };
}

function describe(config, totalBytes) {
    const models = config.models || {};
    const catalog = models.catalog || {};
    const hardware = machine(config, totalBytes);
    const recommended = modelTiers.effective({ models: {
        hardware_defaults: models.hardware_defaults } }, totalBytes ?? modelTiers.totalMemory());
    const voice = models.voice || {};

    const annotate = (list, recommendedModel) => (list || []).map(entry => ({
        ...entry,
        downloaded: downloaded(entry.model),
        recommended: entry.model === recommendedModel
    }));

    return {
        machine: hardware,
        budget_gb: budgetGb(config, totalBytes),
        voice_reserve_gb: models.voice_reserve_gb ?? null,
        engines: annotate(catalog.engine, recommended.engine && recommended.engine.model),
        smiths: annotate(catalog.smith, recommended.smith && recommended.smith.model),
        voice: {
            stt: voice.stt
                ? { ...voice.stt, downloaded: downloaded(voice.stt.model) }
                : null,
            tts: voice.tts
                ? { ...voice.tts, downloaded: downloaded(voice.tts.model) }
                : null
        }
    };
}

module.exports = {
    describe, checkSelection, budgetError, tiersFor, downloaded,
    sizeOf, budgetGb, machine, repoDir
};
