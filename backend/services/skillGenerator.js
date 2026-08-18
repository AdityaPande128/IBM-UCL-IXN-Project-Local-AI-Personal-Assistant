const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');

const configReader = require('../utils/configReader');
const activityBus = require('./activityBus');
const llmClient = require('./llmClient');
const skillRegistry = require('./skillRegistry');
const skillPins = require('./skillPins');
const verifier = require('./skillVerifier');
const ledger = require('./generationLog');
const { parseWithRepair } = require('../utils/jsonRepair');

const config = configReader.readConfig();
const genConfig = config.generation || {};

const TIER = 'smith';

const MODEL = llmClient.modelForTier(TIER) || genConfig.model || config.model_id;
const TEMPERATURE = genConfig.temperature ?? 0.2;
const MAX_TOKENS = genConfig.max_tokens ?? 2400;
const TIMEOUT_MS = genConfig.timeout_ms ?? 240000;
const MAX_ATTEMPTS = genConfig.max_attempts ?? 3;
const VERIFY_TIMEOUT_MS = genConfig.verify_timeout_ms ?? 30000;

const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;


function buildPrompt(existingSkills) {
    const taken = existingSkills.map(s => s.name).join(', ') || '(none)';

    return `You author new skills for a local macOS automation agent. Given a user request that no installed skill covers, you write a self-contained Python script that performs it, plus the metadata describing how to call it.

Respond in TWO parts, in this order.

PART 1 — a JSON object with the metadata. Do NOT include the script here:
{
  "name": "<kebab-case-identifier>",
  "description": "<one sentence, written for a router that must decide when to pick this skill>",
  "parameters": {
    "<param_name>": {
      "type": "string" | "number" | "boolean" | "enum",
      "required": true | false,
      "description": "<what it is>",
      "values": ["..."]            // enum only
    }
  },
  "reply": "<short confirmation shown BEFORE the script runs. It may only use {{param_name}} tokens naming declared INPUT parameters. It must NOT name a result — {{count}}, {{total}}, {{file}} for something the script computes is rejected, because nothing can substitute a value that does not exist yet. Whatever the script prints is appended automatically, so the answer reaches the user without the reply mentioning it.>",
  "tests": [
    {
      "name": "<what this case checks>",
      "fixtures": [ { "path": "relative/file.txt", "content": "..." } ],
      "parameters": { "<param_name>": "<value>" },
      "expect": {
        "exit_code": 0,
        "stdout_contains": "<shortest distinctive substring, like '3' or 'output.csv' — never a sentence>",
        "files_exist": ["relative/output.txt"]
      }
    }
  ]
}

PART 2 — the complete Python 3 source, in a fenced block:

\`\`\`python
<your script here>
\`\`\`

Write the script ONLY inside that fenced block. Never place source code inside the
JSON — quotes and backslashes in code do not survive JSON string escaping.

Rules for the script:
1. Python 3 only, standard library only. No third-party packages.
2. Read parameters with argparse. Each flag MUST be the declared parameter name verbatim, including underscores — a parameter named "output_csv" is read as add_argument("--output_csv"), NOT "--output-csv". Do not convert underscores to hyphens.
3. NEVER import socket, urllib, requests, http.client, ftplib, smtplib, or ctypes. The skill must not access the network.
4. Print a short human-readable summary of what was done to stdout. Exit non-zero on failure.
5. Expand a leading ~ in any path argument with os.path.expanduser.
6. Do not delete or overwrite user data unless the request explicitly asks for it.
7. If the skill's outcome is a file the user will open, the script's LAST stdout line must be the marker JARVIS_RESULT followed by one JSON object naming it, like: JARVIS_RESULT {"files": ["/absolute/path/to/output.csv"]} — one line, nothing after it. Skills that only report an answer print no marker.

Rules for "tests":
8. Author at least one test case. Tests run in a throwaway directory — declare any input files the script needs in "fixtures", using relative paths.
9. Parameters in a test case must use paths relative to that directory, so the case is self-contained. Do not reference real user files.
10. The assertions must actually demonstrate the skill worked, not merely that it ran.
11. Compute each expected value by hand from the fixture content before writing it down — a test that asserts a wrong expectation rejects a correct script.
12. In "stdout_contains", assert the smallest distinctive substring (a number, a filename), never a full sentence — you will not phrase the sentence identically in the script.

Already installed: ${taken}

Rules for "name": kebab-case, lowercase, descriptive of the action. If the request is already covered by an installed skill, reuse that skill's exact name — do not invent a variant.`;
}

