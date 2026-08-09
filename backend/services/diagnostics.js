const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const traceStore = require('./traceStore');
const failureTaxonomy = require('./failureTaxonomy');

function expand(p) {
    if (p && p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
    return p;
}

function logsDir(config) {
    return expand(process.env.JARVIS_LOGS_DIR
        || (config.logs && config.logs.dir)
        || '~/.jarvis/logs');
}

function outputDir(config) {
    return expand(process.env.JARVIS_DIAGNOSTICS_DIR
        || (config.logs && config.logs.diagnostics_dir)
        || '~/.jarvis/diagnostics');
}

function systemReport() {
    const gb = bytes => (bytes / 1073741824).toFixed(1);
    return [
        `platform: ${os.platform()} ${os.release()} (${os.arch()})`,
        `node: ${process.version}`,
        `memory: ${gb(os.totalmem())} GB total, ${gb(os.freemem())} GB free`,
        `daemon uptime: ${Math.round(process.uptime())}s`,
        `machine uptime: ${Math.round(os.uptime())}s`,
        `collected: ${new Date().toISOString()}`
    ].join('\n') + '\n';
}

function collect(config) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = `jarvis-diagnostics-${stamp}`;
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-diagnostics-'));
    const bundle = path.join(staging, name);
    fs.mkdirSync(bundle);

    fs.writeFileSync(path.join(bundle, 'system.txt'), systemReport());
    fs.writeFileSync(path.join(bundle, 'config.json'), JSON.stringify(config, null, 2));

    let plans = [];
    try { plans = traceStore.recentPlans(50); } catch { }
    fs.writeFileSync(path.join(bundle, 'recent-plans.json'), JSON.stringify(plans, null, 2));

    fs.writeFileSync(path.join(bundle, 'failures.json'),
        JSON.stringify(failureTaxonomy.report(), null, 2));

    const logs = logsDir(config);
    const logsOut = path.join(bundle, 'logs');
    fs.mkdirSync(logsOut);
    if (fs.existsSync(logs)) {
        for (const file of fs.readdirSync(logs)) {
            if (!/\.log(\.1)?$/.test(file)) continue;
            fs.copyFileSync(path.join(logs, file), path.join(logsOut, file));
        }
    }

    const out = outputDir(config);
    fs.mkdirSync(out, { recursive: true });
    const zipPath = path.join(out, `${name}.zip`);
    execFileSync('zip', ['-r', '-q', zipPath, name], { cwd: staging });
    fs.rmSync(staging, { recursive: true, force: true });
    return { path: zipPath };
}

module.exports = { collect };
