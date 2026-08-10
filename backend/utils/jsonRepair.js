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

// The first complete { ... } object, tracked by brace depth so it ends at its
// own closing brace rather than the last one in the string. A stray brace
// after the object — a second object, or prose like "(see {details})" — no
// longer drags the greedy match past the real end and defeats extraction.
// String contents are skipped so a brace inside a value never miscounts.
function firstBalancedObject(text) {
    const start = text.indexOf('{');
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const char = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') inString = true;
        else if (char === '{') depth++;
        else if (char === '}' && --depth === 0) return text.slice(start, i + 1);
    }
    return null;
}

function extractJson(raw) {
    const trimmed = String(raw || '').trim();
    const candidates = [];

    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) candidates.push(fenced[1].trim());

    const balanced = firstBalancedObject(trimmed);
    if (balanced) candidates.push(balanced);

    // The greedy span stays as a last resort: it catches an object whose own
    // braces are unbalanced only because a value holds a bare brace the scan
    // above would trip on.
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
    repairEscapes, stripLineComments, parseWithRepair, extractJson,
    firstBalancedObject, VALID_ESCAPES
};
