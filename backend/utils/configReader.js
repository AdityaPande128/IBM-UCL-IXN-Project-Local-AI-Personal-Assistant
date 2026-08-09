const path = require('path');
const fs = require('fs');

function readConfig() {
    try {
        const possiblePaths = [
            path.resolve(__dirname, '../../config.json'),
            path.resolve(__dirname, '../config.json'),
            path.resolve(__dirname, './config.json')
        ];

        for (const configPath of possiblePaths) {
            if (fs.existsSync(configPath)) {
                return JSON.parse(fs.readFileSync(configPath, 'utf8'));
            }
        }
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

module.exports = { readConfig };
