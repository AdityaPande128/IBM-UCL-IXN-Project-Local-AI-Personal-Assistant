#!/usr/bin/env node

const securityStore = require('../security/store');

const argv = process.argv.slice(2);

function list() {
    const sites = securityStore.grantedSites();
    if (!sites.length) {
        console.log('\n  No sites granted. The assistant browses the open web logged into nothing.\n');
        return;
    }
    console.log(`\n  ${sites.length} site(s) the assistant may act on as you:\n`);
    for (const site of sites) {
        console.log(`    ${site.host.padEnd(32)} ${site.label || ''}`);
        console.log(`      granted ${site.granted_ts}`);
    }
    console.log('');
}

if (argv.includes('--list') || !argv.length) {
    list();
    process.exit(0);
}

if (argv[0] === '--revoke') {
    const host = argv[1];
    if (!host) {
        console.error('  usage: node tools/grant-site.js --revoke <host>');
        process.exit(1);
    }
    const revoked = securityStore.revokeSite(host);
    securityStore.recordDecision({
        channel: 'consent', action: 'web.revoke-site',
        decision: revoked ? 'allow' : 'deny',
        summary: `revoked ${host}`, detail: { host }
    });
    console.log(revoked
        ? `\n  Revoked ${host}. The assistant can no longer act as you there.\n`
        : `\n  ${host} was not granted.\n`);
    process.exit(0);
}

const [host, ...rest] = argv;
const label = rest.join(' ') || null;

let granted;
try {
    granted = securityStore.grantSite(host, { label });
} catch (err) {
    console.error(`\n  ${err.message}\n`);
    process.exit(1);
}

securityStore.recordDecision({
    channel: 'consent', action: 'web.grant-site', decision: 'allow',
    summary: `granted ${granted}${label ? ` (${label})` : ''}`,
    detail: { host: granted, label }
});

console.log(`\n  Granted ${granted}${label ? ` — "${label}"` : ''}.`);
console.log('  The assistant may now use your signed-in browser on this host and its subdomains.');
console.log('  Start that browser with: node tools/link-browser.js');
console.log(`  Undo with: node tools/grant-site.js --revoke ${granted}\n`);