const REPAIR_TEMPLATE = `That attempt was rejected. Reason:

%REASON%

Respond again in the SAME two-part format: PART 1, the complete corrected JSON
metadata object — every field, not only what changed — then PART 2, the complete
corrected Python script in its fenced block. A reply missing either part is
itself a rejected attempt, and there are only a few.`;

function describeVerificationFailure(verification) {
    const lines = [];
    for (const r of verification.results || []) {
        if (r.passed) {
            lines.push(`PASS ${r.name} — do not break this case while fixing the others.`);
            continue;
        }
        lines.push(`FAIL ${r.name}: ${r.reason}`);
        if (r.argv) lines.push(`  ran: ${r.argv}`);
        if (r.stdout) lines.push(`  stdout: ${r.stdout}`);
        if (r.stderr) lines.push(`  stderr: ${r.stderr}`);
    }
    lines.push('Diagnose the failure from the output above — especially any traceback — before rewriting. '
        + 'If the test\'s expectation is itself wrong — recompute it by hand from the fixtures — fix the test, not the script.');
    return lines.join('\n').slice(0, 4000);
}


async function callModel(messages, attempt = 1) {
    try {
        // Warmer on each retry: at low temperature a rejected attempt tends to be
        // reproduced verbatim, and a repair loop that regenerates the same
        // envelope three times is just a slow rejection.
        return await llmClient.complete(messages, {
            tier: TIER,
            temperature: Math.min(0.7, TEMPERATURE + 0.2 * (attempt - 1)),
            max_tokens: MAX_TOKENS,
            timeout_ms: TIMEOUT_MS
        });
    } catch (err) {
        if (err.message === 'timeout') {
            throw new Error(`generation timed out after ${Math.round(TIMEOUT_MS / 1000)}s`);
        }
        throw err;
    }
}

function extractJson(raw) {
    const text = String(raw || '').trim();

    let script = null;
    const fencePattern = /```([a-zA-Z]*)\s*\n([\s\S]*?)```/g;
    for (const match of text.matchAll(fencePattern)) {
        const language = (match[1] || '').toLowerCase();
        const body = match[2];
        if (language === 'json') continue;
        if (!language && body.trim().startsWith('{')) continue;
        script = body.replace(/\s+$/, '');
        break;
    }

    const candidates = [];
    const jsonFence = text.match(/```json\s*\n([\s\S]*?)```/);
    if (jsonFence) candidates.push(jsonFence[1].trim());

    const withoutFences = text.replace(/```[\s\S]*?```/g, '');
    const bracedOutside = withoutFences.match(/\{[\s\S]*\}/);
    if (bracedOutside) candidates.push(bracedOutside[0]);

    const braced = text.match(/\{[\s\S]*\}/);
    if (braced) candidates.push(braced[0]);
    candidates.push(text);

    for (const candidate of candidates) {
        const { value, repaired } = parseWithRepair(candidate);
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            if (repaired) {
                console.log('[SkillGenerator] Metadata had invalid escapes; repaired.');
                value.__envelopeRepaired = true;
            }
            if (script) value.script = script;
            return value;
        }
    }
    return null;
}


