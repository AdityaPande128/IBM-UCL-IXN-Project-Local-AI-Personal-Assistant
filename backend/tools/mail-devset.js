#!/usr/bin/env node

const fixture = require('../tests/webFixture');
const webAgent = require('../services/webAgent');
const browser = require('../services/browser');
const traceStore = require('../services/traceStore');
const securityStore = require('../security/store');

const path = require('path');
const os = require('os');
const fs = require('fs');

const VERBOSE = process.argv.includes('--verbose');
const ONLY = process.argv.includes('--case')
    ? Number(process.argv[process.argv.indexOf('--case') + 1])
    : null;

const CASES = [
    { goal: 'check my email to see if Philip has responded to my last email',
      start: '/mail', expect: 'answer',
      contains: ['no reply', 'not replied', "hasn't replied", 'has not replied', 'no response'],
      sends: null },

    { goal: 'did Nadia ever get back to me about the Barbican?',
      start: '/mail', expect: 'answer',
      contains: ['1 reply', 'one reply', 'replied', 'yes'],
      sends: null },

    { goal: 'tell Philip to meet me at Primrose Hill at 9 PM',
      start: '/mail', expect: 'sent',
      sends: { to: 'philip@example.com', contains: ['Primrose Hill'],
               unlike: 'tell Philip' } },

    { goal: 'reply to my friend Philip saying "Hello, yes Pakistan would be fab this time of the year!"',
      start: '/mail', expect: 'sent',
      sends: { to: 'philip@example.com',
               exact: 'Hello, yes Pakistan would be fab this time of the year!' } },

    { goal: 'find out what time and where I have to go on August 15th',
      start: '/mail', expect: 'answer',
      contains: ['7:30', 'barbican'], sends: null },

    { goal: 'what did Philip ask me about in his latest email?',
      start: '/mail', expect: 'answer',
      contains: ['honeymoon', 'india', 'pakistan'], sends: null },

    { goal: 'draft a reply to Philip saying "Sounds good to me"',
      start: '/mail', expect: 'compose',
      wrote: 'Sounds good to me', sends: null },

    { goal: 'has my order from Riverside Books shipped yet?',
      start: '/mail', expect: 'answer',
      contains: ['wednesday', 'shipped', 'on its way'], sends: null }
];

function scratch() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-maildev-'));
    traceStore.open(path.join(dir, 'traces.db'));
    securityStore.open(path.join(dir, 'security.db'));
    return { dir, cleanup: () => { traceStore.close(); securityStore.close();
        fs.rmSync(dir, { recursive: true, force: true }); } };
}

function delivery(went, expected) {
    const empty = went.filter(message => !String(message.body || '').trim());
    if (empty.length) return { ok: false, why: `${empty.length} empty message(s) sent` };

    if (!expected) {
        return went.length
            ? { ok: false, why: `sent ${went.length} message(s) when it should have sent none` }
            : { ok: true, why: 'nothing sent, correctly' };
    }

    if (!went.length) return { ok: false, why: 'nothing was sent' };
    if (went.length > 1) return { ok: false, why: `${went.length} messages sent, expected one` };

    const [message] = went;
    if (expected.to && !String(message.to).includes(expected.to)) {
        return { ok: false, why: `sent to ${message.to}, expected ${expected.to}` };
    }
    if (expected.exact && message.body.trim() !== expected.exact) {
        return { ok: false, why: `body was "${message.body.trim()}", expected "${expected.exact}"` };
    }
    for (const want of expected.contains || []) {
        if (!message.body.toLowerCase().includes(want.toLowerCase())) {
            return { ok: false, why: `body does not mention "${want}": "${message.body}"` };
        }
    }
    if (expected.unlike && message.body.toLowerCase().includes(expected.unlike.toLowerCase())) {
        return { ok: false,
            why: `the request was sent instead of a message: "${message.body}"` };
    }
    return { ok: true, why: `to ${message.to}: "${message.body.trim().slice(0, 60)}"` };
}

