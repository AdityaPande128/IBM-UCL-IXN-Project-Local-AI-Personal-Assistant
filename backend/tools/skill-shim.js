#!/usr/bin/env node
// Runs an installed Jarvis skill from outside Jarvis — the command exported
// wrappers point other agents at. It goes through the same executor the
// assistant itself uses, so the pin check and the sandbox profile apply no
// matter who is calling.
//
//   node backend/tools/skill-shim.js <skill-name> [--parameter value ...]

const skillRegistry = require('../services/skillRegistry');
const skillExecutor = require('../services/skillExecutor');

function parseArgs(argv) {
    const [name, ...rest] = argv;
    const parameters = {};
    for (let i = 0; i < rest.length; i++) {
        if (!rest[i].startsWith('--')) continue;
        const key = rest[i].slice(2);
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
            parameters[key] = next;
            i++;
        } else {
            parameters[key] = 'true';
        }
    }
    return { name, parameters };
}

async function main() {
    const { name, parameters } = parseArgs(process.argv.slice(2));
    if (!name) {
        console.error('usage: skill-shim.js <skill-name> [--parameter value ...]');
        process.exit(2);
    }

    const skill = skillRegistry.get(name);
    if (!skill) {
        console.error(`no installed skill is named "${name}"`);
        process.exit(2);
    }

    const result = await skillExecutor.execute(skill, parameters);
    console.log(result.response);
    process.exit(result.status === 'success' ? 0 : 1);
}

main().catch(err => {
    console.error(`the shim failed: ${err.message}`);
    process.exit(1);
});
