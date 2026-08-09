const fs = require('fs/promises');
const { resolvePath } = require('../middleware/pathValidator');

async function safeReadFile(targetPath, options = 'utf-8') {
    const safePath = resolvePath(targetPath);
    return await fs.readFile(safePath, options);
}

async function safeWriteFile(targetPath, data, options) {
    const safePath = resolvePath(targetPath);
    return await fs.writeFile(safePath, data, options);
}

async function safeReaddir(targetPath, options) {
    const safePath = resolvePath(targetPath);
    return await fs.readdir(safePath, options);
}

module.exports = {
    safeReadFile,
    safeWriteFile,
    safeReaddir
};
