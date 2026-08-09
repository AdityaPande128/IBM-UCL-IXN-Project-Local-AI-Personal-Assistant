#!/usr/bin/env node

const os = require('os');
const path = require('path');

const fileIndex = require('../services/fileIndex');

function human(bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = Number(bytes) || 0;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

function status() {
    const s = fileIndex.stats();
    console.log('\n  file index\n  ' + '-'.repeat(56));
    console.log(`  ${String(s.files).padStart(8)} file(s) known, ${human(s.bytes)} total`);
    console.log(`  ${String(s.content_indexed).padStart(8)} also content-indexed (Tier B)`);

    if (s.lastCrawl) {
        const when = new Date(s.lastCrawl.ts).toLocaleString();
        console.log(`  last crawl: ${when}, ${(s.lastCrawl.ms / 1000).toFixed(1)}s, ` +
            `${s.lastCrawl.skipped} skipped, ${s.lastCrawl.removed} removed`);
    } else {
        console.log('  never crawled — run: node tools/index-files.js crawl');
    }

    if (s.byExtension.length) {
        console.log('\n  most common types');
        for (const row of s.byExtension) {
            console.log(`    ${(row.ext || '(none)').padEnd(10)} ${String(row.n).padStart(7)}`);
        }
    }
    console.log();
}

function parseFlags(argv) {
    const flags = {};
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg.startsWith('--')) {
            const key = arg.slice(2);
            const next = argv[i + 1];
            if (next && !next.startsWith('--')) { flags[key] = next; i++; }
            else flags[key] = true;
        } else {
            rest.push(arg);
        }
    }
    return { flags, rest };
}

function main() {
    const argv = process.argv.slice(2);

    if (argv.length === 0 || argv.includes('--status')) {
        status();
        if (argv.length === 0) {
            console.log('  usage: node tools/index-files.js <crawl|search> [...]\n');
        }
        return;
    }

    const command = argv[0];
    const { flags, rest } = parseFlags(argv.slice(1));

    if (command === 'crawl') {
        const roots = rest.length ? rest : [os.homedir()];
        console.log(`\n  crawling (metadata only, nothing is read):`);
        for (const root of roots) console.log(`    ${root}`);
        console.log();

        const result = fileIndex.crawl({
            roots,
            onProgress: n => process.stdout.write(`\r    ${n} files...`)
        });

        process.stdout.write('\r' + ' '.repeat(40) + '\r');
        console.log(`  done — ${result.files} file(s) in ${(result.ms / 1000).toFixed(1)}s ` +
            `(${Math.round(result.files / (result.ms / 1000))}/s)`);
        console.log(`  ${result.skipped} skipped, ${result.removed} removed, ` +
            `${result.denied} unreadable director${result.denied === 1 ? 'y' : 'ies'}`);
        status();
        return;
    }

    if (command === 'search') {
        const since = flags.since ? Date.parse(flags.since) : undefined;
        if (flags.since && Number.isNaN(since)) {
            console.error(`  could not read --since "${flags.since}" as a date`);
            process.exit(1);
        }

        const results = fileIndex.search({
            text: rest.join(' ') || undefined,
            ext: flags.ext,
            dir: flags.dir,
            modifiedAfter: since,
            limit: Number(flags.limit) || 20
        });

        if (!results.length) {
            console.log('\n  nothing matched. If the index is empty, run: ' +
                'node tools/index-files.js crawl\n');
            return;
        }

        console.log();
        for (const file of results) {
            const when = new Date(file.mtime).toISOString().slice(0, 10);
            const mark = file.content_indexed ? '*' : ' ';
            console.log(`  ${mark} ${when}  ${human(file.size).padStart(8)}  ${file.path}`);
        }
        console.log(`\n  ${results.length} result(s); * = content is also indexed\n`);
        return;
    }

    console.error(`  unknown command "${command}" (expected crawl or search)`);
    process.exit(1);
}

main();
