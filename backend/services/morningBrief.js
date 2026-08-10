const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const configReader = require('../utils/configReader');
const activityBus = require('./activityBus');
const watchers = require('./watchers');
const proposals = require('./proposals');
const securityStore = require('../security/store');

const config = configReader.readConfig();
const SETTINGS = config.brief || {};
const HOUR = SETTINGS.hour ?? 8;
const TICK_MS = SETTINGS.tick_ms ?? 5 * 60000;
const DRAFT_REPLIES = SETTINGS.draft_replies !== false;
const MAX_REMEMBERED = 200;

// An approval card nobody answered yesterday is not this morning's news — the
// work that asked for it has long since given up waiting.
const APPROVAL_FRESH_MS = SETTINGS.approval_fresh_ms ?? 24 * 60 * 60 * 1000;

const DEFAULT_STATE = path.join(__dirname, '..', 'data', 'brief-state.json');

let statePath = DEFAULT_STATE;
let ticker = null;

function useState(target) {
    statePath = target || DEFAULT_STATE;
}

function readState() {
    try {
        return JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch {
        return { last_brief_day: null, proposed: [] };
    }
}

function writeState(state) {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({
        ...state,
        proposed: (state.proposed || []).slice(-MAX_REMEMBERED)
    }));
}

function dayOf(now = Date.now()) {
    const date = new Date(now);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-`
        + `${String(date.getDate()).padStart(2, '0')}`;
}

// The brief is due once per day, from the configured hour onward. A machine
// asleep at eight gives the brief at wake — the predicate only asks what has
// not happened yet, never what the clock missed.
function dueNow(now = Date.now()) {
    if (new Date(now).getHours() < HOUR) return false;
    return readState().last_brief_day !== dayOf(now);
}

function markGiven(now = Date.now()) {
    writeState({ ...readState(), last_brief_day: dayOf(now) });
}

// A mail watcher's added lines look like "Sender — Subject — date". Each new
// one can carry a pre-drafted reply — drafted, never sent, and only ever
// behind its own consent card.
const MAIL_ROW = /^([^—]{2,60}?) — ([^—]{2,120}?)(?: — .*)?$/;

function draftable(notice) {
    return String(notice.body || '').split('\n')
        .map(line => line.trim())
        .map(line => {
            const row = line.match(MAIL_ROW);
            if (!row) return null;
            const [, who, subject] = row;
            if (/^to:/i.test(who.trim())) return null;
            return { who: who.trim(), subject: subject.trim(), line };
        })
        .filter(Boolean);
}

function proposeDrafts(notices, browse) {
    if (!DRAFT_REPLIES || typeof browse !== 'function') return [];

    const state = readState();
    const remembered = new Set(state.proposed || []);
    const offered = [];

    for (const notice of notices || []) {
        for (const { who, subject, line } of draftable(notice)) {
            const key = crypto.createHash('sha256').update(line).digest('hex').slice(0, 16);
            if (remembered.has(key)) continue;
            remembered.add(key);

            const goal = `draft a reply to ${who} about "${subject}" — do not send it`;
            offered.push(proposals.create('draft-reply', {
                summary: `Draft a reply to ${who} about "${subject}"?`,
                who, subject, goal
            }, async () => {
                const result = await browse(goal);
                return {
                    status: result.status === 'success' ? 'success' : result.status,
                    response: result.answer || result.reason
                        || `The draft to ${who} is written and waiting in your drafts.`
                };
            }));
        }
    }

    if (offered.length) writeState({ ...state, proposed: [...remembered] });
    return offered;
}

function spoken({ notices, approvals, drafts }) {
    const parts = [];

    if (notices.length) {
        parts.push(notices.length === 1
            ? `One thing changed: ${notices[0].title}.`
            : `${notices.length} things changed: `
                + `${notices.map(notice => notice.title).join('; ')}.`);
    }
    if (drafts.length) {
        parts.push(drafts.length === 1
            ? `A reply is drafted and waiting for your yes: ${drafts[0].summary}`
            : `${drafts.length} replies are drafted and waiting for your yes.`);
    }
    if (approvals.length) {
        parts.push(approvals.length === 1
            ? `One approval is waiting: ${approvals[0].summary || approvals[0].action}.`
            : `${approvals.length} approvals are waiting.`);
    }

    return parts.length
        ? `Good morning. ${parts.join(' ')}`
        : 'Good morning. Nothing needs you — no changes overnight, nothing waiting.';
}

function freshApprovals(now = Date.now()) {
    return securityStore.pendingApprovals().filter(row => {
        const at = Date.parse(row.ts);
        return Number.isFinite(at) && now - at <= APPROVAL_FRESH_MS;
    });
}

function assemble({ browse } = {}) {
    const notices = watchers.notices();
    const drafts = proposeDrafts(notices, browse);
    const queue = proposals.pending();
    const approvals = freshApprovals();

    const brief = {
        at: Date.now(),
        notices,
        approvals,
        proposals: queue,
        drafts: queue.filter(entry => entry.kind === 'draft-reply'),
        text: null
    };
    brief.text = spoken({ notices, approvals, drafts: brief.drafts });
    return brief;
}

function start({ browse } = {}) {
    if (ticker) return;
    ticker = setInterval(() => {
        try {
            if (!dueNow()) return;
            const brief = assemble({ browse });
            markGiven();
            activityBus.publish('brief', 'ready', {
                text: brief.text,
                notices: brief.notices.length,
                drafts: brief.drafts.length,
                approvals: brief.approvals.length
            });
        } catch (err) {
            console.warn(`[Brief] failed: ${err.message}`);
        }
    }, TICK_MS);
    if (ticker.unref) ticker.unref();
}

function stop() {
    if (ticker) {
        clearInterval(ticker);
        ticker = null;
    }
}

module.exports = {
    assemble, proposeDrafts, draftable, dueNow, markGiven, spoken,
    freshApprovals, start, stop, useState, HOUR
};
