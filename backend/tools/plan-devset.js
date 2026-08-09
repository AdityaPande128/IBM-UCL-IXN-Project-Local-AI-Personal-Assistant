#!/usr/bin/env node

const planner = require('../services/planner');
const capabilityGraph = require('../services/capabilityGraph');

const VERBOSE = process.argv.includes('--verbose');

const CASES = [
    {
        request: 'what does my thesis outline say about chapter three',
        expect: 'planned',
        requires: ['files.search', 'files.read', 'answer']
    },
    {
        request: 'find my boiler service note and tell me when the next one is due',
        expect: 'planned',
        requires: ['files.search', 'files.read', 'answer']
    },
    {
        request: 'where did I save the tenancy agreement',
        expect: 'planned',
        requires: ['files.search'],
        forbids: ['files.read']
    },

    {
        request: 'mute the sound and turn the screen brightness right down',
        expect: 'planned',
        requires: ['skill.system-mute', 'skill.display-brightness']
    },
    {
        request: 'turn the volume down to about a third and tell me what a mutex is',
        expect: 'planned',
        requires: ['skill.system-volume', 'answer']
    },

    {
        request: 'open Safari',
        expect: 'planned',
        requires: ['skill.app-launch']
    },

    {
        request: 'what does the page at https://example.org/pricing say the plans cost',
        expect: 'planned',
        requires: ['web.read', 'answer'],
        forbids: ['files.search']
    },
    {
        request: 'look up the opening times for the British Library on their website',
        expect: 'planned',
        forbids: ['files.search', 'files.read']
    },
    {
        request: 'what is the capital of Australia',
        expect: 'planned',
        requires: ['answer'],
        forbids: ['web.read', 'web.browse', 'files.search']
    },

    {
        request: 'post a message to my company Slack channel',
        expect: 'gap'
    },
    {
        request: 'log in to my energy supplier and download my latest bill',
        expect: 'gap'
    },
    {
        request: 'text my sister to say I will be late',
        expect: 'gap'
    },
    {
        request: 'convert all the heic photos on my desktop to jpeg',
        expect: 'gap'
    },
    {
        request: 'book me a table for two at a restaurant near the office tonight',
        expect: 'gap'
    },

    {
        request: 'how many lines are in the python files in my project folder',
        expect: 'planned',
        requires: ['skill.count-lines-in-files']
    },
    {
        request: 'list the biggest files in my downloads folder',
        expect: 'planned',
        requires: ['skill.list-large-files']
    }
];

function shapeOf(plan) {
    return new Set((plan.steps || []).map(step => step.capability));
}

function danglingSteps(plan) {
    const consumed = new Set();
    for (const step of plan.steps || []) {
        for (const reference of planner.referencesIn(step.inputs)) consumed.add(reference.step);
    }

    return (plan.steps || []).filter((step, index) => {
        const capability = capabilityGraph.get(step.capability);
        if (!capability) return false;
        const isLast = index === plan.steps.length - 1;
        return !capability.effects.length
            && !consumed.has(step.id)
            && !(isLast && 'text' in capability.outputs);
    });
}

(async () => {
    console.log(`\n  PLAN DEV SET — ${CASES.length} case(s), ${capabilityGraph.list().length} capabilities\n`);

    const score = { outcome: 0, shape: 0, shapeable: 0, hygiene: 0, repairs: 0, attempts: 0 };
    const latencies = [];
    const failures = [];

    for (const testCase of CASES) {
        const plan = await planner.plan(testCase.request);
        latencies.push(plan.latency_ms);
        score.attempts += plan.attempts || 0;
        score.repairs += (plan.repairs || []).length;

        const outcomeOk = plan.status === testCase.expect;
        if (outcomeOk) score.outcome++;

        const shape = shapeOf(plan);
        let shapeOk = true;
        if (testCase.requires || testCase.forbids) {
            score.shapeable++;
            for (const needed of testCase.requires || []) {
                if (!shape.has(needed)) shapeOk = false;
            }
            for (const banned of testCase.forbids || []) {
                if (shape.has(banned)) shapeOk = false;
            }
            if (outcomeOk && shapeOk) score.shape++;
        }

        const dangling = danglingSteps(plan);
        if (!dangling.length) score.hygiene++;

        const ok = outcomeOk && shapeOk && !dangling.length;
        console.log(
            `  ${ok ? 'ok  ' : 'FAIL'}  ${plan.status.padEnd(8)} ` +
            `${String(plan.latency_ms).padStart(6)}ms  ${testCase.request.slice(0, 52)}`
        );

        if (!ok) {
            failures.push({ testCase, plan, dangling, outcomeOk, shapeOk });
        }
        if (VERBOSE || !ok) {
            for (const step of plan.steps || []) {
                console.log(`          ${step.id} ${step.capability}(${JSON.stringify(step.inputs)})`);
            }
            for (const gap of plan.missing || []) {
                console.log(`          missing: ${gap.slice(0, 100)}`);
            }
            if (dangling.length) {
                console.log(`          DANGLING: ${dangling.map(s => s.id).join(', ')}`);
            }
        }
    }

    latencies.sort((a, b) => a - b);
    const median = latencies[Math.floor(latencies.length / 2)];

    console.log('\n  ----------------------------------------------------');
    console.log(`  outcome (plan vs gap)   ${score.outcome}/${CASES.length}`);
    console.log(`  shape (right steps)     ${score.shape}/${score.shapeable}`);
    console.log(`  hygiene (no dead steps) ${score.hygiene}/${CASES.length}`);
    console.log(`  median latency          ${median}ms   (min ${latencies[0]}, max ${latencies[latencies.length - 1]})`);
    console.log(`  attempts                ${score.attempts} for ${CASES.length} plans`);
    console.log(`  silent repairs          ${score.repairs}`);
    console.log('  ----------------------------------------------------\n');

    if (failures.length) {
        console.log(`  ${failures.length} case(s) failed:`);
        for (const failure of failures) {
            const why = [
                failure.outcomeOk ? null : `expected ${failure.testCase.expect}, got ${failure.plan.status}`,
                failure.shapeOk ? null : 'wrong steps',
                failure.dangling.length ? 'dead steps' : null
            ].filter(Boolean).join('; ');
            console.log(`    - "${failure.testCase.request.slice(0, 60)}" — ${why}`);
        }
        console.log('');
    }
})();
