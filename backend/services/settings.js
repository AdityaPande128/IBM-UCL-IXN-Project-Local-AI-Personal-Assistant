const fs = require('fs');
const os = require('os');
const path = require('path');
const configReader = require('../utils/configReader');
const mailProvider = require('./mailProvider');
const modelTiers = require('./modelTiers');

const POLICIES = ['pinned', 'resident', 'transient'];
const KNOWN_BROWSERS = ['Google Chrome', 'Brave Browser', 'Microsoft Edge', 'Chromium'];
const MODEL_ID = /^[\w./-]+$/;

function installedBrowsers(current) {
    const found = KNOWN_BROWSERS.filter(name =>
        fs.existsSync(`/Applications/${name}.app`)
        || fs.existsSync(path.join(os.homedir(), 'Applications', `${name}.app`)));
    if (current && !found.includes(current)) found.unshift(current);
    return found;
}

function describe(config) {
    const current = (config.web && config.web.desktop_browser) || 'Google Chrome';
    const models = config.models || {};
    return {
        browser: { current, installed: installedBrowsers(current) },
        mail: {
            current: mailProvider.current(config).name,
            available: Object.entries(mailProvider.PROVIDERS)
                .map(([name, spec]) => ({ name, label: spec.label })),
            accounts: mailProvider.accounts(config)
                .map(({ account, name, label }) => ({ account, provider: name, label }))
        },
        budget: {
            budget_gb: models.budget_gb ?? null,
            voice_reserve_gb: models.voice_reserve_gb ?? null,
            measured_gb: models.measured_gb || {}
        }
    };
}

function mergedTiers(config, update) {
    const tiers = {};
    for (const [name, spec] of Object.entries(modelTiers.effective(config))) {
        const edit = (update.tiers && update.tiers[name]) || {};
        tiers[name] = {
            model: edit.model !== undefined ? edit.model : spec.model,
            policy: edit.policy !== undefined ? edit.policy : spec.policy
        };
    }
    return tiers;
}

function budgetError(config, tiers) {
    const models = config.models || {};
    if (typeof models.budget_gb !== 'number') return null;
    const measured = models.measured_gb || {};
    const available = models.budget_gb - (models.voice_reserve_gb || 0);
    const size = model => measured[model];

    let base = 0;
    for (const spec of Object.values(tiers)) {
        if (spec.policy !== 'transient' && size(spec.model) !== undefined) {
            base += size(spec.model);
        }
    }
    if (base > available) {
        return `The always-loaded models need ${base.toFixed(1)} GB together `
            + `but only ${available.toFixed(1)} GB is available for models.`;
    }

    let pinned = 0;
    for (const spec of Object.values(tiers)) {
        if (spec.policy === 'pinned' && size(spec.model) !== undefined) {
            pinned += size(spec.model);
        }
    }
    for (const [name, spec] of Object.entries(tiers)) {
        if (spec.policy !== 'transient' || size(spec.model) === undefined) continue;
        if (pinned + size(spec.model) > available) {
            return `Loading the ${name} model alongside the pinned one needs `
                + `${(pinned + size(spec.model)).toFixed(1)} GB but only `
                + `${available.toFixed(1)} GB is available for models.`;
        }
    }
    return null;
}

function validate(config, update) {
    if (update.tiers !== undefined) {
        if (typeof update.tiers !== 'object' || update.tiers === null) {
            return 'The tier update is malformed.';
        }
        const known = modelTiers.effective(config);
        for (const [name, spec] of Object.entries(update.tiers)) {
            if (!known[name]) return `There is no "${name}" model tier.`;
            if (spec.model !== undefined
                && (typeof spec.model !== 'string' || !MODEL_ID.test(spec.model))) {
                return `"${spec.model}" is not a valid model id.`;
            }
            if (spec.policy !== undefined && !POLICIES.includes(spec.policy)) {
                return `"${spec.policy}" is not a loading policy (${POLICIES.join(', ')}).`;
            }
        }
        const error = budgetError(config, mergedTiers(config, update));
        if (error) return error;
    }

    if (update.desktop_browser !== undefined) {
        const current = (config.web && config.web.desktop_browser) || 'Google Chrome';
        if (!installedBrowsers(current).includes(update.desktop_browser)) {
            return `${update.desktop_browser} is not installed on this Mac.`;
        }
    }

    if (update.mail_provider !== undefined && !mailProvider.PROVIDERS[update.mail_provider]) {
        return `"${update.mail_provider}" is not a supported mail provider.`;
    }

    return null;
}

function apply(update) {
    const config = configReader.readConfig();
    const error = validate(config, update);
    if (error) return { status: 'invalid', error };

    if (update.tiers) {
        // Editing a tier pins the whole table: hardware defaults become an
        // explicit models.tiers, and stay explicit from then on.
        if (!config.models) config.models = {};
        if (!config.models.tiers) {
            config.models.tiers = structuredClone(modelTiers.effective(config));
        }
        for (const [name, spec] of Object.entries(update.tiers)) {
            if (spec.model !== undefined) config.models.tiers[name].model = spec.model;
            if (spec.policy !== undefined) config.models.tiers[name].policy = spec.policy;
        }
    }
    if (update.desktop_browser !== undefined) {
        if (!config.web) config.web = {};
        config.web.desktop_browser = update.desktop_browser;
    }
    if (update.mail_provider !== undefined) {
        if (!config.mail) config.mail = {};
        config.mail.provider = update.mail_provider;
    }

    fs.writeFileSync(configReader.configPath(), JSON.stringify(config, null, 2) + '\n');
    return { status: 'applied' };
}

module.exports = { describe, apply };
