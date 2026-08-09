const ORIGIN = {
    USER: 'user',
    SYSTEM: 'system',
    FILE: 'local-file',
    APP: 'app',
    WEB: 'web',
    GENERATED: 'generated'
};

const ORIGINS = new Set(Object.values(ORIGIN));

const SENSITIVITY = {
    PUBLIC: 'public',
    PERSONAL: 'personal',
    SECRET: 'secret'
};

const SENSITIVITY_RANK = {
    [SENSITIVITY.PUBLIC]: 0,
    [SENSITIVITY.PERSONAL]: 1,
    [SENSITIVITY.SECRET]: 2
};

const INSTRUCTION_ORIGINS = new Set([ORIGIN.USER, ORIGIN.SYSTEM]);

const UNKNOWN = Object.freeze({
    origins: Object.freeze([ORIGIN.FILE]),
    sensitivity: SENSITIVITY.PERSONAL
});

function normaliseSensitivity(value) {
    return Object.prototype.hasOwnProperty.call(SENSITIVITY_RANK, value)
        ? value
        : SENSITIVITY.PERSONAL;
}

function normaliseOrigins(value) {
    const list = Array.isArray(value) ? value : [value];
    const kept = [...new Set(list.filter(o => ORIGINS.has(o)))].sort();
    return kept.length ? kept : [ORIGIN.FILE];
}

function label(origins, sensitivity) {
    return Object.freeze({
        origins: Object.freeze(normaliseOrigins(origins)),
        sensitivity: normaliseSensitivity(sensitivity)
    });
}

function join(...labels) {
    const flat = labels.flat().filter(Boolean);
    if (flat.length === 0) return UNKNOWN;

    const origins = [];
    let sensitivity = SENSITIVITY.PUBLIC;

    for (const item of flat) {
        origins.push(...normaliseOrigins(item.origins));
        const candidate = normaliseSensitivity(item.sensitivity);
        if (SENSITIVITY_RANK[candidate] > SENSITIVITY_RANK[sensitivity]) {
            sensitivity = candidate;
        }
    }

    return label(origins, sensitivity);
}

function isInstructionSafe(candidate) {
    if (!candidate) return false;
    const origins = normaliseOrigins(candidate.origins);
    return origins.every(origin => INSTRUCTION_ORIGINS.has(origin));
}

function atLeast(candidate, level) {
    const have = SENSITIVITY_RANK[normaliseSensitivity((candidate || UNKNOWN).sensitivity)];
    const want = SENSITIVITY_RANK[normaliseSensitivity(level)];
    return have >= want;
}

function isSecret(candidate) {
    return normaliseSensitivity((candidate || UNKNOWN).sensitivity) === SENSITIVITY.SECRET;
}

function describe(candidate) {
    const value = candidate || UNKNOWN;
    return `${normaliseSensitivity(value.sensitivity)} (${normaliseOrigins(value.origins).join('+')})`;
}

function serialise(candidate) {
    const value = candidate || UNKNOWN;
    return JSON.stringify({
        origins: normaliseOrigins(value.origins),
        sensitivity: normaliseSensitivity(value.sensitivity)
    });
}

function deserialise(text) {
    try {
        const parsed = JSON.parse(text);
        return label(parsed.origins, parsed.sensitivity);
    } catch {
        return UNKNOWN;
    }
}

module.exports = {
    ORIGIN,
    SENSITIVITY,
    SENSITIVITY_RANK,
    INSTRUCTION_ORIGINS,
    UNKNOWN,
    label,
    join,
    isInstructionSafe,
    atLeast,
    isSecret,
    describe,
    serialise,
    deserialise
};
