#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');

const corpusIndexer = require('../services/corpusIndexer');
const vectorIndex = require('../services/vectorIndex');
const embedClient = require('../services/embedClient');
const store = require('../security/store');

const REPO = path.join(__dirname, '..', '..');

const ANSWERABLE = [
    'How much memory does the 14 billion parameter coder model use?',
    'What happens when a model is evicted from memory?',
    'Which model is pinned and never evicted?',
    'Why was the smaller router model rejected?',
    'How long does it take to reload a model after eviction?',
    'What is the Metal working set size on this machine?',
    'How does the router decide whether to refuse a request?',
    'What is the difference between the pinned catalogue and the live one?'
];

const FOREIGN = [
    'What is the capital of Peru?',
    'How do I make sourdough bread rise properly?',
    'When does the last train to Manchester leave?',
    'Who won the football World Cup in 1998?',
    'What is the recommended dose of ibuprofen for an adult?',
    'How do I repot an orchid without damaging the roots?',
    'What are the opening hours of the British Museum?',
    'How much does a plumber charge to fix a leaking tap?'
];

// Queries the development mailbox genuinely answers — every one of them was a
// real request during development (they are in the trace store verbatim).
const MAIL_ANSWERABLE = [
    'what did Sandhya ask me about in her latest email?',
    'has Sandhya replied to my last email?',
    'has my order from Riverside Books shipped yet?',
    'what time and where do I have to go on August 15th?',
    'when are we meeting at Primrose Hill?',
    'what was the subject of my last email to Sandhya?',
    'what is happening with the Kesko Senukai meeting?',
    'what did Sandhya send over recently?'
];

const MAIL_BODY_CHARS = 2000;
const FIELD = 'character id 1';
const RECORD = 'character id 2';

function largestInbox(execFileSync) {
    const script = `
        set out to ""
        tell application "Mail"
            repeat with acc in accounts
                try
                    set out to out & (name of acc) & tab ¬
                        & (count of messages of mailbox "INBOX" of acc) & linefeed
                end try
            end repeat
        end tell
        return out`;
    const rows = execFileSync('osascript', ['-e', script], { timeout: 120000 })
        .toString().trim().split('\n')
        .map(line => line.split('\t'))
        .filter(parts => parts.length === 2)
        .map(([name, count]) => ({ name, count: Number(count) }))
        .sort((a, b) => b.count - a.count);
    if (!rows.length) throw new Error('the mail client lists no account with an INBOX');
    return rows[0].name;
}

function collectMail(execFileSync) {
    const account = largestInbox(execFileSync);
    console.log(`    account: ${account}`);
    const inbox = `mailbox "INBOX" of account "${account.replace(/"/g, '\\"')}"`;
    // Not `mailbox "Sent Mail" of account ...` — that raises -1728. The sent
    // mailbox is a property of the application, unified across accounts.
    const sent = 'sent mailbox';

    const passes = [
        { label: 'recent inbox', clause: `messages 1 thru 120 of (${inbox})` },
        { label: 'recent sent', clause: `messages 1 thru 30 of (${sent})` },
        { label: 'from sandhya', clause: `(messages of (${inbox}) whose sender contains "sandhya")` },
        { label: 'riverside', clause: `(messages of (${inbox}) whose subject contains "riverside")` },
        { label: 'senukai', clause: `(messages of (${inbox}) whose subject contains "senukai")` }
    ];

    const messages = new Map();
    for (const pass of passes) {
        const script = `
            set fieldSep to ${FIELD}
            set recordSep to ${RECORD}
            set out to ""
            tell application "Mail"
                with timeout of 280 seconds
                    set found to ${pass.clause}
                    set n to count of found
                    if n > 120 then set n to 120
                    repeat with i from 1 to n
                        set m to item i of found
                        try
                            set out to out & (subject of m) & fieldSep & (sender of m) ¬
                                & fieldSep & ((date received of m) as string) ¬
                                & fieldSep & (content of m) & recordSep
                        end try
                    end repeat
                end timeout
            end tell
            return out`;
        let raw;
        try {
            raw = execFileSync('osascript', ['-e', script],
                { timeout: 300000, maxBuffer: 64 * 1024 * 1024 }).toString();
        } catch (err) {
            console.warn(`    ${pass.label}: the mail client did not answer (${err.message.split('\n')[0]})`);
            continue;
        }
        let added = 0;
        for (const chunk of raw.split(String.fromCharCode(2))) {
            const [subject, sender, date, body] = chunk.split(String.fromCharCode(1));
            if (subject === undefined || body === undefined) continue;
            const key = `${subject}|${sender}|${date}`;
            if (messages.has(key)) continue;
            messages.set(key,
                `From: ${sender}\nSubject: ${subject}\nDate: ${date}\n\n`
                + body.slice(0, MAIL_BODY_CHARS).trim() + '\n');
            added += 1;
        }
        console.log(`    ${pass.label}: ${added} message(s)`);
    }
    return [...messages.values()];
}

function percentile(values, p) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1,
        Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
    return sorted[index];
}

