const { execFile } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const FORBIDDEN_IMPORTS = [
    'socket', 'urllib', 'urllib2', 'urllib3', 'requests', 'httplib', 'http.client',
    'ftplib', 'smtplib', 'telnetlib', 'xmlrpc', 'asyncio.streams', 'ctypes',
    'multiprocessing.connection'
];

const skillSandbox = require('./skillSandbox');


const MAX_TRIAL_OUTPUT_BYTES = 4 * 1024 * 1024;

function describeFailure(err) {
    if (!err) return { timedOut: false, overflowed: false };
    if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return { timedOut: false, overflowed: true };
    }
    return { timedOut: Boolean(err.killed), overflowed: false };
}

function runPython(args, options = {}) {
    return new Promise((resolve) => {
        execFile('python3', args,
            { timeout: options.timeout ?? 15000, cwd: options.cwd, maxBuffer: MAX_TRIAL_OUTPUT_BYTES },
            (err, stdout, stderr) => {
                const { timedOut, overflowed } = describeFailure(err);
                resolve({
                    ok: !err,
                    timedOut,
                    overflowed,
                    stdout: (stdout || '').trim(),
                    stderr: (stderr || '').trim() ||
                            (overflowed ? 'script produced more output than the trial allows' : ''),
                    code: err ? (err.code ?? 1) : 0
                });
            });
    });
}

async function staticCheck(scriptSource) {
    const errors = [];
    const scratch = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'jarvis-static-')));
    const scriptPath = path.join(scratch, 'candidate.py');

    try {
        await fsp.writeFile(scriptPath, scriptSource, 'utf8');

        const analyser = `
import ast, json, sys
src = open(sys.argv[1]).read()
try:
    tree = ast.parse(src)
except SyntaxError as e:
    print(json.dumps({"syntax_error": f"line {e.lineno}: {e.msg}"}))
    sys.exit(0)

imports = set()
for node in ast.walk(tree):
    if isinstance(node, ast.Import):
        for a in node.names:
            imports.add(a.name.split('.')[0])
            imports.add(a.name)
    elif isinstance(node, ast.ImportFrom):
        if node.module:
            imports.add(node.module.split('.')[0])
            imports.add(node.module)
print(json.dumps({"imports": sorted(imports)}))
`;
        const analyserPath = path.join(scratch, 'analyse.py');
        await fsp.writeFile(analyserPath, analyser, 'utf8');

        const result = await runPython([analyserPath, scriptPath]);
        if (!result.ok) {
            return { valid: false, errors: [`static analysis failed: ${result.stderr || result.stdout}`], imports: [] };
        }

        let parsed;
        try {
            parsed = JSON.parse(result.stdout);
        } catch {
            return { valid: false, errors: [`could not read analyser output: ${result.stdout}`], imports: [] };
        }

        if (parsed.syntax_error) {
            return { valid: false, errors: [`syntax error: ${parsed.syntax_error}`], imports: [], syntaxError: true };
        }

        const imports = parsed.imports || [];
        for (const imported of imports) {
            if (FORBIDDEN_IMPORTS.includes(imported)) {
                errors.push(`forbidden import "${imported}" — generated skills may not access the network or load native code`);
            }
        }

        return { valid: errors.length === 0, errors, imports };
    } finally {
        await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
}

