
const v2 = require('./v2');

const AMEND_TRIAGE = `
A short command is not a fragment. If a few words name something on this Mac to start, stop or adjust, that is "act", however casual the phrasing. A true fragment ("that", "yes", "hm") names nothing to act on. A question about the user's own indexed notes is "tell".`;

const AMEND_SELECT = `
6. A skill covers only what its description literally says. One fixed to a particular column, field or folder does not cover a different column, and one that does a single step does not cover a request chaining that step with another: both are "generate_new_skill".`;

function triage() { return v2.triage() + AMEND_TRIAGE; }
function selection(skills) { return v2.selection(skills) + AMEND_SELECT; }
function single(skills) { return v2.single(skills) + AMEND_TRIAGE + AMEND_SELECT; }

module.exports = { name: 'v1', triage, selection, single };
