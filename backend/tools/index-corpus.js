#!/usr/bin/env node

const corpusIndexer = require('../services/corpusIndexer');
const vectorIndex = require('../services/vectorIndex');
const securityStore = require('../security/store');

const COLLECTIONS = ['documents', 'mail'];

function status() {
    console.log('\n  personal index\n  ' + '-'.repeat(52));
    for (const name of COLLECTIONS) {
        const collection = vectorIndex.collection(name).ensureLoaded();
        const files = new Set(collection.meta.map(m => m.path)).size;
        const megabytes = (collection.size * vectorIndex.DIM * 4 / (1024 * 1024)).toFixed(1);
        console.log(
            `  ${name.padEnd(12)} ${String(collection.size).padStart(6)} chunk(s)` +
            `  ${String(files).padStart(5)} file(s)  ${megabytes} MB`
        );
    }

    console.log('\n  directories you have granted for content indexing');
    const granted = securityStore.grantedRoots();
    if (!granted.length) {
        console.log('    (none — naming a directory below grants it)');
    } else {
        for (const row of granted) {
            console.log(`    ${row.collection.padEnd(10)} ${row.path}`);
        }
        console.log('\n    revoke with: node tools/index-corpus.js --revoke <collection> <path>');
    }
    console.log('  ' + '-'.repeat(52) + '\n');
}

(async () => {
    const argv = process.argv.slice(2);

    if (argv.includes('--status') || argv.length === 0) {
        status();
        if (argv.length === 0) {
            console.log('  usage: node tools/index-corpus.js <documents|mail> [paths...]\n');
        }
        return;
    }

    if (argv[0] === '--revoke') {
        const [, name, target] = argv;
        if (!COLLECTIONS.includes(name) || !target) {
            console.error('  usage: node tools/index-corpus.js --revoke <documents|mail> <path>');
            process.exit(1);
        }
        const revoked = securityStore.revokeRoot(corpusIndexer.expandHome(target), name);
        console.log(revoked
            ? `  revoked "${target}" for ${name}. Already-indexed content remains — ` +
              `clear it with --clear ${name}.`
            : `  "${target}" was not granted for ${name}.`);
        return;
    }

    if (argv[0] === '--clear') {
        const name = argv[1];
        if (!COLLECTIONS.includes(name)) {
            console.error(`  unknown collection "${name}" (expected ${COLLECTIONS.join(' or ')})`);
            process.exit(1);
        }
        vectorIndex.collection(name).delete();
        console.log(`  cleared "${name}"`);
        return;
    }

    const kind = argv[0];
    if (!COLLECTIONS.includes(kind)) {
        console.error(`  unknown collection "${kind}" (expected ${COLLECTIONS.join(' or ')})`);
        process.exit(1);
    }

    let roots = argv.slice(1);

    if (roots.length) {
        for (const root of roots) {
            const resolved = securityStore.grantRoot(corpusIndexer.expandHome(root), kind);
            console.log(`  granted for content indexing: ${resolved}`);
        }
    } else if (kind !== 'mail') {
        roots = securityStore.grantedRoots(kind).map(row => row.path);
        if (roots.length) {
            console.log(`  re-indexing ${roots.length} previously granted director(ies)`);
        }
    }

    if (kind === 'mail') {
        if (roots.length === 0) roots = corpusIndexer.mailRoots();
        if (roots.length === 0) {
            console.error(
                '\n  No readable Apple Mail store found at ~/Library/Mail.\n' +
                '  If Mail is set up, macOS is denying access: grant Full Disk Access to\n' +
                '  your terminal in System Settings > Privacy & Security, then retry.\n' +
                '  Alternatively pass a folder of .emlx files directly.\n'
            );
            process.exit(1);
        }
    }

    if (roots.length === 0) {
        console.error('  no paths given');
        process.exit(1);
    }

    console.log(`\n  indexing "${kind}" from:`);
    for (const root of roots) console.log(`    ${root}`);
    console.log();

    const startedAt = Date.now();
    const result = await corpusIndexer.build({
        name: kind,
        roots,
        kind,
        log: msg => console.log(`  ${msg}`)
    });

    console.log(
        `\n  done — ${result.indexed} chunk(s) from ${result.files} file(s), ` +
        `${result.reused} reused, ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`
    );
    status();
})();
