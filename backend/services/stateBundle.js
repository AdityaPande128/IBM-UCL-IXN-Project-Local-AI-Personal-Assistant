// The user's Jarvis state as one portable file: every store the checkpoint
// layer snapshots, plus the generated skills, under a hash manifest, packed
// as a tar.gz. Import proves the manifest before touching anything, then
// stages a restore exactly the way checkpoints do — applied on the next
// boot, with the displaced state checkpointed first.
//
// Secrets never travel: the browser profile, the telegram token and the
// skill-signing key stay on the machine they belong to.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const checkpoints = require('./checkpoints');
const skillRegistry = require('./skillRegistry');

const FORMAT = 'jarvis-state-bundle/1';
const DEFAULT_DIR = path.join(os.homedir(), '.jarvis', 'bundles');
const MAX_MEMBERS = 5000;

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function walkFiles(dir, base, out) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = path.join(base, entry.name);
        if (entry.isDirectory()) walkFiles(full, rel, out);
        else if (entry.isFile()) out.push({ full, rel });
    }
    return out;
}

function exportBundle({ destDir = DEFAULT_DIR, dataDir } = {}) {
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-bundle-'));
    try {
        const files = dataDir
            ? checkpoints.snapshotInto(staging, dataDir)
            : checkpoints.snapshotInto(staging);

        // Generated skills are state the user grew; built-ins ship with the app.
        for (const skill of skillRegistry.list()) {
            if ((skill.provenance || {}).author !== 'generated') continue;
            for (const { full, rel } of walkFiles(skill.directory,
                path.join('skills', skill.name), [])) {
                const target = path.join(staging, rel);
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.copyFileSync(full, target);
                files[rel] = sha256(target);
            }
        }

        const manifest = {
            format: FORMAT,
            createdAt: new Date().toISOString(),
            host: os.hostname(),
            files
        };
        fs.writeFileSync(path.join(staging, 'bundle-manifest.json'),
            JSON.stringify(manifest, null, 2) + '\n');

        fs.mkdirSync(destDir, { recursive: true });
        const out = path.join(destDir,
            `jarvis-state-${manifest.createdAt.replace(/[:.]/g, '-')}.tar.gz`);
        execFileSync('/usr/bin/tar', ['-czf', out, '-C', staging, '.']);

        return { status: 'exported', path: out, files: Object.keys(files).length };
    } finally {
        fs.rmSync(staging, { recursive: true, force: true });
    }
}

function membersOf(bundlePath) {
    return execFileSync('/usr/bin/tar', ['-tzf', bundlePath], { encoding: 'utf8' })
        .split('\n').map(m => m.trim()).filter(Boolean);
}

function unsafeMember(member) {
    const clean = member.replace(/^\.\//, '');
    if (!clean || clean === '.') return false;
    if (path.isAbsolute(clean)) return true;
    return clean.split('/').some(part => part === '..');
}

function importBundle(bundlePath, { checkpointRoot } = {}) {
    if (!fs.existsSync(bundlePath)) {
        return { status: 'refused', reason: 'no such bundle file' };
    }

    let members;
    try {
        members = membersOf(bundlePath);
    } catch (err) {
        return { status: 'refused', reason: `not a readable archive: ${err.message}` };
    }
    if (members.length > MAX_MEMBERS) {
        return { status: 'refused', reason: 'the archive carries too many files' };
    }
    const unsafe = members.find(unsafeMember);
    if (unsafe) {
        return { status: 'refused', reason: `unsafe path in the archive: "${unsafe}"` };
    }

    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-import-'));
    try {
        execFileSync('/usr/bin/tar', ['-xzf', bundlePath, '-C', staging]);

        let manifest;
        try {
            manifest = JSON.parse(
                fs.readFileSync(path.join(staging, 'bundle-manifest.json'), 'utf8'));
        } catch {
            return { status: 'refused', reason: 'the bundle carries no readable manifest' };
        }
        if (manifest.format !== FORMAT) {
            return { status: 'refused', reason: `not a ${FORMAT} bundle` };
        }

        for (const [rel, hash] of Object.entries(manifest.files || {})) {
            const target = path.join(staging, rel);
            if (!fs.existsSync(target)) {
                return { status: 'refused', reason: `the bundle is missing "${rel}"` };
            }
            if (sha256(target) !== hash) {
                return { status: 'refused',
                    reason: `"${rel}" does not match its hash — the bundle has been altered` };
            }
        }

        // The verified bundle becomes a checkpoint, and the restore rides the
        // same stage-then-apply-at-boot path every checkpoint restore takes.
        const root = checkpointRoot || checkpoints.rootDir();
        checkpoints.open(root);
        const name = `imported-${manifest.createdAt.replace(/[:.]/g, '-')}`;
        const dir = path.join(root, name);
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });

        const files = {};
        for (const rel of Object.keys(manifest.files)) {
            const target = path.join(dir, rel);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(path.join(staging, rel), target);
            files[rel] = manifest.files[rel];
        }
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
            format: 'jarvis-checkpoint/1',
            name,
            createdAt: new Date().toISOString(),
            label: 'imported-bundle',
            files
        }, null, 2) + '\n');

        return checkpoints.restore(name);
    } finally {
        fs.rmSync(staging, { recursive: true, force: true });
    }
}

module.exports = { exportBundle, importBundle, unsafeMember, FORMAT, DEFAULT_DIR };
