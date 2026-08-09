// Remembering what stopped working is as useful as remembering what works. A
// learned recipe that has failed its last runs is not offered to the planner
// again — the slow browsing path takes over, and because successful slow runs
// are what the distiller learns from, a recipe earns its way back by being
// re-learned against the site as it is now. Nothing is deleted: the recipe and
// its history stay visible in the abilities view.

const traceStore = require('./traceStore');

const CONSECUTIVE_FAILURES_TO_BLOCK = 2;

function isBlocked(capabilityId) {
    if (!String(capabilityId).startsWith('procedure.')) return false;

    let recent;
    try {
        recent = traceStore.recentOutcomes(capabilityId, CONSECUTIVE_FAILURES_TO_BLOCK);
    } catch {
        return false;
    }
    return recent.length >= CONSECUTIVE_FAILURES_TO_BLOCK
        && recent.every(status => status === 'failed');
}

function offerable(procedures) {
    const kept = [];
    for (const capability of procedures) {
        if (isBlocked(capability.id)) {
            console.log(`[NegativeMemory] Not offering ${capability.id}: its last `
                + `${CONSECUTIVE_FAILURES_TO_BLOCK} runs failed. Browsing the slow way `
                + `until the recipe is re-learned.`);
        } else {
            kept.push(capability);
        }
    }
    return kept;
}

module.exports = { isBlocked, offerable, CONSECUTIVE_FAILURES_TO_BLOCK };
