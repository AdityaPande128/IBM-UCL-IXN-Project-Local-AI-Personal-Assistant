const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const SKILLS_DIR = path.resolve(__dirname, '..', 'skills');

const VALID_PARAM_TYPES = ['number', 'string', 'boolean', 'enum'];
const VALID_EXEC_TYPES = ['command', 'script'];
const SEMVER = /^\d+\.\d+\.\d+$/;
const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TOKEN = /\{\{\s*([a-zA-Z0-9_]+)(?:\|[a-zA-Z]+)?\s*\}\}/g;

let registry = null;
let loadErrors = [];


function splitFrontmatter(source) {
    const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) return null;
    return { frontmatter: match[1], body: match[2] };
}

function collectTokens(skill) {
    const sources = [];
    if (skill.exec && Array.isArray(skill.exec.argv)) sources.push(...skill.exec.argv);
    if (typeof skill.reply === 'string') sources.push(skill.reply);

    const tokens = new Set();
    for (const source of sources) {
        for (const match of String(source).matchAll(TOKEN)) {
            tokens.add(match[1]);
        }
    }
    return tokens;
}


function validateParameter(name, spec, errors) {
    const where = `parameters.${name}`;

    if (!spec || typeof spec !== 'object') {
        errors.push(`${where}: must be an object`);
        return;
    }
    if (!spec.type) {
        errors.push(`${where}: missing "type"`);
    } else if (!VALID_PARAM_TYPES.includes(spec.type)) {
        errors.push(`${where}: unsupported type "${spec.type}" (expected one of ${VALID_PARAM_TYPES.join(', ')})`);
    }
    if (spec.type === 'enum' && !Array.isArray(spec.values)) {
        errors.push(`${where}: enum parameters need a "values" array`);
    }
    if (spec.aliases !== undefined && !Array.isArray(spec.aliases)) {
        errors.push(`${where}: "aliases" must be an array`);
    }
    if (spec.min !== undefined && typeof spec.min !== 'number') {
        errors.push(`${where}: "min" must be a number`);
    }
    if (spec.max !== undefined && typeof spec.max !== 'number') {
        errors.push(`${where}: "max" must be a number`);
    }
    if (spec.min !== undefined && spec.max !== undefined && spec.min > spec.max) {
        errors.push(`${where}: "min" (${spec.min}) exceeds "max" (${spec.max})`);
    }
}

function validateManifest(manifest, directory) {
    const errors = [];

    if (!manifest || typeof manifest !== 'object') {
        return { valid: false, errors: ['frontmatter did not parse to an object'] };
    }

    if (!manifest.name) {
        errors.push('missing "name"');
    } else if (!SKILL_NAME.test(manifest.name)) {
        errors.push(`"name" must be kebab-case (got "${manifest.name}")`);
    } else if (manifest.name !== directory) {
        errors.push(`"name" (${manifest.name}) must match its directory (${directory})`);
    }

    if (!manifest.version) {
        errors.push('missing "version"');
    } else if (!SEMVER.test(String(manifest.version))) {
        errors.push(`"version" must be semver (got "${manifest.version}")`);
    }

    if (!manifest.description || typeof manifest.description !== 'string') {
        errors.push('missing "description" — the router relies on it');
    }

    const parameters = manifest.parameters || {};
    if (typeof parameters !== 'object' || Array.isArray(parameters)) {
        errors.push('"parameters" must be a mapping of name to spec');
    } else {
        for (const [name, spec] of Object.entries(parameters)) {
            validateParameter(name, spec, errors);
        }
    }

    if (!manifest.exec) {
        errors.push('missing "exec"');
    } else {
        const { type, argv, timeout_ms } = manifest.exec;
        if (!type) {
            errors.push('exec: missing "type"');
        } else if (!VALID_EXEC_TYPES.includes(type)) {
            errors.push(`exec: unsupported type "${type}"`);
        }
        if (!Array.isArray(argv) || argv.length === 0) {
            errors.push('exec: "argv" must be a non-empty array');
        } else if (argv.some(part => typeof part !== 'string')) {
            errors.push('exec: every "argv" element must be a string');
        }
        if (timeout_ms !== undefined && (typeof timeout_ms !== 'number' || timeout_ms <= 0)) {
            errors.push('exec: "timeout_ms" must be a positive number');
        }
    }

    if (!manifest.capabilities) {
        errors.push('missing "capabilities" — a skill must declare what it touches');
    } else {
        const { filesystem, network, exec } = manifest.capabilities;
        if (filesystem !== undefined && !Array.isArray(filesystem)) {
            errors.push('capabilities: "filesystem" must be an array of path globs');
        }
        if (network !== undefined && typeof network !== 'boolean') {
            errors.push('capabilities: "network" must be a boolean');
        }
        if (exec !== undefined && typeof exec !== 'boolean') {
            errors.push('capabilities: "exec" must be a boolean');
        }
    }

    if (Array.isArray(manifest.exec?.argv) || typeof manifest.reply === 'string') {
        const declared = new Set(Object.keys(parameters));
        for (const token of collectTokens(manifest)) {
            if (token === '__dir__') continue;
            if (!declared.has(token)) {
                errors.push(`undeclared substitution token "{{${token}}}" — add it to parameters`);
            }
        }
    }

    return { valid: errors.length === 0, errors };
}


