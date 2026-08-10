// A skill crosses the border between machines, or between agents, as a signed
// pack: every file it is made of, the same content hash the pin store uses,
// and an Ed25519 signature over that hash. Nothing in the pack is trusted on
// import — the hash is recomputed from the carried files, the signature is
// checked against the carried key, and the skill's own authored tests are
// re-run in the sandbox. Only a pack that survives all three installs, and it
// is pinned at that moment, so the checks that guarded it here guard it there.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const skillRegistry = require('./skillRegistry');
const skillPins = require('./skillPins');
const skillVerifier = require('./skillVerifier');

const FORMAT = 'jarvis-skill-pack/1';
const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_PACK_FILES = 40;
const MAX_PACK_BYTES = 2 * 1024 * 1024;

const KEY_PATH = path.join(os.homedir(), '.jarvis', 'skill-signing.json');
const PACKS_DIR = path.join(os.homedir(), 'Jarvis_Sandbox', 'skill-packs');


function signingKeys(keyPath = KEY_PATH) {
    try {
        const stored = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
        if (stored.publicKey && stored.privateKey) return stored;
    } catch { }

    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const keys = {
        publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
        privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' })
    };
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 });
    return keys;
}

function fingerprint(publicKeyPem) {
    const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
    return crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
}


function readFiles(directory) {
    const files = {};
    let total = 0;
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isSymbolicLink()) {
                // A pack materializes as regular files, so a symlink could
                // never round-trip to the hash the pin took here.
                throw new Error('the skill contains a symlink, which cannot travel in a pack');
            }
            if (entry.isDirectory()) { walk(full); continue; }
            if (!entry.isFile()) continue;
            const buffer = fs.readFileSync(full);
            total += buffer.length;
            if (Object.keys(files).length >= MAX_PACK_FILES || total > MAX_PACK_BYTES) {
                throw new Error('the skill directory is too large to travel as a pack');
            }
            const relative = path.relative(directory, full);
            const text = buffer.toString('utf8');
            // Text files travel readably; anything that does not survive the
            // round trip travels as base64 so the hash still holds.
            files[relative] = Buffer.from(text, 'utf8').equals(buffer)
                ? { text }
                : { base64: buffer.toString('base64') };
        }
    };
    walk(directory);
    return files;
}

function fileBuffer(entry) {
    if (entry && typeof entry.text === 'string') return Buffer.from(entry.text, 'utf8');
    if (entry && typeof entry.base64 === 'string') return Buffer.from(entry.base64, 'base64');
    return null;
}

function safeRelative(relative) {
    if (typeof relative !== 'string' || !relative || relative.includes('\0')) return false;
    if (path.isAbsolute(relative)) return false;
    const segments = relative.split(/[\\/]/);
    return segments.every(s => s && s !== '.' && s !== '..');
}


function exportPack(name, options = {}) {
    const skill = skillRegistry.get(name);
    if (!skill) return { status: 'unknown_skill', name };

    let files;
    try {
        files = readFiles(skill.directory);
    } catch (err) {
        return { status: 'refused', name: skill.name, reason: err.message };
    }

    const hash = skillPins.hashDirectory(skill.directory);
    const keys = signingKeys(options.keyPath);
    const signature = crypto.sign(null, Buffer.from(hash, 'utf8'),
        crypto.createPrivateKey(keys.privateKey)).toString('base64');

    const pack = {
        format: FORMAT,
        name: skill.name,
        version: skill.version,
        description: skill.description,
        provenance: skill.provenance,
        files,
        hash,
        signature,
        publicKey: keys.publicKey,
        exportedAt: new Date().toISOString()
    };

    const destDir = options.destDir || PACKS_DIR;
    fs.mkdirSync(destDir, { recursive: true });
    const packPath = path.join(destDir, `${skill.name}.jarvispack.json`);
    fs.writeFileSync(packPath, JSON.stringify(pack, null, 2) + '\n');

    return {
        status: 'exported', name: skill.name, version: skill.version,
        path: packPath, hash, signer: fingerprint(keys.publicKey)
    };
}


