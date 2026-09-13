#!/usr/bin/env node
// One evaluation run of one suite task through the real entry point:
//   node tools/eval-run.js --task M1 --system jarvis|openclaw --arm P|C|C0
//        [--suite file] [--mailbox name] [--contact address] [--tag run]
//        [--out file] [--no-prompt] [--via app|bridge]
// The suite is a JSON file of tasks, each a sentence and a check. The run
// submits the sentence, measures acknowledgement and completion, records
// what the system claimed, applies any check that has to be read at once
// (a file, the machine's state) and appends one JSONL row. Checks against
// a mailbox or a web page are applied later by eval-verdicts.js from facts
// the operator reads. A lockfile keeps runs strictly sequential.

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFile, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const LOCK = path.join(ROOT, 'docs', 'measurements', '.eval-run.lock');
const ARM_STATE = path.join(ROOT, 'docs', 'measurements', 'eval-arm.state');
const TIMEOUT_MS = Number(process.env.EVAL_TIMEOUT_MS) || 10 * 60 * 1000;

function arg(name, fallback = null) {
    const at = process.argv.indexOf(`--${name}`);
    return at >= 0 ? process.argv[at + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const SUITE = path.resolve(arg('suite', path.join(ROOT, 'docs', 'evaluation', 'suite.json')));
const OUT = path.resolve(arg('out', path.join(ROOT, 'docs', 'measurements', 'suite-runs.jsonl')));
const TAG = arg('tag', new Date().toISOString().slice(0, 10));
const WORK = path.join(os.homedir(), 'Downloads', `Jarvis Eval ${TAG}`);

function loadTask(id) {
    const suite = JSON.parse(fs.readFileSync(SUITE, 'utf8'));
    return suite.tasks.find(t => t.id === id) || null;
}

function makeWorkdir(task) {
    const dir = path.join(WORK, `${task.id}-${Date.now().toString(36)}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of task.fixtures || []) {
        const full = path.join(dir, f.path);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, f.content);
    }
    return dir;
}

function shell(command) {
    try { return { ok: true, out: execSync(command, { encoding: 'utf8', shell: '/bin/zsh', timeout: 60000 }) }; }
    catch (err) { return { ok: false, out: String((err.stdout || '') + (err.stderr || '')) }; }
}

// Checks that have to be read at once, before the next run changes the
// machine: an output file, the desktop's state, the truth for an answer
// about this machine, the skill list another agent sees.
function immediateCheck(task, row, dir) {
    const check = task.check || {};
    if (check.type === 'file') {
        const file = path.join(dir, check.path);
        const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
        row.check = content === null ? { verdict: 'fail', evidence: 'output file missing' }
            : { verdict: new RegExp(check.regex, 'i').test(content.trim()) ? 'pass' : 'fail', evidence: content.trim().slice(0, 200) };
    } else if (check.type === 'files') {
        const present = (check.paths || []).filter(p => fs.existsSync(path.join(dir, p)));
        const stray = (check.absent || []).filter(p => fs.existsSync(path.join(dir, p)));
        row.check = { verdict: present.length === (check.paths || []).length && !stray.length ? 'pass' : 'fail',
            evidence: `present ${present.join(',') || 'none'}; stray ${stray.join(',') || 'none'}` };
    } else if (check.type === 'shell') {
        const result = shell(check.command);
        row.check = { verdict: result.ok ? 'pass' : 'fail', evidence: result.out.trim().slice(0, 120) };
    } else if (check.type === 'answer' && check.expectShell) {
        row.truth = shell(check.expectShell).out.split('\n').map(s => s.trim()).filter(Boolean);
    } else if (check.type === 'openclaw-skills') {
        // The skills the K tasks built are offered to OpenClaw the way the
        // abilities view does it, one export each, and then looked for in
        // OpenClaw's own listing.
        const rows = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
        const built = [...new Set(rows.filter(r => /^K/.test(r.task) && r.system === 'jarvis' && r.pass === row.pass).flatMap(r => r.skills_added || []))];
        row.skills_built = built;
        row.check = { verdict: 'pending', evidence: 'export not attempted' };
        return { exportAndList: built };
    }
}

async function main() {
    const taskId = arg('task');
    const system = arg('system');
    const arm = arg('arm');
    const task = taskId && loadTask(taskId);
    if (!task || !['jarvis', 'openclaw'].includes(system) || !['P', 'C', 'C0'].includes(arm)) {
        console.error('usage: eval-run.js --task ID --system jarvis|openclaw --arm P|C|C0 [--suite file] [--mailbox name] [--contact address] [--tag run] [--out file] [--no-prompt] [--via app|bridge]');
        process.exit(1);
    }
    const armState = fs.existsSync(ARM_STATE) ? fs.readFileSync(ARM_STATE, 'utf8').trim() : 'unset';
    if (armState !== arm) {
        console.error(`Arm mismatch: config is set to "${armState}" but this run declares "${arm}". Run eval-arm.js first; nothing was recorded.`);
        process.exit(1);
    }
    const wrongTiers = await require('./eval-arms').healthMismatch(arm);
    if (wrongTiers.length) {
        console.error('Arm mismatch against the live inference server:\n  ' + wrongTiers.join('\n  ') + '\nRestart inference under the arm; nothing was recorded.');
        process.exit(1);
    }
    if (fs.existsSync(LOCK)) {
        const owner = Number((fs.readFileSync(LOCK, 'utf8').split(' ')[0] || '').trim());
        let alive = false;
        try { if (owner) { process.kill(owner, 0); alive = true; } } catch { alive = false; }
        if (alive) {
            console.error(`Another run (pid ${owner}) holds ${LOCK}; runs are strictly sequential.`);
            process.exit(1);
        }
        fs.unlinkSync(LOCK);
    }
    fs.writeFileSync(LOCK, `${process.pid} ${new Date().toISOString()}\n`);
    process.on('exit', () => { try { fs.unlinkSync(LOCK); } catch {} });

    const dir = (task.fixtures || /\{\{dir\}\}/.test(task.sentence)) ? makeWorkdir(task) : null;
    const contact = arg('contact', process.env.EVAL_CONTACT || '');
    const sentence = task.sentence.replace(/\{\{dir\}\}/g, dir || '').replace(/\{\{contact\}\}/g, contact);

    console.log(`[eval] ${taskId} | ${system} | arm ${arm}${arg('mailbox') ? ' | ' + arg('mailbox') : ''}`);
    console.log(`[eval] sentence: ${sentence}`);

    const row = {
        ts: new Date().toISOString(), task: taskId, system, arm,
        mailbox: arg('mailbox', process.env.EVAL_MAILBOX || null),
        pass: process.env.EVAL_PASS || null,
        sentence, workdir: dir,
        tta_ms: null, ttc_ms: null, model_ms: null, tool_calls: null,
        timed_out: false, claimed: null, navigation_evidence: null,
        check: null, operator_verdict: 'pending', notes: '',
    };

    // A task about the machine's state starts from a known state, set by
    // the suite's own precondition, so its check cannot pass by accident.
    if (task.before) shell(task.before);

    const started = Date.now();
    if (task.mechanical) {
        row.claimed = null;
    } else if (system === 'jarvis') {
        await ((arg('via') || 'app') === 'bridge' ? runJarvis : runJarvisViaApp)(task, sentence, row, started);
    } else {
        await runOpenclaw(task, sentence, row, started);
    }
    const deferred = immediateCheck(task, row, dir);
    if (deferred && deferred.exportAndList) await exportAndList(deferred.exportAndList, row);
    if (row.check) console.log(`[eval] check: ${row.check.verdict} (${row.check.evidence})`);

    if (!flag('no-prompt')) {
        row.operator_verdict = await ask('Operator verdict [pass/fail/skip]: ');
        row.notes = await ask('Notes: ');
    }
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.appendFileSync(OUT, JSON.stringify(row) + '\n');
    console.log(`[eval] recorded → ${path.relative(ROOT, OUT)}`);
    process.exit(0);
}

// Through the running app's own socket: what the Mac window, a phone or
// Telegram would get. Acknowledgement is the daemon's accepted frame, the
// signal that turns the thinking indicator on. A proposal card is answered
// yes when the task says the user consents in advance; a disclosure the run
// stops to ask about is granted and the sentence asked once more.
async function exportAndList(built, row) {
    const { AppClient } = require('./appClient');
    const client = await new AppClient({ timeoutMs: 60000 }).connect();
    const exported = [];
    try {
        for (const name of built) {
            client.ws.send(JSON.stringify({ type: 'skill_export', name }));
            const result = await client.waitFor(f => f.type === 'skill_export_result' && f.name === name, 20000);
            if (result && result.status === 'exported') exported.push(name);
        }
    } finally { client.close(); }
    let listed = [];
    try { listed = JSON.parse(shell('openclaw skills list --json 2>/dev/null').out).skills.map(s => s.name); } catch {}
    const missing = built.filter(name => !listed.includes(name));
    row.skills_exported = exported;
    row.check = { verdict: built.length && !missing.length ? 'pass' : 'fail',
        evidence: `${built.length} built, ${exported.length} exported; missing from OpenClaw's listing: ${missing.join(',') || 'none'}` };
}

async function runJarvisViaApp(task, sentence, row, started) {
    const { AppClient } = require('./appClient');
    const securityStore = require('../security/store');
    const client = await new AppClient({ timeoutMs: TIMEOUT_MS }).connect();
    try {
        const names = async () => { try { return ((await client.abilities()).skills || []).map(s => s.name); } catch { return []; } };
        const before = new Set(securityStore.pendingApprovals().map(a => a.id));
        const abilitiesBefore = new Set(await names());
        const consent = Boolean(task.approve);
        let result = await client.intent(sentence, { approve: consent, timeoutMs: TIMEOUT_MS });
        const raised = securityStore.pendingApprovals().filter(a => !before.has(a.id));
        row.approved_cards = result.card ? 1 : 0;
        row.granted_disclosures = raised.length;
        if (consent && raised.length && result.status !== 'success') {
            for (const approval of raised) {
                client.ws.send(JSON.stringify({ type: 'egress_resolve', id: approval.id, decision: 'yes' }));
                await client.waitFor(f => f.type === 'egress_resolve_result' && f.id === approval.id, 10000);
            }
            console.log(`[eval] granted ${raised.length} disclosure(s); asking once more`);
            const again = await client.intent(sentence, { approve: consent, timeoutMs: TIMEOUT_MS });
            again.ackMs = result.ackMs;
            again.ms = result.ms + again.ms;
            result = again;
        }
        row.tta_ms = result.ackMs;
        row.timed_out = result.status === 'timeout';
        row.ttc_ms = row.timed_out ? null : result.ms;
        row.claimed = result.status === 'success';
        row.status = result.status || null;
        row.response = String(result.response || '').slice(0, 2000);
        row.action = result.action || null;
        const steps = (result.plan && Array.isArray(result.plan.steps)) ? result.plan.steps : [];
        row.tool_calls = steps.length || null;
        row.navigation_evidence = steps.some(s => /^(web\.|procedure\.)/.test(String(s.capability || ''))) || result.action === 'web';
        row.skills_added = (await names()).filter(n => !abilitiesBefore.has(n));
        row.via = 'app';
        console.log(`[eval] status=${row.status} tta=${row.tta_ms}ms ttc=${row.ttc_ms}ms action=${row.action} skills+=${row.skills_added.join(',') || '-'}`);
        console.log(`[eval] response: ${row.response.slice(0, 300).replace(/\s+/g, ' ')}`);
    } finally { client.close(); }
}

// In-process through the same facade every surface calls.
async function runJarvis(task, sentence, row, started) {
    const llmClient = require('../services/llmClient');
    const activityBus = require('../services/activityBus');
    const bridge = require('../services/openclawBridge');
    let modelMs = 0;
    const timed = (fn) => async (...args) => {
        const t0 = Date.now();
        try { return await fn(...args); } finally { modelMs += Date.now() - t0; }
    };
    for (const name of ['complete', 'completeJson', 'chat']) {
        if (typeof llmClient[name] === 'function') llmClient[name] = timed(llmClient[name].bind(llmClient));
    }
    let toolCalls = 0;
    let navigation = false;
    activityBus.subscribe((source) => {
        toolCalls += 1;
        if (row.tta_ms === null) row.tta_ms = Date.now() - started;
        if (/web|browse|recipe|procedure/i.test(String(source))) navigation = true;
    });
    const result = await Promise.race([
        bridge.executeIntent(sentence, { interactive: true }).catch(err => ({ status: 'error', response: String(err.message) })),
        new Promise(resolve => setTimeout(() => resolve({ status: 'timeout' }), TIMEOUT_MS)),
    ]);
    row.ttc_ms = Date.now() - started;
    if (row.tta_ms === null) row.tta_ms = row.ttc_ms;
    row.timed_out = result.status === 'timeout';
    row.claimed = result.status === 'success';
    row.status = result.status || null;
    row.response = String(result.response || '').slice(0, 2000);
    row.model_ms = modelMs;
    row.tool_calls = toolCalls;
    row.navigation_evidence = navigation;
    row.via = 'bridge';
}

// The baseline runs as itself, from its own CLI; the command template is
// configurable so a gateway change never edits this file. Every run is its
// own session.
async function runOpenclaw(task, sentence, row, started) {
    const template = process.env.EVAL_OPENCLAW_CMD || 'openclaw agent --message {TEXT}';
    const [cmd, ...rest] = template.split(' ');
    const args = rest.map(a => a === '{TEXT}' ? sentence : a);
    if (!args.some(a => /^--session/.test(a))) args.push('--session-key', `eval-${task.id}-${Date.now()}`);
    console.log(`[eval] shelling: ${cmd} ${args.join(' ')}`);
    const outcome = await new Promise(resolve => {
        const child = execFile(cmd, args, { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({ err, stdout: String(stdout), stderr: String(stderr) });
        });
        child.stdout?.once('data', () => { if (row.tta_ms === null) row.tta_ms = Date.now() - started; });
    });
    row.ttc_ms = Date.now() - started;
    if (row.tta_ms === null) row.tta_ms = row.ttc_ms;
    row.timed_out = Boolean(outcome.err && outcome.err.killed);
    const body = (outcome.stdout + '\n' + outcome.stderr).trim();
    const errored = /context overflow|GatewayClientRequestError|FailoverError|LLM request failed|\bError:/i.test(body)
        || /couldn.t generate a response|^\s*⚠️/im.test(body)
        || /<\|tool_call>|^\s*\{\s*"\w+"\s*:|"arguments"\s*:/m.test(body.split('\n').slice(-3).join('\n'));
    row.status = outcome.err ? (row.timed_out ? 'timeout' : 'error') : (errored ? 'error' : (body ? 'success' : 'empty'));
    row.claimed = row.status === 'success';
    row.response = body.slice(-600);
    row.navigation_evidence = /browser|navigate|clicked|page/i.test(outcome.stdout + outcome.stderr) || null;
    row.via = 'cli';
    console.log(`[eval] status=${row.status} tta=${row.tta_ms}ms ttc=${row.ttc_ms}ms`);
    console.log(`[eval] tail: ${outcome.stdout.slice(-300)}`);
}

function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim()); }));
}

main();
