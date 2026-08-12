// Who is using this assistant and how they chose to run it. The profile is
// plain config data: a name, the executor mode, the theme, whether the
// improvement loop is on, and what voice was chosen. Its absence is the
// signal that onboarding has never finished on this machine.

const fs = require('fs');
const configReader = require('../utils/configReader');

const MODES = ['jarvis', 'openclaw'];
const THEMES = ['dark', 'light'];
const MAX_NAME = 80;

function read(config) {
    const stored = (config || configReader.readConfig()).profile || {};
    const voice = stored.voice || {};
    return {
        name: typeof stored.name === 'string' ? stored.name : '',
        mode: MODES.includes(stored.mode) ? stored.mode : 'jarvis',
        theme: THEMES.includes(stored.theme) ? stored.theme : 'dark',
        improvement: stored.improvement === true,
        voice: { enabled: voice.enabled === true, tts: voice.tts === true },
        onboarded: stored.onboarded === true
    };
}

// Mode is read per intent, not at boot, so switching executors never needs
// a restart.
function current() {
    return read(configReader.readConfig());
}

// Improvement is only off when a profile exists and says so. A machine that
// never ran onboarding keeps the full pipeline — turning features off must
// be a recorded choice, not a missing file.
function improvementEnabled() {
    const config = configReader.readConfig();
    return config.profile ? read(config).improvement : true;
}

function validate(update) {
    if (update.name !== undefined) {
        if (typeof update.name !== 'string' || !update.name.trim()) {
            return 'A name is needed.';
        }
        if (update.name.trim().length > MAX_NAME) {
            return `A name can be at most ${MAX_NAME} characters.`;
        }
    }
    if (update.mode !== undefined && !MODES.includes(update.mode)) {
        return `"${update.mode}" is not a mode (${MODES.join(', ')}).`;
    }
    if (update.theme !== undefined && !THEMES.includes(update.theme)) {
        return `"${update.theme}" is not a theme (${THEMES.join(', ')}).`;
    }
    if (update.improvement !== undefined && typeof update.improvement !== 'boolean') {
        return 'improvement must be true or false.';
    }
    if (update.voice !== undefined) {
        if (typeof update.voice !== 'object' || update.voice === null) {
            return 'The voice update is malformed.';
        }
        for (const key of ['enabled', 'tts']) {
            if (update.voice[key] !== undefined && typeof update.voice[key] !== 'boolean') {
                return `voice.${key} must be true or false.`;
            }
        }
    }
    return null;
}

function apply(update) {
    const error = validate(update);
    if (error) return { status: 'invalid', error };

    const config = configReader.readConfig();
    const existing = config.profile || {};
    const profile = { ...existing };

    if (update.name !== undefined) profile.name = update.name.trim();
    if (update.mode !== undefined) profile.mode = update.mode;
    if (update.theme !== undefined) profile.theme = update.theme;
    if (update.improvement !== undefined) profile.improvement = update.improvement;
    if (update.voice !== undefined) {
        profile.voice = { ...(existing.voice || {}), ...update.voice };
    }
    if (update.onboarded !== undefined) profile.onboarded = update.onboarded === true;

    config.profile = profile;
    fs.writeFileSync(configReader.configPath(), JSON.stringify(config, null, 2) + '\n');
    return { status: 'applied', profile: read(config) };
}

module.exports = { read, current, improvementEnabled, validate, apply, MODES, THEMES };
