// The tier table this machine actually runs. An explicit models.tiers in
// config wins outright; without one, the hardware_defaults table (config
// data keyed by nominal gigabytes) supplies the class this machine's memory
// reaches, rounding down, with the smallest class as a floor. The inference
// server makes the same choice in backend/inference/hardware.py — the table
// lives in config precisely so the two runtimes cannot drift apart.

const os = require('os');

const GB = 1024 ** 3;

function memoryClass(defaults, totalBytes) {
    const classes = Object.keys(defaults).map(Number).sort((a, b) => a - b);
    const nominal = totalBytes / GB;
    let chosen = classes[0];
    for (const cls of classes) {
        if (nominal + 0.5 >= cls) chosen = cls;
    }
    return chosen;
}

function totalMemory() {
    const pinned = Number(process.env.JARVIS_MEMORY_GB);
    return pinned > 0 ? pinned * GB : os.totalmem();
}

function effective(config, totalBytes) {
    const models = config.models || {};
    if (models.tiers) return models.tiers;
    const defaults = models.hardware_defaults;
    if (!defaults || !Object.keys(defaults).length) return {};
    const chosen = memoryClass(defaults, totalBytes ?? totalMemory());
    return defaults[String(chosen)] || {};
}

module.exports = { totalMemory, effective, memoryClass };
