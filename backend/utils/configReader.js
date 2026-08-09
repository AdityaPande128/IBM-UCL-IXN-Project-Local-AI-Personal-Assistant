const path = require('path');
const fs = require('fs');

function configPath() {
    if (process.env.JARVIS_CONFIG_PATH) return process.env.JARVIS_CONFIG_PATH;

    const possiblePaths = [
        path.resolve(__dirname, '../../config.json'),
        path.resolve(__dirname, '../config.json'),
        path.resolve(__dirname, './config.json')
    ];

    for (const candidate of possiblePaths) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return possiblePaths[0];
}

function readConfig() {
    try {
        return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    } catch (e) {
        console.error("[ConfigReader] Error reading config.json:", e);
    }

    return {
        model_id: "mlx-community/granite-4.1-8b-4bit",
        ports: {
            backend: 8080,
            inference: 8787,
            openclaw: 18789
        }
    };
}

module.exports = { readConfig, configPath };