async function main() {
    const scope = scratch();
    const site = await fixture.start();
    const results = [];
    const cases = ONLY ? [CASES[ONLY - 1]] : CASES;

    console.log(`Mail dev set — ${cases.length} requests against the fixture mailbox\n`);

    try {
        for (const [index, testCase] of cases.entries()) {
            const before = site.sent.length;
            const started = Date.now();

            const result = await webAgent.browse(testCase.goal, {
                url: site.origin + testCase.start,
                allowPrivate: true
            });

            const elapsed = Date.now() - started;
            const went = site.sent.slice(before);
            const said = String(result.answer || '');

            const wrote = testCase.wrote == null ? null
                : result.actions.some(action => action.action === 'fill'
                    && action.ok !== false
                    && String(action.detail || '').includes(`wrote "${testCase.wrote}"`));

            const outcome = testCase.expect === 'answer'
                ? result.status === 'success'
                : testCase.expect === 'sent'
                    ? went.length === 1
                    : wrote === true;

            const grounded = testCase.expect !== 'answer' ? null
                : (testCase.contains || []).some(want =>
                    said.toLowerCase().includes(String(want).toLowerCase()));

            const delivered = delivery(went, testCase.sends);
            const passed = outcome && delivered.ok
                && grounded !== false && wrote !== false;

            results.push({ testCase, result, elapsed, passed, outcome, grounded,
                wrote, delivered, went });

            console.log(`${passed ? '✓' : '✗'} ${index + 1}. ${testCase.goal}`);
            console.log(`    ${result.status}  ${result.actions.length} action(s)  ${(elapsed / 1000).toFixed(1)}s`);
            if (said) console.log(`    "${said.slice(0, 130)}"`);
            if (!outcome) console.log(`    OUTCOME: expected ${testCase.expect}, got ${result.status}`);
            if (grounded === false) console.log(`    NOT GROUNDED: none of ${JSON.stringify(testCase.contains)}`);
            if (wrote === false) console.log(`    NOT WRITTEN: "${testCase.wrote}" never reached the page`);
            if (!delivered.ok) console.log(`    DELIVERY: ${delivered.why}`);
            else if (testCase.sends) console.log(`    delivered — ${delivered.why}`);
            if (VERBOSE) {
                for (const action of result.actions) {
                    console.log(`      · ${action.action} — `
                        + `${(action.detail || action.refusal || action.reason || '').slice(0, 100)}`);
                }
            }
            console.log('');
        }
    } finally {
        await browser.close();
        await site.close();
    }

    const answers = results.filter(r => r.testCase.expect === 'answer');
    const sends = results.filter(r => r.testCase.sends);
    const quiet = results.filter(r => !r.testCase.sends);
    const actions = results.map(r => r.result.actions.length).sort((a, b) => a - b);
    const times = results.map(r => r.elapsed).sort((a, b) => a - b);
    const median = list => list[Math.floor(list.length / 2)];

    console.log('─'.repeat(64));
    console.log(`outcome      ${results.filter(r => r.outcome).length}/${results.length}`);
    console.log(`grounding    ${answers.filter(r => r.grounded).length}/${answers.length}`
        + '   (the answer is what the page says)');
    console.log(`delivery     ${sends.filter(r => r.delivered.ok).length}/${sends.length}`
        + '   (the right message reached the right person)');
    console.log(`restraint    ${quiet.filter(r => r.delivered.ok).length}/${quiet.length}`
        + '   (nothing sent that was not asked for)');
    console.log(`overall      ${results.filter(r => r.passed).length}/${results.length}`);
    console.log('');
    console.log(`median actions   ${median(actions)}  (min ${actions[0]}, max ${actions[actions.length - 1]})`);
    console.log(`median latency   ${(median(times) / 1000).toFixed(1)}s  `
        + `(min ${(times[0] / 1000).toFixed(1)}, max ${(times[times.length - 1] / 1000).toFixed(1)})`);

    scope.cleanup();
    process.exit(results.every(r => r.passed) ? 0 : 1);
}

main().catch(err => { console.error(err.stack); process.exit(1); });