function parsePack(packPath) {
    let pack;
    try {
        pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));
    } catch (err) {
        return { error: `the pack could not be read: ${err.message}` };
    }
    if (pack.format !== FORMAT) return { error: `not a ${FORMAT} pack` };
    if (!SKILL_NAME.test(String(pack.name || ''))) return { error: 'the pack names no valid skill' };
    if (!pack.files || typeof pack.files !== 'object' || Array.isArray(pack.files)) {
        return { error: 'the pack carries no files' };
    }
    const names = Object.keys(pack.files);
    if (!names.length || names.length > MAX_PACK_FILES) return { error: 'the pack carries no usable files' };
    for (const relative of names) {
        if (!safeRelative(relative)) return { error: `unsafe path in pack: "${relative}"` };
        if (!fileBuffer(pack.files[relative])) return { error: `unreadable file in pack: "${relative}"` };
    }
    if (typeof pack.hash !== 'string' || typeof pack.signature !== 'string'
        || typeof pack.publicKey !== 'string') {
        return { error: 'the pack is missing its hash or signature' };
    }
    return { pack };
}

function materialize(pack, targetDir) {
    let total = 0;
    for (const [relative, entry] of Object.entries(pack.files)) {
        const buffer = fileBuffer(entry);
        total += buffer.length;
        if (total > MAX_PACK_BYTES) throw new Error('the pack is too large to install');
        const target = path.join(targetDir, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, buffer);
    }
}

function scriptFileOf(manifest, files) {
    for (const part of (manifest.exec && manifest.exec.argv) || []) {
        const match = String(part).match(/\{\{\s*__dir__\s*\}\}\/(.+)$/);
        if (match && files[match[1]] !== undefined) return match[1];
    }
    return null;
}

async function importPack(packPath, options = {}) {
    const { pack, error } = parsePack(packPath);
    if (error) return { status: 'refused', reason: error };

    const skillsDir = options.skillsDir || skillRegistry.SKILLS_DIR;

    // 1. The carried files must produce the hash the pack claims.
    const staging = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-import-')));
    try {
        try {
            materialize(pack, staging);
        } catch (err) {
            return { status: 'refused', name: pack.name, reason: err.message };
        }
        const hash = skillPins.hashDirectory(staging);
        if (hash !== pack.hash) {
            return { status: 'refused', name: pack.name,
                reason: 'the files do not match the hash the pack claims — it has been altered' };
        }

        // 2. The signature must hold over that hash with the carried key.
        let verified = false;
        try {
            verified = crypto.verify(null, Buffer.from(pack.hash, 'utf8'),
                crypto.createPublicKey(pack.publicKey),
                Buffer.from(pack.signature, 'base64'));
        } catch { }
        if (!verified) {
            return { status: 'refused', name: pack.name,
                reason: 'the signature does not verify — the pack was not signed by the key it carries' };
        }

        // 3. The manifest must be a valid skill, under the name the pack claims.
        const manifestEntry = pack.files['SKILL.md'];
        if (!manifestEntry) return { status: 'refused', name: pack.name, reason: 'no SKILL.md in the pack' };
        const split = skillRegistry.splitFrontmatter(fileBuffer(manifestEntry).toString('utf8'));
        if (!split) return { status: 'refused', name: pack.name, reason: 'SKILL.md has no frontmatter' };
        let manifest;
        try {
            manifest = yaml.load(split.frontmatter) || {};
        } catch (err) {
            return { status: 'refused', name: pack.name, reason: `SKILL.md did not parse: ${err.message}` };
        }
        const check = skillRegistry.validateManifest(manifest, pack.name);
        if (!check.valid) {
            return { status: 'refused', name: pack.name,
                reason: `the manifest is invalid: ${check.errors.join('; ')}` };
        }

        // 4. The skill's own tests must pass again, here, in the sandbox.
        const scriptFile = scriptFileOf(manifest, pack.files);
        const testsEntry = pack.files['test.json'];
        if (!scriptFile || !testsEntry) {
            return { status: 'refused', name: pack.name,
                reason: 'only script skills whose authored tests travel with them can be imported' };
        }
        let tests;
        try {
            tests = JSON.parse(fileBuffer(testsEntry).toString('utf8'));
        } catch (err) {
            return { status: 'refused', name: pack.name, reason: `test.json did not parse: ${err.message}` };
        }
        const script = fileBuffer(pack.files[scriptFile]).toString('utf8');
        const verification = await skillVerifier.verify(
            script, tests, Object.keys(manifest.parameters || {}), options.timeoutMs ?? 30000);
        if (!verification.passed) {
            return { status: 'refused', name: pack.name,
                reason: `the skill failed its own tests on this machine: ${verification.summary}` };
        }

        // 5. Install, pin at the verified hash, and let the registry judge it.
        const target = path.join(skillsDir, pack.name);
        if (fs.existsSync(target)) {
            if (skillPins.hashDirectory(target) === pack.hash) {
                return { status: 'already_installed', name: pack.name, version: pack.version };
            }
            if (!options.replace) {
                return { status: 'refused', name: pack.name,
                    reason: `a different skill named "${pack.name}" is already installed` };
            }
            fs.rmSync(target, { recursive: true, force: true });
        }

        fs.cpSync(staging, target, { recursive: true });
        skillPins.pin(pack.name, target, String(manifest.version));

        // The registry has the last word — but only when installing into the
        // directory it actually reads.
        if (skillsDir === skillRegistry.SKILLS_DIR) {
            skillRegistry.reload();
            if (!skillRegistry.get(pack.name)) {
                fs.rmSync(target, { recursive: true, force: true });
                skillPins.remove(pack.name);
                skillRegistry.reload();
                return { status: 'refused', name: pack.name,
                    reason: 'the registry rejected the installed skill' };
            }
        }

        return {
            status: 'installed', name: pack.name, version: String(manifest.version),
            hash: pack.hash, signer: fingerprint(pack.publicKey),
            tests: verification.summary
        };
    } finally {
        fs.rmSync(staging, { recursive: true, force: true });
    }
}


