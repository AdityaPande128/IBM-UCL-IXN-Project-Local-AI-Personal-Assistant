#!/usr/bin/env node
// Runs every unit suite the project owns — daemon, inference server, iOS kit, Android client —
// strictly one after another, and writes the inventory the report's testing
// chapter cites: docs/measurements/test-inventory.{json,md}. Numbers come
// from each runner's own summary line, never estimated.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'docs', 'measurements');
const IOS = '/Users/adityapande/Coding/UCL-IBM-IXN-iOS-App/JarvisKit';
const ANDROID = '/Users/adityapande/Coding/UCL-IBM-IXN-Android-App';

function run(cmd, args, cwd, env = {}) {
    const started = Date.now();
    let output = '';
    let failed = false;
    try {
        output = execFileSync(cmd, args, {
            cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
            env: { ...process.env, ...env },
        });
    } catch (err) {
        failed = true;
        output = String(err.stdout || '') + String(err.stderr || '');
    }
    return { output, failed, seconds: (Date.now() - started) / 1000 };
}

function backend() {
    const result = run('node', ['--test', 'tests/**/*.test.js'], path.join(ROOT, 'backend'));
    const grab = (name) => {
        const m = result.output.match(new RegExp(`^ℹ ${name} (\\d+)`, 'm'));
        return m ? Number(m[1]) : null;
    };
    return {
        component: 'Mac daemon (Node.js)',
        runner: 'node --test',
        files: fs.readdirSync(path.join(ROOT, 'backend', 'tests'))
            .filter(f => f.endsWith('.test.js')).length,
        tests: grab('tests'), pass: grab('pass'), fail: grab('fail'),
        skipped: grab('skipped'),
        seconds: result.seconds,
    };
}

function inference() {
    const dir = path.join(ROOT, 'backend', 'inference');
    const result = run('python3', ['-m', 'pytest', '-q', '-p', 'no:cacheprovider'], dir);
    const m = /(\d+) passed(?:, (\d+) failed)?(?:, (\d+) skipped)?/.exec(result.output);
    const pass = m ? Number(m[1]) : null;
    const fail = m && m[2] ? Number(m[2]) : (m ? 0 : null);
    const skipped = m && m[3] ? Number(m[3]) : 0;
    return {
        component: 'Inference server (Python)',
        runner: 'pytest',
        files: fs.readdirSync(dir).filter(f => /^test_.*\.py$/.test(f)).length,
        tests: pass === null ? null : pass + fail + skipped,
        pass, fail, skipped,
        seconds: result.seconds,
    };
}

function ios() {
    const result = run('swift', ['test'], IOS);
    // Last "Executed N tests, with F failures" is the whole-suite line.
    const lines = [...result.output.matchAll(
        /Executed (\d+) tests?, with (\d+) failures?/g)];
    const last = lines.length ? lines[lines.length - 1] : null;
    return {
        component: 'iOS companion (Swift, JarvisKit)',
        runner: 'swift test',
        files: fs.readdirSync(path.join(IOS, 'Tests', 'JarvisKitTests'))
            .filter(f => f.endsWith('.swift')).length,
        tests: last ? Number(last[1]) : null,
        pass: last ? Number(last[1]) - Number(last[2]) : null,
        fail: last ? Number(last[2]) : null,
        skipped: 0,
        seconds: result.seconds,
    };
}

function android() {
    const result = run('./gradlew', ['testDebugUnitTest', '--rerun-tasks',
        '--console=plain'], ANDROID, { JAVA_HOME: '/opt/homebrew/opt/openjdk@17' });
    // Gradle keeps its counts in the XML results, not on stdout.
    const resultsDir = path.join(ANDROID, 'app', 'build', 'test-results',
        'testDebugUnitTest');
    let tests = 0, fail = 0, skipped = 0, files = 0;
    if (fs.existsSync(resultsDir)) {
        for (const file of fs.readdirSync(resultsDir)) {
            if (!file.endsWith('.xml')) continue;
            files += 1;
            const xml = fs.readFileSync(path.join(resultsDir, file), 'utf8');
            const opening = /<testsuite\b[^>]*>/.exec(xml);
            if (opening) {
                const attr = (name) => {
                    const m = new RegExp(name + '="(\\d+)"').exec(opening[0]);
                    return m ? Number(m[1]) : 0;
                };
                tests += attr('tests');
                fail += attr('failures') + attr('errors');
                skipped += attr('skipped');
            }
        }
    }
    return {
        component: 'Android companion (Kotlin)',
        runner: 'gradle testDebugUnitTest',
        files,
        tests: tests || null,
        pass: tests ? tests - fail - skipped : null,
        fail: tests ? fail : (result.failed ? 1 : null),
        skipped,
        seconds: result.seconds,
    };
}

function main() {
    const rows = [];
    for (const suite of [backend, inference, ios, android]) {
        const row = suite();
        rows.push(row);
        console.log(`${row.component}: ${row.pass}/${row.tests} passed `
            + `(${row.seconds.toFixed(1)}s)`);
    }
    const total = (key) => rows.reduce((n, r) => n + (r[key] || 0), 0);
    const report = {
        generated: new Date().toISOString(),
        machine: 'M4 Pro, 24 GB',
        components: rows,
        totals: { tests: total('tests'), pass: total('pass'),
                  fail: total('fail'), skipped: total('skipped') },
    };
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'test-inventory.json'),
        JSON.stringify(report, null, 2));
    const md = [
        '# Unit and integration test inventory',
        '',
        `Generated ${report.generated} by \`backend/tools/test-report.js\`;`,
        'suites run strictly in sequence on an otherwise idle machine.',
        '',
        '| Component | Runner | Test files | Tests | Pass | Fail | Skipped | Time |',
        '|---|---|---|---|---|---|---|---|',
        ...rows.map(r => `| ${r.component} | \`${r.runner}\` | ${r.files} `
            + `| ${r.tests ?? '?'} | ${r.pass ?? '?'} | ${r.fail ?? '?'} `
            + `| ${r.skipped ?? 0} | ${r.seconds.toFixed(1)} s |`),
        `| **Total** | | | **${report.totals.tests}** `
            + `| **${report.totals.pass}** | **${report.totals.fail}** `
            + `| ${report.totals.skipped} | |`,
        '',
    ].join('\n');
    fs.writeFileSync(path.join(OUT_DIR, 'test-inventory.md'), md);
    console.log(`\nTotals: ${report.totals.pass}/${report.totals.tests} passed, `
        + `${report.totals.fail} failed.`);
    console.log('Written: docs/measurements/test-inventory.{json,md}');
}

main();
