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

const SANDBOX_PROFILE = `(version 1)
(deny default)
(allow process-exec process-fork)
(allow file-read*)
(allow file-write* (subpath "%SCRATCH%"))
(allow file-write-data (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr"))
(allow sysctl-read)
(deny network*)
`;


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
        for (const arg of parsed) {
            for (const flag of arg.flags) {
                if (flag.startsWith('--')) accepted.add(flag.slice(2));
            }
        }

        if (accepted.size === 0) return { valid: true, errors: [] };

        const errors = [];
        for (const name of declared) {
            if (accepted.has(name)) continue;

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
            await fsp.writeFile(profilePath, SANDBOX_PROFILE.replace('%SCRATCH%', scratch), 'utf8');
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
            await fsp.mkdir(path.dirname(target), { recursive: true });
            await fsp.writeFile(target, fixture.content ?? '', 'utf8');
        }

        const argv = ['python3', scriptPath];
        for (const name of parameterOrder) {
            if (name in (testCase.parameters || {})) {
                argv.push(`--${name}`, String(testCase.parameters[name]));
            }
        }

        const result = await runSandboxed(argv, scratch, timeoutMs);

        if (result.timedOut) {
            return { passed: false, reason: `timed out after ${timeoutMs}ms`, timedOut: true };
        }

        const expect = testCase.expect || {};

        const expectedCode = expect.exit_code ?? 0;
        if (result.code !== expectedCode) {
            return {
                passed: false,
                reason: `exit code ${result.code}, expected ${expectedCode}` +
                        (result.stderr ? ` — ${result.stderr.split('\n').slice(-3).join(' ')}` : '')
            };
        }

        if (expect.stdout_contains && !result.stdout.includes(expect.stdout_contains)) {
            return {
                passed: false,
                reason: `stdout did not contain "${expect.stdout_contains}" (got: "${result.stdout.slice(0, 120)}")`
            };
        }

        for (const relative of expect.files_exist || []) {
            const target = path.resolve(scratch, relative);
            if (!fs.existsSync(target)) {
                return { passed: false, reason: `expected file was not created: ${relative}` };
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

module.exports = {
    staticCheck,
    checkArgparseContract,
    verify,
    runTestCase,
    sandboxAvailable,
    FORBIDDEN_IMPORTS
};