function loadSkill(directory) {
    const dirPath = path.join(SKILLS_DIR, directory);
    const manifestPath = path.join(dirPath, 'SKILL.md');

    if (!fs.existsSync(manifestPath)) return null;

    let parsed;
    try {
        const source = fs.readFileSync(manifestPath, 'utf8');
        const split = splitFrontmatter(source);
        if (!split) {
            return { error: { skill: directory, errors: ['no YAML frontmatter block found'] } };
        }
        parsed = yaml.load(split.frontmatter);
        parsed = parsed || {};
        parsed.__body = split.body.trim();
    } catch (err) {
        return { error: { skill: directory, errors: [`YAML parse failed: ${err.message}`] } };
    }

    const { valid, errors } = validateManifest(parsed, directory);
    if (!valid) {
        return { error: { skill: directory, errors } };
    }

    return {
        skill: {
            name: parsed.name,
            version: String(parsed.version),
            description: parsed.description.trim(),
            parameters: parsed.parameters || {},
            exec: {
                type: parsed.exec.type,
                argv: parsed.exec.argv,
                timeout_ms: parsed.exec.timeout_ms ?? 15000
            },
            reply: parsed.reply || 'Done.',
            capabilities: {
                exec: parsed.capabilities.exec ?? false,
                filesystem: parsed.capabilities.filesystem ?? [],
                network: parsed.capabilities.network ?? false
            },
            provenance: parsed.provenance || { author: 'unknown' },
            instructions: parsed.__body,
            directory: dirPath
        }
    };
}

function load() {
    const loaded = new Map();
    loadErrors = [];

    let entries;
    try {
        entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
    } catch (err) {
        console.error(`[SkillRegistry] Cannot read ${SKILLS_DIR}: ${err.message}`);
        registry = loaded;
        return loaded;
    }

    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

        const result = loadSkill(entry.name);
        if (!result) continue;

        if (result.error) {
            loadErrors.push(result.error);
            console.warn(`[SkillRegistry] REJECTED "${result.error.skill}":`);
            for (const err of result.error.errors) console.warn(`  - ${err}`);
            continue;
        }
        loaded.set(result.skill.name, result.skill);
    }

    registry = loaded;
    console.log(
        `[SkillRegistry] Loaded ${loaded.size} skill(s)` +
        (loadErrors.length ? `, rejected ${loadErrors.length}.` : '.')
    );
    return loaded;
}

function ensureLoaded() {
    if (registry === null) load();
    return registry;
}


function list() {
    return Array.from(ensureLoaded().values())
        .sort((a, b) => a.name.localeCompare(b.name));
}

function get(name) {
    const canonical = resolveName(name);
    return canonical ? ensureLoaded().get(canonical) : null;
}

function has(name) {
    return resolveName(name) !== null;
}

function resolveName(name) {
    if (!name || typeof name !== 'string') return null;

    const skills = ensureLoaded();
    if (skills.has(name)) return name;

    const normalise = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const target = normalise(name);
    if (!target) return null;

    for (const skill of skills.values()) {
        if (normalise(skill.name) === target) return skill.name;
    }
    return null;
}

function errors() {
    ensureLoaded();
    return loadErrors;
}

function reload() {
    registry = null;
    return list();
}

module.exports = {
    list, get, has, resolveName, errors, reload, load,
    SKILLS_DIR,
    validateManifest, splitFrontmatter, collectTokens
};
