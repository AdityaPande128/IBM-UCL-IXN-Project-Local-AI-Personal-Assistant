const path = require('path');
const os = require('os');
const fs = require('fs');

const SANDBOX_ROOT = path.join(os.homedir(), 'Jarvis_Sandbox');

function resolvePath(targetPath) {
    const resolvedPath = path.resolve(targetPath);

    if (resolvedPath !== SANDBOX_ROOT && !resolvedPath.startsWith(SANDBOX_ROOT + path.sep)) {
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
