
const v2 = require('./v2');

const AMEND_REFUSE = `
Two boundaries models often misread:
- R1 means wholesale, unrecoverable loss only. Clearing a clipboard, compressing or converting files, closing applications, moving or renaming things are ordinary operations, never R1.
- R7 means devices beyond this Mac. The Mac's own wifi radio, volume, screen, playback and power are fully reachable and never R7.`;

const AMEND_SELECT = `
6. A skill covers only what its description literally says. One fixed to a particular column, field or folder does not cover a different column, field or folder: that is "generate_new_skill".`;

const AMEND_TRIAGE = `
Reading or drafting anything in the user's mailbox, calendar or orders is "act": the assistant reaches them through skills, never from memory. The user's own notes are indexed and searchable, so a question about their content is "tell".`;

function triage() { return v2.triage() + AMEND_REFUSE + AMEND_TRIAGE; }
function selection(skills) { return v2.selection(skills) + AMEND_SELECT; }
function single(skills) { return v2.single(skills) + AMEND_REFUSE + AMEND_SELECT + AMEND_TRIAGE; }

module.exports = { name: 'v1', triage, selection, single };
