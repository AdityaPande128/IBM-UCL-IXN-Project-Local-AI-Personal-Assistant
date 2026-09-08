const path = require('path');

const activityBus = require('./activityBus');
const skillExecutor = require('./skillExecutor');
const proposals = require('./proposals');
const profile = require('./profile');

// A skill that fails at runtime never hands the user its stack trace. A
// permissions wall becomes a card asking for the access; a broken generated
// skill goes back to the builder for one mended attempt; and when nothing
// helps, the answer is plain words. The diagnostic stays on the result for
// logs and the ledger, never in the response.

const PERMISSION_SHAPED =
    /operation not permitted|permission denied|eacces|eperm|read-only file system|sandbox/i;

function blockedPath(stderr, parameters, skillDir = null) {
    const text = String(stderr || '');
    const denied = [...text.matchAll(/(?:operation not permitted|permission denied|eacces|eperm)[^'"\n]*['"]?(\/[^'"\n]+)/gi)]
        .map(m => m[1]).filter(Boolean);
    const candidates = denied.length ? denied
        : [...text.matchAll(/'(\/[^']+)'|"(\/[^"]+)"|(\/[A-Za-z0-9._/-]{3,})/g)]
            .map(m => m[1] || m[2] || m[3]).filter(Boolean);
    const outside = candidates.filter(hit => !skillDir || !(hit === skillDir || hit.startsWith(skillDir + path.sep)));
    const hit = outside.length ? outside[outside.length - 1] : null;
    if (hit) return path.dirname(hit);
    const supplied = Object.values(parameters || {})
        .find(value => typeof value === 'string' && value.startsWith('/'));
    return supplied || null;
}

