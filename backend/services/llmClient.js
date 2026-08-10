const http = require('http');
const configReader = require('../utils/configReader');

const config = configReader.readConfig();

const TIER_SETTINGS = {
    guard: config.router || {},
    engine: config.engine || {},
    smith: config.generation || {}
};

function modelForTier(tier) {
    return ((config.models || {}).tiers || {})[tier]?.model || null;
}

function complete(messages, opts = {}) {
    const tier = opts.tier;
    const defaults = (tier && TIER_SETTINGS[tier]) || {};

    const model = opts.model || tier || defaults.model;
    const temperature = opts.temperature ?? defaults.temperature ?? 0;
    const max_tokens = opts.max_tokens ?? defaults.max_tokens ?? 300;
    const timeout_ms = opts.timeout_ms ?? defaults.timeout_ms ?? 30000;

    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({
            model, messages, temperature, max_tokens,
            ...(opts.response_format ? { response_format: opts.response_format } : {})
        });

        const req = http.request({
            hostname: '127.0.0.1',
            port: config.ports.inference,
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            },
            timeout: timeout_ms
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.error) return reject(new Error(`inference_error: ${json.error}`));
                    const content = json.choices?.[0]?.message?.content;
                    if (typeof content !== 'string') {
                        return reject(new Error('inference_error: no content in response'));
                    }
                    resolve(content);
                } catch (err) {
                    reject(new Error(`transport_error: ${err.message}`));
                }
            });
        });

        req.on('error', err => reject(new Error(`transport_error: ${err.message}`)));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('timeout'));
        });
        req.write(payload);
        req.end();
    });
}

module.exports = { complete, modelForTier, TIER_SETTINGS };
