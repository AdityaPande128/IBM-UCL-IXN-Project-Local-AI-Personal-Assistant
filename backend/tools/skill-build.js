#!/usr/bin/env node
// The generate-test-install pipeline, callable from outside Jarvis. This is
// what the builder meta-skill in OpenClaw runs: the request travels into the
// same generator, verifier and pin store the assistant uses on its own, and
// a wrapper for the new skill is placed back across the border so the caller
// can use what was built.
//
//   node backend/tools/skill-build.js "<what the user asked for>"

const path = require('path');

const skillGenerator = require('../services/skillGenerator');
const skillExporter = require('../services/skillExporter');

async function main() {
    const request = process.argv.slice(2).join(' ').trim();
    if (!request) {
        console.error('usage: skill-build.js "<what the user asked for>"');
        process.exit(2);
    }

    const result = await skillGenerator.generate(request);
    if (result.status !== 'registered') {
        console.error(`no skill was built: ${result.reason}`);
        process.exit(1);
    }

    const wrapper = skillExporter.exportWrapper(result.skill);
    const shim = path.resolve(__dirname, 'skill-shim.js');

    console.log(`built, tested and installed "${result.skill}" — ${result.description}`);
    console.log(`parameters: ${result.parameters.join(', ') || 'none'}; `
        + `${result.testsPassed} authored test(s) passed in the sandbox`);
    if (wrapper.status === 'exported') {
        console.log(`a wrapper was placed in ${wrapper.path}; it loads as its own skill next session`);
    }
    console.log(`to run it now: node "${shim}" ${result.skill} --<parameter> "<value>"`);
}

main().catch(err => {
    console.error(`the builder failed: ${err.message}`);
    process.exit(1);
});
