const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const configReader = require('../utils/configReader');
const skillSandbox = require('./skillSandbox');
const skillPins = require('./skillPins');

const ENFORCE_MODE = (configReader.readConfig().security || {}).enforce_capabilities || 'generated';


function findValue(canonicalName, spec, supplied) {
    if (canonicalName in supplied) return supplied[canonicalName];

    for (const alias of spec.aliases || []) {
        if (alias in supplied) return supplied[alias];
    }

    const target = canonicalName.toLowerCase();
    for (const [key, value] of Object.entries(supplied)) {
        const k = key.toLowerCase();
        if (k === target || k.includes(target) || target.includes(k)) return value;
    }
    return undefined;
}

function coerceNumber(raw, spec, name, errors) {
    let value = raw;

    if (typeof value === 'string') {
        const text = value.trim().toLowerCase();
        const vocabulary = spec.vocabulary || {};
        if (text in vocabulary) {
            value = vocabulary[text];
        } else {
            const numeric = parseFloat(text.replace('%', ''));
            if (Number.isNaN(numeric)) {
                errors.push(`${name}: "${raw}" is not a number`);
                return undefined;
            }
            value = text.includes('%') && spec.accepts_percent ? numeric / 100 : numeric;
        }
    }

    if (typeof value !== 'number' || Number.isNaN(value)) {
        errors.push(`${name}: expected a number, got ${typeof raw}`);
        return undefined;
    }

    if (spec.accepts_percent && spec.max !== undefined && value > spec.max && value <= 100) {
        value = value / 100;
    }

    if (spec.min !== undefined && value < spec.min) {
        errors.push(`${name}: ${value} is below the minimum of ${spec.min}`);
        return undefined;
    }
    if (spec.max !== undefined && value > spec.max) {
        errors.push(`${name}: ${value} exceeds the maximum of ${spec.max}`);
        return undefined;
    }
    return value;
}

function coerceBoolean(raw, name, errors) {
    if (typeof raw === 'boolean') return raw;

    const text = String(raw).trim().toLowerCase();
    if (['on', 'true', 'enable', 'enabled', 'yes', '1'].includes(text)) return true;
    if (['off', 'false', 'disable', 'disabled', 'no', '0'].includes(text)) return false;

    errors.push(`${name}: "${raw}" is not an on/off value`);
    return undefined;
}

function coerceEnum(raw, spec, name, errors) {
    const text = String(raw).trim().toLowerCase();

    for (const candidate of spec.values) {
        if (String(candidate).toLowerCase() === text) return candidate;
    }
    for (const [synonym, candidate] of Object.entries(spec.vocabulary || {})) {
        if (synonym.toLowerCase() === text) return candidate;
    }

    errors.push(`${name}: "${raw}" is not one of ${spec.values.join(', ')}`);
    return undefined;
}

function coerceParameters(skill, supplied = {}) {
    const errors = [];
    const coerced = {};

    for (const [name, spec] of Object.entries(skill.parameters || {})) {
        const raw = findValue(name, spec, supplied || {});

        if (raw === undefined || raw === null || raw === '') {
            if (spec.required) {
                errors.push(`${name} is required — ${spec.description || 'no description'}`);
            } else if (spec.default !== undefined) {
                coerced[name] = spec.default;
            }
            continue;
        }

        let value;
        switch (spec.type) {
            case 'number':  value = coerceNumber(raw, spec, name, errors); break;
            case 'boolean': value = coerceBoolean(raw, name, errors); break;
            case 'enum':    value = coerceEnum(raw, spec, name, errors); break;
            default:        value = String(raw); break;
        }

        if (value !== undefined) coerced[name] = value;
    }

    return { valid: errors.length === 0, errors, parameters: coerced };
}


const TOKEN = /\{\{\s*([a-zA-Z0-9_]+)(?:\|([a-zA-Z]+))?\s*\}\}/g;

const FILTERS = {
    percent:        v => `${Math.round(Number(v) * 100)}%`,
    percent_number: v => String(Math.round(Number(v) * 100)),
    upper:          v => String(v).toUpperCase(),
    lower:          v => String(v).toLowerCase()
};

function formatValue(value, filter) {
    if (filter && FILTERS[filter]) return FILTERS[filter](value);
    return String(value);
}

function substitute(template, parameters, skillDir) {
    return String(template).replace(TOKEN, (match, name, filter) => {
        if (name === '__dir__') return skillDir;
        if (name in parameters) return formatValue(parameters[name], filter);
        return match;
    });
}

function buildArgv(skill, parameters) {
    return skill.exec.argv.map(part => substitute(part, parameters, skill.directory));
}


const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

const RESULT_MARKER = 'JARVIS_RESULT ';
const MAX_FILES = 20;
const MAX_ROWS = 100;
const MAX_COLUMNS = 12;
const MAX_CELL_CHARS = 200;