function validateEnvelope(candidate) {
    const errors = [];

    if (!candidate.name || typeof candidate.name !== 'string') {
        errors.push('missing "name"');
    } else if (!SKILL_NAME.test(candidate.name)) {
        errors.push(`"name" must be kebab-case (got "${candidate.name}")`);
    }

    if (!candidate.description || typeof candidate.description !== 'string') {
        errors.push('missing "description"');
    }
    if (!candidate.script || typeof candidate.script !== 'string') {
        errors.push('missing "script"');
    }
    if (candidate.parameters && typeof candidate.parameters !== 'object') {
        errors.push('"parameters" must be an object');
    }
    if (!Array.isArray(candidate.tests) || candidate.tests.length === 0) {
        errors.push('at least one test case is required');
    }

    for (const [name, spec] of Object.entries(candidate.parameters || {})) {
        if (!/^[a-z][a-z0-9_]*$/.test(name)) {
            errors.push(`parameter "${name}" must be lower_snake_case`);
        }
        if (!spec || !spec.type) {
            errors.push(`parameter "${name}" is missing a type`);
        }
    }

    const required = Object.entries(candidate.parameters || {})
        .filter(([, spec]) => spec && spec.required)
        .map(([name]) => name);

    for (const [index, testCase] of (candidate.tests || []).entries()) {
        const supplied = Object.keys(testCase?.parameters || {});
        const missing = required.filter(name => !supplied.includes(name));
        if (missing.length) {
            errors.push(
                `test case ${index + 1} ("${testCase?.name || 'unnamed'}") does not supply required ` +
                `parameter(s): ${missing.join(', ')} — every required parameter must appear in each test case`
            );
        }

        // A full-sentence assertion couples the test to phrasing the script will
        // never reproduce exactly; attempts then burn on wording instead of logic.
        const asserted = testCase?.expect?.stdout_contains;
        if (typeof asserted === 'string' && asserted.length > 40 && asserted.split(' ').length > 6) {
            errors.push(
                `test case ${index + 1} asserts a full sentence in stdout_contains ` +
                `("${asserted.slice(0, 60)}…") — assert the smallest distinctive substring ` +
                `(a number, a filename), not prose the script must reproduce word for word`
            );
        }
    }

    return { valid: errors.length === 0, errors };
}

function buildManifest(candidate, imports) {
    const parameterNames = Object.keys(candidate.parameters || {});

    const argv = ['python3', '{{__dir__}}/run.py'];
    for (const name of parameterNames) {
        argv.push(`--${name}`, `{{${name}}}`);
    }

    const manifest = {
        name: candidate.name,
        version: '1.0.0',
        description: candidate.description.trim(),
        parameters: candidate.parameters || {},
        exec: { type: 'script', argv, timeout_ms: 60000 },
        reply: candidate.reply || 'Done.',
        capabilities: {
            exec: true,
            filesystem: candidate.capabilities?.filesystem || [],
            network: false
        },
        provenance: {
            author: 'generated',
            generated_at: new Date().toISOString(),
            model: MODEL,
            source_prompt: candidate.__sourcePrompt,
            imports
        }
    };

    return manifest;
}

function toYaml(value, indent = 0) {
    const pad = '  '.repeat(indent);

    if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        return '\n' + value.map(v => `${pad}- ${JSON.stringify(v)}`).join('\n');
    }
    if (value && typeof value === 'object') {
        const lines = [];
        for (const [key, val] of Object.entries(value)) {
            if (val === undefined) continue;
            if (val && typeof val === 'object' && !Array.isArray(val)) {
                lines.push(`${pad}${key}:`);
                lines.push(toYaml(val, indent + 1));
            } else if (Array.isArray(val)) {
                lines.push(`${pad}${key}: ${val.length ? JSON.stringify(val) : '[]'}`);
            } else {
                lines.push(`${pad}${key}: ${JSON.stringify(val)}`);
            }
        }
        return lines.join('\n');
    }
    return `${pad}${JSON.stringify(value)}`;
}

