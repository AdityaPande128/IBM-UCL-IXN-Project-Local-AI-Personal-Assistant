const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const morningBrief = require('../services/morningBrief');
const watchers = require('../services/watchers');
const proposals = require('../services/proposals');
const procedureStore = require('../services/procedureStore');
const securityStore = require('../security/store');

function scratch() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-brief-'));
    procedureStore.open(path.join(dir, 'procedures'));
    watchers.open(path.join(dir, 'watchers.db'));
    securityStore.open(path.join(dir, 'security.db'));
    morningBrief.useState(path.join(dir, 'brief-state.json'));
    proposals.reset();
    return {
        dir,
        cleanup() {
            watchers.close();
            watchers.setRunner(null);
            securityStore.close();
            morningBrief.useState(null);
            proposals.reset();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    };
}

async function noticeFromMail(addedRows) {
    procedureStore.save({
        name: 'checks-mail',
        surface: 'dom',
        start_url: 'http://127.0.0.1:9/mail',
        description: 'reads the inbox list',
        steps: [{ action: 'navigate', url: 'http://127.0.0.1:9/mail' }]
    });

    let page = 'Inbox';
    watchers.setRunner(async () => ({ status: 'success', passages: [{ text: page }] }));
    const watcher = watchers.add({ name: 'the inbox', target: 'checks-mail' });
    await watchers.runOne(watchers.get(watcher.id));
    page = `Inbox\n${addedRows.join('\n')}`;
    await watchers.runOne(watchers.get(watcher.id));
}


test('an empty morning says so and asks for nothing', () => {
    const scope = scratch();
    try {
        const brief = morningBrief.assemble();
        assert.strictEqual(brief.notices.length, 0);
        assert.strictEqual(brief.drafts.length, 0);
        assert.match(brief.text, /Nothing needs you/);
    } finally {
        scope.cleanup();
    }
});

test('a new mail row becomes a drafted reply behind its own consent card', async () => {
    const scope = scratch();
    try {
        await noticeFromMail(['Philip Hargreaves — Lunch on Thursday? — July 12']);

        const browsed = [];
        const browse = async goal => { browsed.push(goal); return { status: 'success', answer: 'drafted' }; };

        const brief = morningBrief.assemble({ browse });

        assert.strictEqual(brief.notices.length, 1);
        assert.strictEqual(brief.drafts.length, 1);
        assert.match(brief.drafts[0].summary, /Philip Hargreaves/);
        assert.match(brief.text, /reply is drafted and waiting/);
        assert.strictEqual(browsed.length, 0, 'nothing browses before consent');

        const outcome = await proposals.approve(brief.drafts[0].id);
        assert.strictEqual(outcome.status, 'success');
        assert.strictEqual(browsed.length, 1);
        assert.match(browsed[0], /^draft a reply to Philip Hargreaves/);
        assert.match(browsed[0], /do not send it/);
    } finally {
        scope.cleanup();
    }
});

test('the same mail row is never offered twice', async () => {
    const scope = scratch();
    try {
        await noticeFromMail(['Philip Hargreaves — Lunch on Thursday? — July 12']);
        const browse = async () => ({ status: 'success' });

        const first = morningBrief.assemble({ browse });
        assert.strictEqual(first.drafts.length, 1);
        await proposals.approve(first.drafts[0].id);

        const second = morningBrief.assemble({ browse });
        assert.strictEqual(second.drafts.length, 0, 'consent already asked once');
    } finally {
        scope.cleanup();
    }
});

test('sent rows and prose lines never invite a draft', () => {
    const scope = scratch();
    try {
        const found = morningBrief.draftable({
            body: [
                'To: Nadia Okonjo — Re: Barbican on the 15th — July 29',
                'The cafe closes one hour earlier than the shop.',
                'Nadia Okonjo — Barbican on the 15th — July 28'
            ].join('\n')
        });

        assert.strictEqual(found.length, 1);
        assert.strictEqual(found[0].who, 'Nadia Okonjo');
        assert.strictEqual(found[0].subject, 'Barbican on the 15th');
    } finally {
        scope.cleanup();
    }
});

test('the brief is due from its hour, once a day', () => {
    const scope = scratch();
    try {
        const day = new Date('2026-08-10T00:00:00');
        const early = day.setHours(morningBrief.HOUR - 1);
        const late = day.setHours(morningBrief.HOUR + 1);

        assert.strictEqual(morningBrief.dueNow(early), false, 'not before the hour');
        assert.strictEqual(morningBrief.dueNow(late), true, 'due after the hour');

        morningBrief.markGiven(late);
        assert.strictEqual(morningBrief.dueNow(late), false, 'given is given');

        const tomorrow = late + 24 * 60 * 60 * 1000;
        assert.strictEqual(morningBrief.dueNow(tomorrow), true, 'a new day owes a new brief');
    } finally {
        scope.cleanup();
    }
});
