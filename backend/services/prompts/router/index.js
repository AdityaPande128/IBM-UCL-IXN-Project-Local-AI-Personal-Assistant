const fs = require('fs');
const path = require('path');

function slug(modelId) {
    return String(modelId).split('/').pop().toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function load(name, modelId) {
    const file = name === 'v1'
        ? path.join(__dirname, `v1-${slug(modelId)}.js`)
        : path.join(__dirname, `${name}.js`);
    if (!fs.existsSync(file)) {
        throw new Error(name === 'v1'
            ? `no model-specific prompt for ${modelId}; expected ${path.basename(file)}`
            : `unknown prompt variant "${name}"`);
    }
    return require(file);
}

function available() {
    return fs.readdirSync(__dirname)
        .filter(f => /^v\d.*\.js$/.test(f)).map(f => f.replace(/\.js$/, '')).sort();
}

module.exports = { load, slug, available };