function renderSkillMd(manifest, candidate) {
    return `---
${toYaml(manifest)}
---

# ${manifest.name}

${manifest.description}

## Provenance

Generated on ${manifest.provenance.generated_at} by \`${manifest.provenance.model}\`
in response to:

> ${candidate.__sourcePrompt}

Verified against ${candidate.tests.length} authored test case(s) in a sandbox that
denies network access and confines writes to a scratch directory.
`;
}


async function writeSkill(manifest, candidate) {
    const dir = path.join(skillRegistry.SKILLS_DIR, manifest.name);
    await fs.mkdir(dir, { recursive: true });

    await fs.writeFile(path.join(dir, 'SKILL.md'), renderSkillMd(manifest, candidate), 'utf8');
    await fs.writeFile(path.join(dir, 'run.py'), candidate.script, 'utf8');
    await fs.writeFile(path.join(dir, 'test.json'), JSON.stringify(candidate.tests, null, 2), 'utf8');

    return dir;
}


async function generate(request, options = {}) {
    const startedAt = Date.now();

    // A machine whose memory class maps no smith tier builds nothing. The
    // generic generation.model fallback must not answer here: it names a
    // model this class may not be able to hold at all.
    if (!llmClient.modelForTier(TIER)) {
        return { status: 'error',
                 reason: 'This machine\'s memory class maps no builder model, '
                     + 'so new skills cannot be written here.',
                 attempts: 0 };
    }

    const gaps = (options.gaps || []).filter(Boolean);
    const userTurn = gaps.length
        ? `${request}\n\nThis was attempted with the existing skills and could not be ` +
          `done. What is missing: ${gaps.join('; ')}. Write the skill that fills that gap.`
        : request;

    const messages = [
        { role: 'system', content: buildPrompt(skillRegistry.list()) },
        { role: 'user', content: userTurn }
    ];

    let lastReason = null;
    let stage = ledger.STAGES.REQUESTED;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        console.log(`[SkillGenerator] Attempt ${attempt}/${MAX_ATTEMPTS} (${request.length} chars)`);
        activityBus.publish('generator', 'attempt', { attempt, of: MAX_ATTEMPTS });

        stage = ledger.STAGES.MODEL_CALL;
        let raw;
        try {
            raw = await callModel(messages, attempt);
        } catch (err) {
            ledger.append({
                request, outcome: 'rejected', stage,
                failure: ledger.FAILURES.MODEL_UNREACHABLE,
                detail: err.message, attempts: attempt,
                durationMs: Date.now() - startedAt
            });
            return { status: 'error', reason: `The generator model is unreachable: ${err.message}`, attempts: attempt };
        }

        const candidate = extractJson(raw);
        if (!candidate) {
            lastReason = 'the response was not valid JSON';
            console.warn(`[SkillGenerator] Attempt ${attempt}: unparseable response.`);
            if (attempt === MAX_ATTEMPTS) {
                ledger.append({
                    request, outcome: 'rejected', stage: ledger.STAGES.MODEL_CALL,
                    failure: ledger.FAILURES.UNPARSEABLE, detail: lastReason,
                    attempts: attempt, durationMs: Date.now() - startedAt
                });
                break;
            }
            messages.push({ role: 'assistant', content: raw });
            messages.push({ role: 'user', content: REPAIR_TEMPLATE.replace('%REASON%', lastReason) });
            continue;
        }
        candidate.__sourcePrompt = request;
        stage = ledger.STAGES.PARSED;

        const existing = skillRegistry.resolveName(candidate.name);
        if (existing) {
            console.log(`[SkillGenerator] "${existing}" already covers this request; reusing it.`);
            ledger.append({
                request, outcome: 'reused', stage,
                skill: existing, attempts: attempt,
                durationMs: Date.now() - startedAt
            });
            return { status: 'duplicate', skill: existing, attempts: attempt,
                     durationMs: Date.now() - startedAt };
        }

        const envelope = validateEnvelope(candidate);
        if (!envelope.valid) {
            lastReason = envelope.errors.join('; ');
            console.warn(`[SkillGenerator] Attempt ${attempt}: invalid envelope — ${lastReason}`);
            if (attempt === MAX_ATTEMPTS) {
                ledger.append({
                    request, outcome: 'rejected', stage,
                    failure: envelope.errors.some(e => e.includes('already exists'))
                        ? ledger.FAILURES.NAME_COLLISION
                        : (envelope.errors.some(e => e.includes('test')) ? ledger.FAILURES.NO_TESTS : ledger.FAILURES.SCHEMA_INVALID),
                    detail: lastReason, attempts: attempt,
                    candidate_name: candidate.name,
                    durationMs: Date.now() - startedAt
                });
                break;
            }
            messages.push({ role: 'assistant', content: raw });
            messages.push({ role: 'user', content: REPAIR_TEMPLATE.replace('%REASON%', lastReason) });
            continue;
        }

        stage = ledger.STAGES.STATIC_CHECK;
        const statics = await verifier.staticCheck(candidate.script);

        if (statics.valid) {
            const contract = await verifier.checkArgparseContract(candidate.script, candidate.parameters);
            if (!contract.valid) {
                statics.valid = false;
                statics.errors = contract.errors;
            }
        }

        if (!statics.valid) {
            lastReason = statics.errors.join('; ');
            console.warn(`[SkillGenerator] Attempt ${attempt}: static check failed — ${lastReason}`);
            if (attempt === MAX_ATTEMPTS) {
                ledger.append({
                    request, outcome: 'rejected', stage,
                    failure: statics.syntaxError ? ledger.FAILURES.SYNTAX_ERROR : ledger.FAILURES.FORBIDDEN_IMPORT,
                    detail: lastReason, attempts: attempt,
                    candidate_name: candidate.name,
                    durationMs: Date.now() - startedAt
                });
                break;
            }
            messages.push({ role: 'assistant', content: raw });
            messages.push({ role: 'user', content: REPAIR_TEMPLATE.replace('%REASON%', lastReason) });
            continue;
        }

        stage = ledger.STAGES.VERIFIED;
        console.log(`[SkillGenerator] Verifying "${candidate.name}" against ${candidate.tests.length} case(s)...`);
        activityBus.publish('generator', 'verifying', { skill: candidate.name, cases: candidate.tests.length });
        const verification = await verifier.verify(
            candidate.script,
            candidate.tests,
            Object.keys(candidate.parameters || {}),
            VERIFY_TIMEOUT_MS
        );

        if (!verification.passed) {
            lastReason = verification.summary;
            console.warn(`[SkillGenerator] Attempt ${attempt}: verification failed — ${lastReason}`);
            activityBus.publish('generator', 'tests_failed', { attempt, reason: lastReason });
            if (attempt === MAX_ATTEMPTS) {
                ledger.append({
                    request, outcome: 'rejected', stage,
                    failure: verification.timedOut
                        ? ledger.FAILURES.VERIFICATION_TIMEOUT
                        : ledger.FAILURES.VERIFICATION_FAILED,
                    detail: lastReason, attempts: attempt,
                    candidate_name: candidate.name,
                    test_results: verification.results,
                    durationMs: Date.now() - startedAt
                });
                break;
            }
            messages.push({ role: 'assistant', content: raw });
            messages.push({ role: 'user',
                content: REPAIR_TEMPLATE.replace('%REASON%', () => describeVerificationFailure(verification)) });
            continue;
        }

        const grounded = await verifier.groundedTrial(candidate, request, VERIFY_TIMEOUT_MS);
        if (grounded.skipped) {
            console.log(`[SkillGenerator] Grounded trial skipped: ${grounded.why}`);
        } else if (!grounded.passed) {
            lastReason = grounded.reason;
            console.warn(`[SkillGenerator] Attempt ${attempt}: grounded trial failed — ${lastReason}`);
            activityBus.publish('generator', 'tests_failed', { attempt, reason: lastReason, grounded: true });
            if (attempt === MAX_ATTEMPTS) {
                ledger.append({
                    request, outcome: 'rejected', stage,
                    failure: ledger.FAILURES.GROUNDED_FAILED,
                    detail: lastReason, attempts: attempt,
                    candidate_name: candidate.name,
                    durationMs: Date.now() - startedAt
                });
                break;
            }
            messages.push({ role: 'assistant', content: raw });
            messages.push({ role: 'user',
                content: REPAIR_TEMPLATE.replace('%REASON%',
                    () => describeVerificationFailure({ results: [{ name: 'grounded trial', ...grounded }] })) });
            continue;
        } else {
            console.log(`[SkillGenerator] Grounded trial passed on ${grounded.source}.`);
        }

        stage = ledger.STAGES.REGISTERED;
        const manifest = buildManifest(candidate, statics.imports);

        let dir;
        try {
            dir = await writeSkill(manifest, candidate);
        } catch (err) {
            ledger.append({
                request, outcome: 'rejected', stage,
                failure: ledger.FAILURES.WRITE_FAILED, detail: err.message,
                attempts: attempt, candidate_name: candidate.name,
                durationMs: Date.now() - startedAt
            });
            return { status: 'error', reason: `Could not save the skill: ${err.message}`, attempts: attempt };
        }

        skillRegistry.reload();

        if (!skillRegistry.has(manifest.name)) {
            const rejection = skillRegistry.errors().find(e => e.skill === manifest.name);
            const detail = rejection ? rejection.errors.join('; ') : 'registry rejected the assembled manifest';
            await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
            skillRegistry.reload();

            lastReason = detail;
            console.warn(`[SkillGenerator] Attempt ${attempt}: registry rejected the manifest — ${detail}`);

            if (attempt < MAX_ATTEMPTS) {
                messages.push({ role: 'assistant', content: raw });
                messages.push({
                    role: 'user',
                    content: REPAIR_TEMPLATE.replace('%REASON%', () =>
                        `${detail}. Every {{token}} in "reply" must be one of the declared parameter names; ` +
                        `do not reference computed values there.`)
                });
                continue;
            }

            ledger.append({
                request, outcome: 'rejected', stage,
                failure: ledger.FAILURES.SCHEMA_INVALID, detail,
                attempts: attempt, candidate_name: manifest.name,
                durationMs: Date.now() - startedAt
            });
            return { status: 'rejected', reason: detail, attempts: attempt };
        }

        skillPins.pin(manifest.name, dir, manifest.version);

        const durationMs = Date.now() - startedAt;
        ledger.append({
            request, outcome: 'registered', stage,
            skill: manifest.name, attempts: attempt,
            tests_passed: verification.results.length,
            imports: statics.imports,
            durationMs
        });

        console.log(`[SkillGenerator] Registered "${manifest.name}" after ${attempt} attempt(s) in ${durationMs}ms.`);
        activityBus.publish('generator', 'installed', { skill: manifest.name, attempts: attempt, ms: durationMs });

        return {
            status: 'registered',
            skill: manifest.name,
            description: manifest.description,
            parameters: Object.keys(manifest.parameters),
            testsPassed: verification.results.length,
            attempts: attempt,
            durationMs
        };
    }

    return {
        status: 'rejected',
        reason: lastReason || 'the generated skill could not be verified',
        attempts: MAX_ATTEMPTS,
        durationMs: Date.now() - startedAt
    };
}

module.exports = {
    generate,
    buildPrompt,
    validateEnvelope,
    buildManifest,
    renderSkillMd,
    extractJson,
    toYaml,
    describeVerificationFailure,
    REPAIR_TEMPLATE
};
