// "What did you do while I was away" — one answer, assembled from the stores
// that were already keeping the truth: the plan traces, the security audit
// trail, the approvals, the watcher notices and the build ledger. Nothing
// here is recorded specially for display; the digest is only a window onto
// records the system writes anyway, which is what makes it trustworthy.

const traceStore = require('./traceStore');
const securityStore = require('../security/store');
const watchers = require('./watchers');
const generationLog = require('./generationLog');

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ROWS = 200;

function planLine(plan) {
    return {
        at: plan.ts,
        request: plan.request,
        goal: plan.goal || null,
        status: plan.status,
        steps: plan.step_count,
        surface: plan.surface || null,
        error: plan.error || null
    };
}

function decisionLine(row) {
    return {
        at: row.ts,
        channel: row.channel,
        action: row.action,
        decision: row.decision,
        summary: row.summary || null,
        destination: row.destination || null
    };
}

function approvalLine(row) {
    return {
        at: row.ts,
        action: row.action,
        summary: row.summary || row.action,
        status: row.status,
        resolvedAt: row.resolved_ts || null
    };
}

function buildLine(entry) {
    return {
        at: entry.timestamp,
        request: entry.request,
        outcome: entry.outcome,
        skill: entry.skill || null,
        failure: entry.failure || null
    };
}

function noticeLine(row) {
    return {
        at: new Date(row.at).toISOString(),
        title: row.title,
        body: row.body,
        seen: Boolean(row.seen)
    };
}

// The largest instant a JS Date can hold; past it, toISOString throws.
const MAX_DATE_MS = 8.64e15;

function digest(since) {
    // A since from the client is untrusted. A corrupted "last seen" could be
    // negative, NaN, or past the largest representable date — those fall back
    // to the default window. A valid future timestamp is kept as-is: nothing
    // is newer than it, so the window is simply empty.
    const parsed = Number(since);
    const sinceMs = Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_DATE_MS
        ? parsed
        : Date.now() - DEFAULT_WINDOW_MS;
    const sinceIso = new Date(sinceMs).toISOString();

    const plans = traceStore.plansSince(sinceIso, MAX_ROWS).map(planLine);
    const decisions = securityStore.decisionsSince(sinceIso, MAX_ROWS).map(decisionLine);
    const approvals = securityStore.approvalsSince(sinceIso, MAX_ROWS).map(approvalLine);
    const builds = generationLog.read()
        .filter(entry => entry.timestamp && entry.timestamp >= sinceIso)
        .slice(-MAX_ROWS)
        .reverse()
        .map(buildLine);
    const notices = watchers.notices({ unseenOnly: false, limit: MAX_ROWS })
        .filter(row => row.at >= sinceMs)
        .map(noticeLine);

    const acted = plans.filter(p => p.status === 'success').length;
    const failed = plans.filter(p => p.status !== 'success').length;
    const denied = decisions.filter(d => d.decision !== 'allow').length;

    return {
        since: sinceIso,
        generatedAt: new Date().toISOString(),
        summary: {
            plans: plans.length,
            succeeded: acted,
            failed,
            decisions: decisions.length,
            denied,
            approvals: approvals.length,
            builds: builds.length,
            notices: notices.length
        },
        plans,
        decisions,
        approvals,
        builds,
        notices
    };
}

module.exports = { digest, DEFAULT_WINDOW_MS };