async function checkArgparseContract(scriptSource, parameters) {
    const declared = Object.keys(parameters || {});
    if (declared.length === 0) return { valid: true, errors: [] };

    const scratch = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'jarvis-argspec-')));

    try {
        const scriptPath = path.join(scratch, 'candidate.py');
        await fsp.writeFile(scriptPath, scriptSource, 'utf8');

        const extractor = `
import ast, json, sys
tree = ast.parse(open(sys.argv[1]).read())
args = []
for node in ast.walk(tree):
    if not isinstance(node, ast.Call):
        continue
    fn = node.func
    if not (isinstance(fn, ast.Attribute) and fn.attr == 'add_argument'):
        continue
    flags = [a.value for a in node.args
             if isinstance(a, ast.Constant) and isinstance(a.value, str)]
    required = False
    for kw in node.keywords:
        if kw.arg == 'required' and isinstance(kw.value, ast.Constant):
            required = bool(kw.value.value)
    args.append({"flags": flags, "required": required})
print(json.dumps(args))
`;
        const extractorPath = path.join(scratch, 'extract.py');
        await fsp.writeFile(extractorPath, extractor, 'utf8');

        const result = await runPython([extractorPath, scriptPath]);
        if (!result.ok) return { valid: true, errors: [] };

        let parsed;
        try {
            parsed = JSON.parse(result.stdout);
        } catch {
            return { valid: true, errors: [] };
        }

        const accepted = new Set();
        const positional = new Set();
        for (const arg of parsed) {
            for (const flag of arg.flags) {
                if (flag.startsWith('--')) accepted.add(flag.slice(2));
                else if (!flag.startsWith('-')) positional.add(flag);
            }
        }

        if (accepted.size === 0 && positional.size === 0) return { valid: true, errors: [] };

        const errors = [];
        for (const name of declared) {
            if (accepted.has(name)) continue;
            if (positional.has(name) || positional.has(name.replace(/_/g, '-'))) {
                errors.push(
                    `parameter "${name}" is read as a positional argument (add_argument("${name}")), but the skill is ` +
                    `invoked with option flags: declare it as add_argument("--${name}").`
                );
                continue;
            }

            const hyphenated = name.replace(/_/g, '-');
            if (accepted.has(hyphenated)) {
                errors.push(
                    `parameter "${name}" is declared, but the script accepts "--${hyphenated}". ` +
                    `The script must use argparse flag "--${name}", matching the declared name exactly ` +
                    `(underscores, not hyphens).`
                );
            } else {
                errors.push(
                    `parameter "${name}" is declared, but the script never accepts "--${name}" ` +
                    `(it accepts: ${[...accepted].map(a => '--' + a).join(', ') || 'nothing'}).`
                );
            }
        }

        return { valid: errors.length === 0, errors };
    } finally {
        await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
}


function sandboxAvailable() {
    return fs.existsSync('/usr/bin/sandbox-exec');
}

async function runSandboxed(argv, scratch, timeoutMs) {
    let command = argv[0];
    let args = argv.slice(1);

    if (sandboxAvailable()) {
        const profilePath = path.join(scratch, '.sandbox.sb');
        try {
            await fsp.writeFile(profilePath, skillSandbox.buildTrialProfile(scratch), 'utf8');
            command = 'sandbox-exec';
            args = ['-f', profilePath, ...argv];
        } catch (err) {
            return { ok: false, timedOut: false, stdout: '', code: 1,
                     stderr: `could not write sandbox profile: ${err.message}` };
        }
    } else {
        console.warn('[SkillVerifier] sandbox-exec unavailable — running trial unconfined.');
    }

    return new Promise((resolve) => {
        execFile(command, args, {
            timeout: timeoutMs,
            cwd: scratch,
            env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch },
            maxBuffer: MAX_TRIAL_OUTPUT_BYTES
        }, (err, stdout, stderr) => {
            const { timedOut, overflowed } = describeFailure(err);
            resolve({
                ok: !err,
                timedOut,
                overflowed,
                stdout: (stdout || '').trim(),
                stderr: (stderr || '').trim() ||
                        (overflowed ? 'script produced more output than the trial allows' : ''),
                code: err ? (err.code ?? 1) : 0
            });
        });
    });
}

