const fs = require('fs');
const os = require('os');
const path = require('path');
const configReader = require('../utils/configReader');
const mailProvider = require('./mailProvider');
const modelTiers = require('./modelTiers');
const modelCatalog = require('./modelCatalog');
const profile = require('./profile');

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
            budget_gb: modelCatalog.budgetGb(config),
            voice_reserve_gb: models.voice_reserve_gb ?? null,
            measured_gb: models.measured_gb || {}
        },
        catalog: modelCatalog.describe(config),
        profile: profile.read(config)
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
    // The guard is not its own model: it always runs on the engine's
    // weights, so any engine edit carries the guard tier with it.
    if (tiers.guard && tiers.engine) {
        tiers.guard = { ...tiers.engine };
    }
    return tiers;
}

function catalogError(config, update) {
    const catalog = (config.models || {}).catalog || {};
    const offered = { engine: catalog.engine, smith: catalog.smith };
    for (const [name, list] of Object.entries(offered)) {
        const edit = update.tiers[name];
        if (!edit || edit.model === undefined || !Array.isArray(list) || !list.length) continue;
        if (!list.some(entry => entry.model === edit.model)) {
            return `"${edit.model}" is not one of the offered ${name} models.`;
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
            if (name === 'guard') {
                return 'The guard runs on the engine model; change the engine instead.';
            }
            if (spec.model !== undefined
                && (typeof spec.model !== 'string' || !MODEL_ID.test(spec.model))) {
                return `"${spec.model}" is not a valid model id.`;
            }
            if (spec.policy !== undefined && !POLICIES.includes(spec.policy)) {
                return `"${spec.policy}" is not a loading policy (${POLICIES.join(', ')}).`;
            }
        }
        const offered = catalogError(config, update);
        if (offered) return offered;
        // Until onboarding has recorded a choice, voice memory stays
        // reserved — the looser budget needs an explicit opt-out.
        const error = modelCatalog.budgetError(config, mergedTiers(config, update), {
            voice: config.profile ? profile.read(config).voice.enabled : true
        });
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
        if (config.models.tiers.guard && config.models.tiers.engine) {
            config.models.tiers.guard = { ...config.models.tiers.engine };
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