function parseArtifacts(stdout) {
    const lines = stdout.split('\n');
    const kept = [];
    let raw = null;
    for (const line of lines) {
        if (line.startsWith(RESULT_MARKER)) raw = line.slice(RESULT_MARKER.length);
        else kept.push(line);
    }
    const cleaned = kept.join('\n').trim();
    if (raw === null) return { stdout, artifacts: null, text: null };

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        console.warn(`[SkillExecutor] ignoring a malformed JARVIS_RESULT line: ${err.message}`);
        return { stdout: cleaned, artifacts: null, text: null };
    }

    const artifacts = {};

    if (Array.isArray(parsed.files)) {
        const files = [];
        for (const entry of parsed.files.slice(0, MAX_FILES)) {
            if (typeof entry !== 'string') continue;
            try {
                const stat = fs.statSync(entry);
                if (stat.isFile()) {
                    files.push({ path: entry, name: path.basename(entry), bytes: stat.size });
                }
            } catch { }
        }
        if (files.length) artifacts.files = files;
    }

    if (parsed.table && Array.isArray(parsed.table.columns) && Array.isArray(parsed.table.rows)) {
        const cell = value => String(value).slice(0, MAX_CELL_CHARS);
        const columns = parsed.table.columns.slice(0, MAX_COLUMNS).map(cell);
        const rows = parsed.table.rows
            .filter(Array.isArray)
            .slice(0, MAX_ROWS)
            .map(row => row.slice(0, MAX_COLUMNS).map(cell));
        if (columns.length) {
            artifacts.table = { columns, rows, total: parsed.table.rows.length };
        }
    }

    return {
        stdout: cleaned,
        artifacts: Object.keys(artifacts).length ? artifacts : null,
        text: typeof parsed.text === 'string' && parsed.text.trim() ? parsed.text.trim() : null
    };
}

function runProcess(argv, timeoutMs, cwd, env) {
    return new Promise((resolve) => {
        const [command, ...args] = argv;

        execFile(command, args, { timeout: timeoutMs, cwd, env, maxBuffer: MAX_OUTPUT_BYTES }, (err, stdout, stderr) => {
            if (err) {
                let reason = err.message;
                if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
                    reason = `produced more than ${MAX_OUTPUT_BYTES / (1024 * 1024)}MB of output`;
                } else if (err.killed) {
                    reason = `timed out after ${timeoutMs}ms`;
                }
                resolve({
                    success: false,
                    error: reason,
                    stdout: (stdout || '').trim(),
                    stderr: (stderr || '').trim()
                });
            } else {
                resolve({
                    success: true,
                    stdout: (stdout || '').trim(),
                    stderr: (stderr || '').trim()
                });
            }
        });
    });
}

async function execute(skill, supplied = {}) {
    const startedAt = Date.now();

    if (skill.provenance && skill.provenance.author === 'generated') {
        const pinned = skillPins.ensurePinned(skill.name, skill.directory, skill.version);
        if (!pinned.ok) {
            return {
                status: 'refused',
                response: `${skill.name} has changed on disk since it was verified and installed; `
                    + `not running it. Regenerate the skill to re-verify it.`,
                skill: skill.name,
                version: skill.version,
                durationMs: Date.now() - startedAt
            };
        }
    }

    const coercion = coerceParameters(skill, supplied);
    if (!coercion.valid) {
        return {
            status: 'invalid_parameters',
            response: `I couldn't run ${skill.name}: ${coercion.errors.join('; ')}`,
            skill: skill.name,
            version: skill.version,
            errors: coercion.errors,
            durationMs: Date.now() - startedAt
        };
    }

    if (skill.exec.type !== 'command' && skill.exec.type !== 'script') {
        return {
            status: 'error',
            response: `Skill ${skill.name} declares an unsupported exec type.`,
            skill: skill.name,
            version: skill.version,
            durationMs: Date.now() - startedAt
        };
    }

    const argv = buildArgv(skill, coercion.parameters);

    const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-run-')));

    let result;
    let enforced = false;
    try {
        const sandboxed = skillSandbox.wrap(skill, argv, tempDir, ENFORCE_MODE, coercion.parameters);
        enforced = sandboxed.enforced;

        console.log(
            `[SkillExecutor] ${skill.name}@${skill.version}` +
            `${enforced ? ' [sandboxed]' : ''} → ${JSON.stringify(argv)}`
        );

        result = await runProcess(sandboxed.argv, skill.exec.timeout_ms, skill.directory, {
            ...process.env,
            TMPDIR: tempDir
        });
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }

    const durationMs = Date.now() - startedAt;

    const parsed = parseArtifacts(result.stdout);

    if (!result.success) {
        const diagnostic = result.stderr || parsed.stdout || result.error;
        return {
            status: 'error',
            response: `${skill.name} failed: ${diagnostic}`,
            skill: skill.name,
            version: skill.version,
            stderr: result.stderr,
            stdout: parsed.stdout,
            sandboxed: enforced,
            durationMs
        };
    }

    const reply = substitute(skill.reply, coercion.parameters, skill.directory);
    const body = parsed.text !== null ? parsed.text : parsed.stdout;

    return {
        status: 'success',
        response: body ? `${reply}\n${body}`.trim() : reply,
        skill: skill.name,
        version: skill.version,
        parameters: coercion.parameters,
        stdout: parsed.stdout,
        ...(parsed.artifacts ? { artifacts: parsed.artifacts } : {}),
        sandboxed: enforced,
        durationMs
    };
}

module.exports = {
    execute,
    coerceParameters,
    substitute,
    buildArgv,
    findValue
};