async function runTestCase(scriptSource, testCase, parameterOrder, timeoutMs) {
    const scratch = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'jarvis-verify-')));

    try {
        const scriptPath = path.join(scratch, 'run.py');
        await fsp.writeFile(scriptPath, scriptSource, 'utf8');

        for (const fixture of testCase.fixtures || []) {
            const target = path.resolve(scratch, fixture.path);
            if (!target.startsWith(scratch + path.sep)) {
                return { passed: false, reason: `fixture path escapes the scratch directory: ${fixture.path}` };
            }
            try {
                if (/[\\/]$/.test(String(fixture.path))) {
                    await fsp.mkdir(target, { recursive: true });
                    continue;
                }
                await fsp.mkdir(path.dirname(target), { recursive: true });
                await fsp.writeFile(target, fixture.content ?? '', 'utf8');
            } catch (err) {
                return { passed: false, reason: `fixture "${fixture.path}" cannot be written (${err.code || err.message}): `
                    + 'a fixture path is being used both as a file and as a directory; declare files only, folders are created for them' };
            }
        }

        const argv = ['python3', scriptPath];
        for (const name of parameterOrder) {
            if (name in (testCase.parameters || {})) {
                argv.push(`--${name}`, String(testCase.parameters[name]));
            }
        }

        const result = await runSandboxed(argv, scratch, timeoutMs);

        // What actually happened, so a repair attempt can debug instead of guess.
        const cap = text => String(text || '').slice(0, 1500);
        const context = {
            argv: ['run.py', ...argv.slice(2)].join(' '),
            stdout: cap(result.stdout),
            stderr: cap(result.stderr)
        };

        if (result.timedOut) {
            return { passed: false, reason: `timed out after ${timeoutMs}ms`, timedOut: true, ...context };
        }

        const expect = testCase.expect || {};

        const expectedCode = expect.exit_code ?? 0;
        if (result.code !== expectedCode) {
            return {
                passed: false,
                reason: `exit code ${result.code}, expected ${expectedCode}`,
                ...context
            };
        }

        if (expect.stdout_contains && !result.stdout.includes(expect.stdout_contains)) {
            return {
                passed: false,
                reason: `stdout did not contain "${expect.stdout_contains}"`,
                ...context
            };
        }

        for (const relative of expect.files_exist || []) {
            const target = path.resolve(scratch, relative);
            if (!target.startsWith(scratch + path.sep)) {
                return { passed: false, reason: `expected file path escapes the scratch directory: ${relative}`, ...context };
            }
            if (!fs.existsSync(target)) {
                return { passed: false, reason: `expected file was not created: ${relative}`, ...context };
            }
        }

        for (const relative of expect.files_missing || []) {
            const target = path.resolve(scratch, relative);
            if (!target.startsWith(scratch + path.sep)) {
                return { passed: false, reason: `expected-missing path escapes the scratch directory: ${relative}`, ...context };
            }
            if (fs.existsSync(target)) {
                return { passed: false, reason: `expected path still exists: ${relative}`, ...context };
            }
        }

        return { passed: true, stdout: result.stdout };
    } finally {
        await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
}

async function verify(scriptSource, tests, parameterOrder, timeoutMs = 30000) {
    if (!Array.isArray(tests) || tests.length === 0) {
        return { passed: false, results: [], summary: 'no test cases were authored' };
    }

    const results = [];
    for (const [index, testCase] of tests.entries()) {
        const name = testCase.name || `case ${index + 1}`;
        const outcome = await runTestCase(scriptSource, testCase, parameterOrder, timeoutMs);
        results.push({ name, ...outcome });
        console.log(`[SkillVerifier]   ${outcome.passed ? 'PASS' : 'FAIL'} — ${name}` +
                    (outcome.passed ? '' : `: ${outcome.reason}`));
    }

    const failed = results.filter(r => !r.passed);
    return {
        passed: failed.length === 0,
        results,
        timedOut: results.some(r => r.timedOut),
        summary: failed.length
            ? `${failed.length}/${results.length} case(s) failed: ${failed.map(f => f.reason).join('; ')}`
            : `all ${results.length} case(s) passed`
    };
}

const GROUNDED_MAX_BYTES = 10 * 1024 * 1024;
const GROUNDED_MAX_FILES = 200;

function extractRequestPaths(request) {
    const matches = String(request).match(/(?:~\/|\/(?:Users|tmp|private|var|Volumes)\/)[^\s"',;]+/g) || [];
    const found = matches
        .map(p => p.replace(/[).:]+$/, ''))
        .map(p => p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
    for (const bare of String(request).match(/(?<![\/\w.~-])[\w][\w.-]*\.(?:csv|tsv|txt|json|md|log|xlsx?|pdf|docx?)\b/gi) || []) {
        try {
            const hit = require('./fileIndex').search({ text: bare, limit: 5 })
                .find(row => String(row.name).toLowerCase() === bare.toLowerCase());
            if (hit && !found.includes(hit.path)) found.push(hit.path);
        } catch { /* without an index the bare name stays a name */ }
    }
    return found;
}

const DID_NOTHING =
    /\b(?:does not contain|not found|no such|missing|invalid|unsupported|could not|cannot|unable|no (?:rows|data|records|columns|entries|matches)|nothing)\b/i;
function emptyResult(stdout) {
    const text = String(stdout || '');
    const line = text.split('\n').find(l => l.startsWith('JARVIS_RESULT'));
    if (!line) {
        const numbers = text.match(/-?\d+(?:\.\d+)?/g);
        return Boolean(numbers && numbers.length && numbers.every(n => Number(n) === 0));
    }
    try {
        const values = Object.values(JSON.parse(line.replace(/^JARVIS_RESULT\s*/, '')));
        return values.length > 0 && values.every(v => v === 0 || v === null || v === ''
            || (Array.isArray(v) && v.length === 0) || (v && typeof v === 'object' && !Object.keys(v).length));
    } catch { return false; }
}

function pickPathParameter(parameters) {
    const strings = Object.entries(parameters || {})
        .filter(([, spec]) => !spec || !spec.type || spec.type === 'string');
    const named = strings.filter(([name, spec]) =>
        /path|file|folder|dir|input|source/i.test(`${name} ${spec?.description || ''}`));
    if (named.length === 1) return named[0][0];
    if (strings.length === 1) return strings[0][0];
    return null;
}

function measure(target) {
    const stat = fs.statSync(target);
    if (stat.isFile()) return { bytes: stat.size, files: 1 };
    let bytes = 0, files = 0;
    const queue = [target];
    while (queue.length) {
        const dir = queue.pop();
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isSymbolicLink()) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) queue.push(full);
            else {
                bytes += fs.statSync(full).size;
                files += 1;
                if (bytes > GROUNDED_MAX_BYTES || files > GROUNDED_MAX_FILES) return { bytes, files };
            }
        }
    }
    return { bytes, files };
}

