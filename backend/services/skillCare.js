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

function blockedPath(stderr, parameters) {
    const quoted = String(stderr || '')
        .match(/'(\/[^']+)'|"(\/[^"]+)"|(\/[A-Za-z0-9._/-]{3,})/);
    const hit = quoted ? (quoted[1] || quoted[2] || quoted[3]) : null;
    if (hit) return path.dirname(hit);
    const supplied = Object.values(parameters || {})
        .find(value => typeof value === 'string' && value.startsWith('/'));
    return supplied || null;
}

async function run(skill, parameters, options = {}) {
    activityBus.publish('skill', 'running', { skill: skill.name });
    const first = await skillExecutor.execute(skill, parameters);
    if (first.status !== 'error') return first;

    const stderr = String(first.stderr || '');

    if (PERMISSION_SHAPED.test(stderr)) {
        const dir = blockedPath(stderr, parameters);
        if (dir) {
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
    if (generated && profile.improvementEnabled()) {
        const mended = await require('./skillGenerator')
            .generate(options.request
                || `Fix the installed skill "${skill.name}": ${skill.description}`, {
                gaps: [`running it failed with: ${(stderr || first.response).slice(0, 400)}`]
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

    return {
        status: 'error',
        response: `Sorry — I couldn't do that. ${skill.name} ran into a problem `
            + 'it could not get past.',
        skill: skill.name,
        version: first.version,
        stderr,
        durationMs: first.durationMs
    };
}

module.exports = { run, blockedPath, PERMISSION_SHAPED };
