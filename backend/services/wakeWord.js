const configReader = require('../utils/configReader');

const config = configReader.readConfig();
const SETTINGS = config.wake || {};

// The privacy contract: always-on listening is OFF until the user turns it
// on, and while it is on, speech that does not start with the wake phrase is
// discarded here — not persisted, not logged, not even reported back. The
// probe's answer for idle speech is {wake: false} and nothing else.
const PHRASE = String(SETTINGS.phrase || 'jarvis').toLowerCase();

let transcriber = null;

function setTranscriber(fn) {
    transcriber = fn;
}

function wakePattern() {
    const phrase = PHRASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^[\\s"'.,!?-]*(?:hey|ok|okay)?[\\s,]*${phrase}\\b[\\s,!.?-]*`, 'i');
}

async function probe(audioBuffer) {
    const transcribe = transcriber || require('./aiPipeline').transcribeAudio;

    let heard;
    try {
        heard = await transcribe(audioBuffer);
    } catch {
        return { wake: false };
    }

    const words = String(heard || '').trim();
    if (!words) return { wake: false };

    const match = words.match(wakePattern());
    if (!match) return { wake: false };

    const command = words.slice(match[0].length).trim();
    return { wake: true, command: command || null };
}

module.exports = { probe, setTranscriber, wakePattern, PHRASE };