// The wrapper that makes an installed skill callable from OpenClaw. It is
// instructions, not code: OpenClaw's agent is told to run the shim, and the
// shim re-checks the pin and rebuilds the sandbox before anything executes —
// the checks travel with the skill instead of stopping at the border (F30).
function wrapperManifest(skill, shimPath) {
    const params = Object.entries(skill.parameters || {});
    const example = params
        .map(([name, spec]) => `--${name} "<${spec.description || name}>"`)
        .join(' ');
    const documented = params.length
        ? params.map(([name, spec]) =>
            `- \`--${name}\`${spec.required ? ' (required)' : ''}: ${spec.description || 'no description'}`)
            .join('\n')
        : '- none';

    return `---
name: ${skill.name}
description: ${skill.description} A verified Jarvis skill; run it through the Jarvis shim.
---

# ${skill.name} — a Jarvis-built skill

This capability was generated, tested and installed by Jarvis. Use the exec
tool to run it through the Jarvis shim:

    node "${shimPath}" ${skill.name} ${example}

## Parameters

${documented}

## Rules

- Always invoke the shim, never any script directly. The shim re-checks the
  skill's content hash against the pin recorded when it was verified, and runs
  it inside the sandbox profile derived from its declared capabilities.
- If the shim reports the skill has drifted or refuses to run, stop and tell
  the user; do not work around it.
- Pass only the parameters listed above, each value quoted.
`;
}

function exportWrapper(name, options = {}) {
    const skill = skillRegistry.get(name);
    if (!skill) return { status: 'unknown_skill', name };

    const shimPath = options.shimPath || path.resolve(__dirname, '..', 'tools', 'skill-shim.js');
    const workspaceDir = options.workspaceDir
        || path.join(os.homedir(), '.openclaw', 'workspace', 'skills');

    const target = path.join(workspaceDir, skill.name);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'SKILL.md'), wrapperManifest(skill, shimPath));

    return { status: 'exported', name: skill.name, path: target };
}

module.exports = {
    exportPack, importPack, exportWrapper, signingKeys, fingerprint,
    parsePack, safeRelative, wrapperManifest,
    FORMAT, KEY_PATH, PACKS_DIR
};