const INPUT_SHAPED = /no such file|filenotfounderror|does not exist|usage:|unrecognized arguments|the following arguments are required|is a directory|not a directory|no ['"]?\w+['"]? column|column[^\n]{0,40}(not found|missing|does not exist)|keyerror|permission denied/i;

function plainReason(stderr, response) {
    const lines = String(stderr || response || '').split('\n').map(l => l.trim())
        .filter(l => l && !/^(Traceback|File |\^+$)/.test(l) && !/^\w*(Error|Exception)\b/.test(l)
            && !/^\s*(raise|return)\b/.test(l));
    const last = lines[lines.length - 1] || '';
    return last.length <= 240 ? last : '';
}

async function nearestByName(target) {
    const fs = require('fs');
    let ancestor = path.dirname(target);
    while (ancestor && !fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
    if (!ancestor || ancestor === path.dirname(ancestor)) return null;
    const base = path.basename(target);
    let hits = [];
    try {
        hits = require('./fileIndex').search({ text: base.replace(/\.[^.]+$/, ''), dir: ancestor, limit: 20 })
            .filter(hit => hit.name === base)
            .map(hit => hit.path);
    } catch { hits = []; }
    if (!hits.length) {
        let seen = 0;
        const walk = async (dir, depth) => {
            if (depth > 2 || seen > 400 || hits.length > 1) return;
            let entries = [];
            try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
            for (const entry of entries) {
                if (++seen > 400 || entry.name.startsWith('.')) continue;
                const full = path.join(dir, entry.name);
                if (entry.name === base) hits.push(full);
                else if (entry.isDirectory()) await walk(full, depth + 1);
            }
        };
        await walk(ancestor, 0);
    }
    const unique = [...new Set(hits)];
    if (unique.length === 1) return unique[0];
    if (!unique.length) return null;
    const wanted = path.basename(path.dirname(target)).toLowerCase();
    const alike = (a, b) => { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n; };
    const ranked = unique.map(full => ({ full, score: alike(path.basename(path.dirname(full)).toLowerCase(), wanted) }))
        .sort((a, b) => b.score - a.score);
    return ranked[0].score > 0 && (ranked.length === 1 || ranked[0].score > ranked[1].score) ? ranked[0].full : null;
}

async function resolveFileParameters(parameters = {}) {
    const fs = require('fs');
    const os = require('os');
    const securityStore = require('../security/store');
    const out = { ...parameters };
    let roots = [];
    try { roots = securityStore.grantedRoots('documents').map(r => typeof r === 'string' ? r : r.path); } catch { roots = []; }
    for (const [name, value] of Object.entries(parameters || {})) {
        if (typeof value !== 'string') continue;
        const given = value.trim();
        if (!given || given.length > 240 || given.startsWith('-') || /[\n\r]/.test(given)) continue;
        if (!/[\/\\]/.test(given) && !/\.[a-z0-9]{1,5}$/i.test(given)) continue;
        const expanded = given.startsWith('~/') ? path.join(os.homedir(), given.slice(2)) : given;
        if (/^[a-z]+:\/\//i.test(given)) continue;
        let relative = given;
        if (path.isAbsolute(expanded)) {
            if (fs.existsSync(expanded) || !expanded.startsWith(os.homedir() + path.sep)) continue;
            const nearby = await nearestByName(expanded);
            if (nearby) {
                console.log(`[SkillCare] ${name}: "${given}" is ${nearby}`);
                out[name] = nearby;
                continue;
            }
            relative = path.relative(os.homedir(), expanded);
        }
        const direct = roots.map(root => path.join(root, relative)).filter(candidate => fs.existsSync(candidate));
        let found = [...new Set(direct)];
        if (!found.length && /\.[a-z0-9]{1,5}$/i.test(relative)) {
            try {
                const base = path.basename(relative);
                const hits = require('./fileIndex').search({ text: base.replace(/\.[^.]+$/, ''), limit: 20 })
                    .filter(hit => hit.name === base && hit.path.endsWith(path.sep + relative))
                    .filter(hit => securityStore.isWithinGrantedRoot(hit.path, 'documents'));
                found = [...new Set(hits.map(hit => hit.path))];
            } catch { found = []; }
        }
        if (!found.length && path.dirname(relative) !== '.') {
            const parents = roots.map(root => path.join(root, path.dirname(relative))).filter(candidate => fs.existsSync(candidate));
            if (new Set(parents).size === 1) found = [path.join(parents[0], path.basename(relative))];
        }
        if (found.length === 1) {
            console.log(`[SkillCare] ${name}: "${given}" is ${found[0]}`);
            out[name] = found[0];
        } else if (found.length > 1) {
            console.log(`[SkillCare] ${name}: "${given}" matches ${found.length} files; left as given`);
        }
    }
    return out;
}

async function run(skill, parameters, options = {}) {
    activityBus.publish('skill', 'running', { skill: skill.name });
    parameters = await resolveFileParameters(parameters);
    const first = await skillExecutor.execute(skill, parameters);
    if (first.status !== 'error') return first;

    const stderr = String(first.stderr || '');

    if (PERMISSION_SHAPED.test(stderr)) {
        const dir = blockedPath(stderr, parameters, skill.directory);
        const offerable = dir && !require('./skillSandbox').isSensitivePath(dir)
            && !require('../security/classifier').secretCheck(dir).secret;
        if (offerable) {
            const offer = proposals.create('skill_access', {
                summary: `${skill.name} needs to read ${dir}`,
                will: `run ${skill.name} once more with read access to ${dir}, `
                    + 'for that run only'
            }, async () => {
                const retry = await skillExecutor.execute(skill, parameters,
                    { allowRead: [dir] });
                return retry.status === 'success'
                    ? { status: 'success', response: retry.response,
                        ...(retry.artifacts ? { artifacts: retry.artifacts } : {}) }
                    : { status: 'error',
                        response: `Sorry — even with access to ${dir}, `
                            + `${skill.name} could not finish.` };
            });
            return {
                status: 'needs_approval',
                response: `${skill.name} stopped at a permissions wall: it was not `
                    + `allowed to read ${dir}. Approve and I will run it once more `
                    + 'with access to that folder, for that run only.',
                proposal: offer,
                skill: skill.name,
                stderr
            };
        }
    }

    const generated = (skill.provenance || {}).author === 'generated';
    const inputShaped = INPUT_SHAPED.test(stderr) || INPUT_SHAPED.test(String(first.response || ''));
    if (generated && !inputShaped && profile.improvementEnabled()) {
        const mended = await require('./skillGenerator')
            .generate(options.request
                || `Fix the installed skill "${skill.name}": ${skill.description}`, {
                gaps: [`running it failed with: ${(stderr || first.response).slice(0, 400)}`],
                repair: skill.name,
                ...(options.signal ? { signal: options.signal } : {})
            })
            .catch(() => null);

        if (mended && mended.status === 'registered' && mended.skill) {
            const fixed = require('./skillRegistry').get(mended.skill) || skill;
            const second = await skillExecutor.execute(fixed, parameters);
            if (second.status === 'success') {
                return { ...second,
                    response: `${second.response}\n\n(The skill broke on the first try; `
                        + 'I repaired and reran it.)' };
            }
        }
    }

    const said = inputShaped ? plainReason(stderr, first.response) : '';
    const mismatch = Boolean(said) && /\b(column|field|key|header)\b/i.test(said);
    return {
        status: 'error',
        response: said
            ? `${skill.name} could not do that: ${said}`
            : `Sorry — I couldn't do that. ${skill.name} ran into a problem `
                + 'it could not get past.',
        ...(mismatch ? { mismatch: true, reason: said } : {}),
        skill: skill.name,
        version: first.version,
        stderr,
        durationMs: first.durationMs
    };
}

module.exports = { run, blockedPath, resolveFileParameters, PERMISSION_SHAPED };