// Runs the verified script once against a copy of data the request itself
// names. Passing its own authored tests proves the script runs; this proves it
// runs on what the user actually has. Only fires when the mapping is
// unambiguous — a wrong guess would reject good skills.
async function groundedTrial(candidate, request, timeoutMs) {
    const source = extractRequestPaths(request).find(p => fs.existsSync(p));
    if (!source) return { skipped: true, why: 'the request names no existing path' };
    if (skillSandbox.isSensitivePath(source) || require('../security/classifier').secretCheck(source).secret) {
        return { skipped: true, why: `${path.basename(source)} is not something a trial may copy` };
    }

    const paramName = pickPathParameter(candidate.parameters);
    if (!paramName) return { skipped: true, why: 'no unambiguous path parameter' };

    const blockers = Object.entries(candidate.parameters || {})
        .filter(([name, spec]) => name !== paramName && spec?.required && spec.default === undefined);
    if (blockers.length) return { skipped: true, why: `cannot invent values for: ${blockers.map(([n]) => n).join(', ')}` };

    let size;
    try { size = measure(source); } catch (err) {
        return { skipped: true, why: `cannot read ${source}: ${err.message}` };
    }
    if (size.bytes > GROUNDED_MAX_BYTES || size.files > GROUNDED_MAX_FILES) {
        return { skipped: true, why: `${path.basename(source)} is too large for a trial copy` };
    }

    const scratch = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'jarvis-grounded-')));
    try {
        const copy = path.join(scratch, path.basename(source));
        fs.cpSync(source, copy, { recursive: true });

        const scriptPath = path.join(scratch, 'run.py');
        await fsp.writeFile(scriptPath, candidate.script, 'utf8');

        const argv = ['python3', scriptPath, `--${paramName}`, copy];
        const result = await runSandboxed(argv, scratch, timeoutMs);

        if (result.timedOut) {
            return { passed: false, reason: `grounded trial on ${path.basename(source)} timed out after ${timeoutMs}ms` };
        }
        const dataHead = () => {
            try {
                return fs.statSync(source).isFile()
                    ? fs.readFileSync(source, 'utf8').split('\n').slice(0, 4).join('\n').slice(0, 400) : '';
            } catch { return ''; }
        };
        if (result.code !== 0) {
            const cap = text => String(text || '').slice(0, 1500);
            const head = dataHead();
            return {
                passed: false,
                reason: `the script passed its own tests but failed on the request's own data ` +
                        `(a copy of ${path.basename(source)}): exit code ${result.code}` +
                        (head ? `; read the data as it actually is, which begins:\n${head}` : ''),
                argv: `run.py --${paramName} ${path.basename(source)}`,
                stdout: cap(result.stdout),
                stderr: cap(result.stderr)
            };
        }
        if (DID_NOTHING.test(result.stdout) || emptyResult(result.stdout)) {
            const cap = text => String(text || '').slice(0, 1500);
            const head = dataHead();
            return {
                passed: false,
                reason: `the script passed its own tests but found nothing in the request's own data ` +
                        `(a copy of ${path.basename(source)}); read the data as it actually is` +
                        (head ? `, which begins:\n${head}` : ''),
                argv: `run.py --${paramName} ${path.basename(source)}`,
                stdout: cap(result.stdout),
                stderr: cap(result.stderr)
            };
        }
        return { passed: true, source: path.basename(source) };
    } finally {
        await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
}

module.exports = {
    staticCheck,
    checkArgparseContract,
    verify,
    runTestCase,
    groundedTrial,
    extractRequestPaths,
    pickPathParameter,
    sandboxAvailable,
    FORBIDDEN_IMPORTS
};
