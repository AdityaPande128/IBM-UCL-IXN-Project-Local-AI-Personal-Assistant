const http = require('http');
const configReader = require('../utils/configReader');
const intentQueue = require('./intentQueue');
const modelTiers = require('./modelTiers');

const config = configReader.readConfig();

const INFERENCE = new URL(process.env.INFERENCE_URL
    || `http://127.0.0.1:${(config.ports || {}).inference || 8787}`);

const TIER_SETTINGS = {
    guard: config.router || {},
    engine: config.engine || {},
    smith: config.generation || {}
};

function modelForTier(tier) {
    return modelTiers.effective(config)[tier]?.model || null;
}

function complete(messages, opts = {}) {
    const tier = opts.tier;
    const defaults = (tier && TIER_SETTINGS[tier]) || {};

    const studyTier = tier && process.env[`JARVIS_STUDY_TIER_${tier.toUpperCase()}`];
    const model = opts.model || studyTier || tier || defaults.model;
    const temperature = opts.temperature ?? defaults.temperature ?? 0;
    const max_tokens = opts.max_tokens ?? defaults.max_tokens ?? 300;
    const timeout_ms = opts.timeout_ms ?? defaults.timeout_ms ?? 30000;

    const startedAt = Date.now();
    const shape = opts.response_format ? 'json' : 'plain';

    // A Stop should not wait out an in-flight generation: drop the request
    // the moment the surrounding job's signal fires.
    const signal = opts.signal || intentQueue.currentSignal();
    const stopped = () => {
        const err = new Error('aborted');
        err.aborted = true;
        return err;
    };
    if (signal && signal.aborted) return Promise.reject(stopped());

    return new Promise((resolve, reject) => {
        let onAbort = null;
        const settle = (fn) => (value) => {
            if (onAbort) signal.removeEventListener('abort', onAbort);
            fn(value);
        };
        if (signal) {
            resolve = settle(resolve);
            reject = settle(reject);
        }
        const payload = JSON.stringify({
            model, messages, temperature, max_tokens,
            ...(opts.response_format ? { response_format: opts.response_format } : {}),
            ...(opts.seed !== undefined ? { seed: opts.seed } : {})
        });

        const req = http.request({
            hostname: INFERENCE.hostname,
            port: Number(INFERENCE.port) || 80,
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
                    console.log(`[LLM] ${model} ${shape} ${Date.now() - startedAt}ms`);
                    resolve(content);
                } catch (err) {
                    reject(new Error(`transport_error: ${err.message}`));
                }
            });
        });

        if (signal) {
            onAbort = () => {
                reject(stopped());
                req.destroy();
            };
            signal.addEventListener('abort', onAbort, { once: true });
        }

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
