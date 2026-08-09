#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const securityStore = require('../security/store');
const linkedBrowser = require('../services/linkedBrowser');

const PROFILE_DIR = linkedBrowser.PROFILE_DIR;

const argv = process.argv.slice(2);
const flag = name => argv.includes(name);

function staleInstances() {
    let listing = '';
    try {
        listing = execFileSync('ps', ['-Ao', 'command'], { encoding: 'utf8', maxBuffer: 4 << 20 });
    } catch {
        return [];
    }

    const stale = new Set();
    for (const line of listing.split('\n')) {
        const found = line.match(/(.*\.framework)\/Versions\/([0-9][^/]*)\//);
        if (!found) continue;
        const [, framework, version] = found;
        if (!fs.existsSync(path.join(framework, 'Versions', version))) {
            stale.add(`${path.basename(framework)} ${version}`);
        }
    }
    return [...stale];
}

if (flag('--forget')) {
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
    securityStore.recordDecision({
        channel: 'consent', action: 'web.unlink-browser', decision: 'allow',
        summary: "deleted the assistant's browser profile and every session in it"
    });
    console.log("\n  Deleted the assistant's browser profile. Its logins are gone with it;");
    console.log('  yours were never in there.\n');
    process.exit(0);
}

const source = linkedBrowser.chosen();
if (!source) {
    console.error('\n  Found no supported browser to run.\n');
    process.exit(1);
}

const stale = staleInstances();
if (stale.length) {
    console.error(`\n  ${source.name} has updated underneath a copy of itself that is still running:`);
    for (const entry of stale) console.error(`    ${entry} is running, and is no longer on disk`);
    console.error('\n  In that state new tabs cannot open, and starting another instance can make');
    console.error('  it worse. Quit that browser with Cmd-Q, reopen it, and run this again.\n');
    process.exit(1);
}

const firstRun = !fs.existsSync(PROFILE_DIR);

if (linkedBrowser.inUse()) {
    console.log(`\n  ${source.name} is already open on the assistant's profile (pid `
        + `${linkedBrowser.heldBy()}).`);
    console.log(`  Profile: ${PROFILE_DIR}\n`);
    console.log('  Sign in there if that is what you came to do. Quit that window when you are');
    console.log('  finished, so a browse can run the profile itself.\n');
    process.exit(0);
}

const granted = securityStore.grantedSites();
securityStore.recordDecision({
    channel: 'consent', action: 'web.link-browser', decision: 'allow',
    summary: `opened ${source.name} on the assistant's own profile for signing in`,
    detail: { source: source.name, granted: granted.map(site => site.host) }
});

linkedBrowser.bind(source.name);

const child = spawn(source.binary, [
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    'https://mail.google.com/'
], { detached: true, stdio: 'ignore' });

child.unref();

setTimeout(() => {
    if (!linkedBrowser.inUse()) {
        console.error(`\n  ${source.name} did not stay open on the assistant's profile.\n`);
        process.exit(1);
    }

    console.log(`\n  ${source.name} is open on the assistant's own profile.`);
    console.log(`  Profile: ${PROFILE_DIR}  (its own — yours is not touched)`);

    if (firstRun) {
        console.log('\n  This profile is signed into nothing yet. A window is open: sign in there,');
        console.log('  yourself, to whichever sites you want the assistant to be able to use.');
        console.log('  It stays signed in after that, and signing in here does not sign you out');
        console.log('  anywhere else — it is a second session, not a copy of yours.');
    }

    if (granted.length) {
        console.log(`\n  It may act as you on ${granted.length} site(s):`);
        for (const site of granted) console.log(`    ${site.host}${site.label ? ` — ${site.label}` : ''}`);
    } else {
        console.log('\n  No sites are granted yet, so nothing is reachable in it.');
        console.log('  Grant one with: node tools/grant-site.js <host>');
    }

    console.log('\n  Quit this window when you have finished signing in — a browse runs the');
    console.log('  profile itself, and only one browser can hold it at a time.');
    console.log('\n  Delete the profile and its logins with: node tools/link-browser.js --forget\n');
}, 4000);
