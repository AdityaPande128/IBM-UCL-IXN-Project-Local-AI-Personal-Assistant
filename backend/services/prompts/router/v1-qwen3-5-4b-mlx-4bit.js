
const v2 = require('./v2');

const AMEND_REFUSE = `
Two boundaries models often misread:
- R1 means wholesale, unrecoverable loss only. Clearing a clipboard, compressing or converting files, closing applications, moving or renaming things are ordinary operations, never R1.
- R7 means devices beyond this Mac. The Mac's own wifi radio, volume, screen, playback and power are fully reachable and never R7.`;

const AMEND_TRIAGE = `
Anything in the user's mailbox, calendar or orders is "act", however small: reading a message, searching the inbox, drafting or sending a reply all reach the mailbox through skills, never from memory. "tell" is for what needs no skill at all: settled knowledge, translation, arithmetic, conversation, and questions about the user's own indexed notes.`;

function triage() { return v2.triage() + AMEND_REFUSE + AMEND_TRIAGE; }
function selection(skills) { return v2.selection(skills); }
function single(skills) { return v2.single(skills) + AMEND_REFUSE + AMEND_TRIAGE; }

module.exports = { name: 'v1', triage, selection, single };
