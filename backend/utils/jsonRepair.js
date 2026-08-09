const VALID_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);

function repairEscapes(source) {
    let out = '';
    let inString = false;

    for (let i = 0; i < source.length; i++) {
        const char = source[i];

        if (!inString) {
            if (char === '"') inString = true;
            out += char;
            continue;
        }

        if (char === '\\') {
            const next = source[i + 1];
            if (next === undefined) { out += char; continue; }

            if (VALID_ESCAPES.has(next)) {
                out += char + next;
                i++;
            } else {
                out += '\\\\' + next;
                i++;
            }
            continue;
        }

        if (char === '"') {
            inString = false;
            out += char;
            continue;
        }

        const code = char.charCodeAt(0);
        if (code < 0x20) {
            if (char === '\n') out += '\\n';
            else if (char === '\r') out += '\\r';
            else if (char === '\t') out += '\\t';
            continue;
        }

        out += char;
    }

    return out;
}

function stripLineComments(source) {
    let out = '';
    let inString = false;

    for (let i = 0; i < source.length; i++) {
        const char = source[i];

        if (inString) {
            out += char;
            if (char === '\\') { out += source[++i] ?? ''; continue; }
            if (char === '"') inString = false;
            continue;
        }

        if (char === '"') { inString = true; out += char; continue; }

        if (char === '/' && source[i + 1] === '/') {
            while (i < source.length && source[i] !== '\n') i++;
            out += '\n';
            continue;
        }
        out += char;
    }

    return out;
}

function parseWithRepair(source) {
    const attempts = [
        source,
        stripLineComments(source),
        repairEscapes(source),
        repairEscapes(stripLineComments(source))
    ];

    let lastError = null;
    for (const [index, candidate] of attempts.entries()) {
        try {
            return { value: JSON.parse(candidate), repaired: index > 0, error: null };
        } catch (err) {
            lastError = err;
        }
    }
    return { value: null, repaired: false, error: lastError.message };
}

function extractJson(raw) {
    const trimmed = String(raw || '').trim();
    const candidates = [];

    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) candidates.push(fenced[1].trim());

    const braced = trimmed.match(/\{[\s\S]*\}/);
    if (braced) candidates.push(braced[0]);

    candidates.push(trimmed);

    for (const candidate of candidates) {
        const { value } = parseWithRepair(candidate);
        if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    }
    return null;
}

module.exports = {
    repairEscapes, stripLineComments, parseWithRepair, extractJson, VALID_ESCAPES
};
