const path = require('path');
const os = require('os');
const fs = require('fs');

const SANDBOX_ROOT = path.join(os.homedir(), 'Jarvis_Sandbox');

// Lexical containment alone is fooled by a symlink planted inside the
// sandbox; what must sit under the root is where the path really leads.
function realpathOfDeepest(target) {
    let probe = target;
    const tail = [];
    for (;;) {
        try {
            return path.join(fs.realpathSync(probe), ...tail.reverse());
        } catch {
            const parent = path.dirname(probe);
            if (parent === probe) return target;
            tail.push(path.basename(probe));
            probe = parent;
        }
    }
}

function resolvePath(targetPath) {
    const resolvedPath = path.resolve(targetPath);
    const rootReal = realpathOfDeepest(SANDBOX_ROOT);
    const real = realpathOfDeepest(resolvedPath);

    const contained = (candidate) =>
        candidate === rootReal || candidate.startsWith(rootReal + path.sep);

    if (!contained(real)) {
        const errorMsg = `[SECURITY_EXCEPTION] Access denied. Path traversal attempted outside sandbox: ${resolvedPath}`;
        console.error(errorMsg);
        throw new Error(errorMsg);
    }

    return resolvedPath;
}

function verifySandboxInitialized() {
    console.log(`[BOOT] Verifying Jarvis Sandbox at: ${SANDBOX_ROOT}`);
    if (!fs.existsSync(SANDBOX_ROOT)) {
        console.log(`[BOOT] Sandbox directory missing. Creating ${SANDBOX_ROOT}`);
        fs.mkdirSync(SANDBOX_ROOT, { recursive: true });
    }
    console.log(`[BOOT] Sandbox initialized successfully.`);
}

module.exports = {
    SANDBOX_ROOT,
    resolvePath,
    verifySandboxInitialized
};