function summarise(label, scores) {
    const fmt = v => (v === null ? '  n/a' : v.toFixed(3));
    console.log(
        `  ${label.padEnd(12)} n=${String(scores.length).padStart(3)}  ` +
        `min ${fmt(percentile(scores, 0))}  p25 ${fmt(percentile(scores, 25))}  ` +
        `median ${fmt(percentile(scores, 50))}  p75 ${fmt(percentile(scores, 75))}  ` +
        `max ${fmt(percentile(scores, 100))}`
    );
}

(async () => {
    const mailMode = process.argv.includes('--mail');
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-calib-'));
    store.open(path.join(scratch, 'security.db'));

    let built;
    let answerable;

    if (mailMode) {
        // The July run's own caveat: documentation prose is not personal mail.
        // This mode measures against the real mailbox — read-only, staged into
        // the scratch directory, deleted with it.
        const { execFileSync } = require('child_process');
        console.log('\n  collecting from the signed-in mail client (read-only)');
        const messages = collectMail(execFileSync);
        if (!messages.length) {
            console.error('  the mail client returned nothing — cannot calibrate\n');
            process.exit(1);
        }
        const mailDir = path.join(scratch, 'mailbox');
        fs.mkdirSync(mailDir);
        messages.forEach((text, index) => fs.writeFileSync(
            path.join(mailDir, `message-${String(index).padStart(4, '0')}.txt`), text));
        store.grantRoot(mailDir, 'calibration');

        console.log(`  ${messages.length} message(s) staged\n\n  indexing the calibration corpus`);
        built = await corpusIndexer.build({
            name: 'calibration',
            roots: [mailDir],
            dir: scratch,
            extensions: new Set(['.txt']),
            log: msg => console.log(`    ${msg}`)
        });
        answerable = MAIL_ANSWERABLE;
    } else {
        const roots = [path.join(REPO, 'docs'), path.join(REPO, 'backend', 'skills')];
        for (const root of roots) store.grantRoot(root, 'calibration');

        console.log('\n  indexing the calibration corpus');
        for (const root of roots) console.log(`    ${root}`);

        built = await corpusIndexer.build({
            name: 'calibration',
            roots,
            dir: scratch,
            extensions: new Set(['.md']),
            log: msg => console.log(`    ${msg}`)
        });
        answerable = ANSWERABLE;
    }
    console.log(`  ${built.indexed} chunk(s) from ${built.files} file(s)\n`);

    if (built.indexed === 0) {
        console.error('  nothing indexed — cannot calibrate\n');
        process.exit(1);
    }

    const collection = vectorIndex.collection('calibration', scratch).ensureLoaded();

    const top = { answerable: [], foreign: [] };
    const gaps = [];

    const verbose = process.argv.includes('--verbose');

    for (const [kind, questions] of [['answerable', answerable], ['foreign', FOREIGN]]) {
        if (verbose) console.log(`  ${kind}`);
        for (const question of questions) {
            const [vector] = await embedClient.embed([question]);
            const hits = collection.search(vector, { topK: 5, minScore: 0 });
            if (!hits.length) continue;

            if (verbose) {
                const meta = hits[0].meta || {};
                let subject = '';
                try {
                    subject = fs.readFileSync(meta.path, 'utf8')
                        .split('\n').find(line => line.startsWith('Subject: ')) || '';
                } catch { }
                console.log(`    ${hits[0].score.toFixed(3)}  ${question}`);
                console.log(`           -> ${subject || path.basename(meta.path || '(unknown)')}`);
            }

            top[kind].push(hits[0].score);
            if (kind === 'answerable' && hits.length > 1) {
                gaps.push(hits[0].score - hits[hits.length - 1].score);
            }
        }
    }

    console.log('  top-hit similarity');
    summarise('answerable', top.answerable);
    summarise('foreign', top.foreign);

    const worstAnswerable = percentile(top.answerable, 0);
    const bestForeign = percentile(top.foreign, 100);
    const separation = worstAnswerable - bestForeign;

    console.log(`\n  worst answerable ${worstAnswerable.toFixed(3)} vs ` +
        `best foreign ${bestForeign.toFixed(3)}  ->  separation ${separation.toFixed(3)}`);

    if (separation <= 0) {
        console.log('\n  NO SEPARATION. A foreign question scores at least as high as the');
        console.log('  weakest genuine one, so no floor can divide them. The floor should be');
        console.log('  set from the foreign distribution and the residual errors accepted,');
        console.log('  or the embedding model reconsidered.\n');
    } else {
        const suggested = bestForeign + separation / 2;
        console.log(`  suggested corpus_min_score: ${suggested.toFixed(2)} ` +
            `(midpoint of the gap)\n`);
    }

    const medianGap = percentile(gaps, 50);
    if (medianGap !== null) {
        console.log(`  spread within a genuine result set (top hit minus 5th): ` +
            `median ${medianGap.toFixed(3)}, p75 ${percentile(gaps, 75).toFixed(3)}`);
        console.log(`  suggested corpus_margin: ${Math.max(0.05, medianGap / 2).toFixed(2)} ` +
            `(half the median spread, so the tail is trimmed but the body survives)\n`);
    }

    store.close();
    fs.rmSync(scratch, { recursive: true, force: true });
})();
