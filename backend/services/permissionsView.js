// Everything this assistant is allowed to touch, on one surface: which
// skills can execute, write files or reach the network and whether the
// sandbox holds them to it; which sites and folders were granted; where mail
// goes; which chat the phone channel is bound to; what memory is doing. The
// dashboard invents no state — every line is read from the store that
// enforces it, so what it shows is what is actually permitted.

const fs = require('fs');
const channelAdapter = require('./channelAdapter');
const os = require('os');
const path = require('path');

const skillRegistry = require('./skillRegistry');
const skillSandbox = require('./skillSandbox');
const skillPins = require('./skillPins');
const securityStore = require('../security/store');
const mailProvider = require('./mailProvider');
const memoryService = require('./memoryService');

// A generated skill's pin has three honest states: verified against its pin,
// not yet pinned (it pins itself the first time it runs), or drifted — and
// only drift means the executor will refuse it.
function pinState(skill) {
    const checked = skillPins.verify(skill.name, skill.directory);
    if (checked.ok) return 'pinned';
    return checked.reason === 'unpinned' ? 'unpinned' : 'drifted';
}

function skillLines(enforceMode) {
    return skillRegistry.list().map(skill => {
        const generated = (skill.provenance || {}).author === 'generated';
        return {
            name: skill.name,
            author: (skill.provenance || {}).author || 'unknown',
            exec: skill.capabilities.exec === true,
            network: skill.capabilities.network === true,
            filesystem: skill.capabilities.filesystem || [],
            sandboxed: skillSandbox.shouldEnforce(skill, enforceMode),
            pin: generated ? pinState(skill) : null
        };
    });
}

function webLines(config) {
    return {
        sites: securityStore.grantedSites()
            .map(({ host, label, granted_ts }) => ({ host, label, granted_ts })),
        blocked_hosts: ((config.web || {}).blocked_hosts) || [],
        browser: (config.web || {}).desktop_browser || 'Google Chrome',
        headless: (config.web || {}).headless !== false
    };
}

function rootLines() {
    const byCollection = {};
    for (const row of securityStore.grantedRoots(null) || []) {
        const collection = row.collection || 'files';
        (byCollection[collection] = byCollection[collection] || [])
            .push({ path: row.path, granted_ts: row.granted_ts });
    }
    return byCollection;
}

function channelLines() {
    const state = channelAdapter.status();
    const chat = channelAdapter.boundChat();
    return {
        telegram: {
            enabled: state.enabled,
            bound_chat: chat ? String(chat) : null,
            token_present: state.has_token
        }
    };
}

function snapshot(config) {
    const enforceMode = (config.security || {}).enforce_capabilities || 'generated';
    return {
        generatedAt: new Date().toISOString(),
        enforce_mode: enforceMode,
        sandbox_available: fs.existsSync('/usr/bin/sandbox-exec'),
        skills: skillLines(enforceMode),
        web: webLines(config),
        roots: rootLines(),
        mail: {
            default: mailProvider.current(config).name,
            accounts: mailProvider.accounts(config)
                .map(({ account, name, label }) => ({ account, provider: name, label }))
        },
        channel: channelLines(config),
        memory: memoryService.status(),
        sandbox_root: path.join(os.homedir(), 'Jarvis_Sandbox')
    };
}

module.exports = { snapshot };
