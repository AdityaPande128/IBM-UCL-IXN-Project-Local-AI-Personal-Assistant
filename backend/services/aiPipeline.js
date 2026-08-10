const http = require('http');
const openclawBridge = require('./openclawBridge');
const intentQueue = require('./intentQueue');
const activityBus = require('./activityBus');
const configReader = require('../utils/configReader');

const config = configReader.readConfig();
const INFERENCE_URL = process.env.INFERENCE_URL || `http://127.0.0.1:${config.ports.inference}`;
const TIMEOUT_MS = (config.voice || {}).timeout_ms ?? 120000;

const MAX_TTS_CHUNKS = 8;

const MAX_SPOKEN_CHARS = 350;

function speakableSummary(text) {
    const full = String(text || '').trim();
    if (full.length <= MAX_SPOKEN_CHARS) return full;

    const lines = full.split('\n').map(l => l.trim()).filter(Boolean);
    const head = lines[0] || '';
    const remaining = lines.length - 1;

    if (remaining > 0 && head.length <= MAX_SPOKEN_CHARS) {
        return `${head} ${remaining} ${remaining === 1 ? 'entry' : 'entries'}. The details are on screen.`;
    }
    return `${full.slice(0, MAX_SPOKEN_CHARS).trim()}… The rest is on screen.`;
}

function chunkTextDynamically(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return [];

    const sentences = trimmed.match(/[^.!?\n]+[.!?\n]*/g) || [trimmed];

    const chunks = [];
    for (const sentence of sentences) {
        const piece = sentence.trim();
        if (!piece) continue;

        if (piece.length <= 240) {
            chunks.push(piece);
            continue;
        }
        let buffer = '';
        for (const part of piece.split(/,\s*/)) {
            if ((buffer + part).length > 240 && buffer) { chunks.push(buffer.trim()); buffer = ''; }
            buffer += (buffer ? ', ' : '') + part;
        }
        if (buffer.trim()) chunks.push(buffer.trim());
    }

    if (chunks.length > MAX_TTS_CHUNKS) {
        const kept = chunks.slice(0, MAX_TTS_CHUNKS);
        kept.push('The rest is on screen.');
        return kept;
    }
    return chunks;
}

function httpPost(urlPath, body, contentType) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlPath, INFERENCE_URL);
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            headers: { 'Content-Type': contentType }
        };

        const req = http.request({ ...options, timeout: TIMEOUT_MS }, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                if (res.headers['content-type'] && res.headers['content-type'].includes('audio')) {
                    resolve({ type: 'audio', data: buffer });
                } else {
                    try {
                        resolve({ type: 'json', data: JSON.parse(buffer.toString()) });
                    } catch (e) {
                        resolve({ type: 'text', data: buffer.toString() });
                    }
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error(`request to ${urlPath} timed out`)); });
        req.write(body);
        req.end();
    });
}

async function transcribeAudio(audioBuffer) {
    console.log(`[STT: mlx-whisper] Sending ${audioBuffer.length} bytes to inference server...`);

    const boundary = '----JarvisBoundary' + Date.now();
    const fieldName = 'audio';
    const fileName = 'audio.wav';

    const header = Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\n` +
        `Content-Type: audio/wav\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const multipartBody = Buffer.concat([header, audioBuffer, footer]);

    try {
        const result = await httpPost('/stt', multipartBody, `multipart/form-data; boundary=${boundary}`);
        if (result.type === 'json' && result.data.text) {
            console.log(`[STT: mlx-whisper] Transcribed: "${result.data.text}"`);
            return result.data.text;
        }
        console.log(`[STT: mlx-whisper] No transcription returned, falling back to stub.`);
        return null;
    } catch (err) {
        console.warn(`[STT: mlx-whisper] Inference server unavailable: ${err.message}. Using stub.`);
        return null;
    }
}

async function synthesizeChunk(textChunk, chunkIndex) {
    console.log(`[TTS: Kokoro-82M] Synthesizing chunk ${chunkIndex}: "${textChunk}"`);

    const formBody = `text=${encodeURIComponent(textChunk)}&voice=af_heart`;

    try {
        const result = await httpPost('/tts', formBody, 'application/x-www-form-urlencoded');
        if (result.type === 'audio') {
            console.log(`[TTS: Kokoro-82M] Chunk ${chunkIndex} synthesized (${result.data.length} bytes).`);
            return result.data;
        }
        const detail = result.data && result.data.error ? result.data.error : 'no audio returned';
        console.warn(`[TTS: Kokoro-82M] Chunk ${chunkIndex} failed: ${detail}`);
        return null;
    } catch (err) {
        console.warn(`[TTS: Kokoro-82M] Chunk ${chunkIndex} failed: ${err.message}`);
        return null;
    }
}

function isOpen(ws) {
    return ws && (ws.readyState === undefined || ws.readyState === 1);
}

function send(ws, payload) {
    if (!isOpen(ws)) return false;
    try { ws.send(JSON.stringify(payload)); return true; }
    catch (err) { console.warn(`[Pipeline] Send failed: ${err.message}`); return false; }
}

async function handleIncomingAudio(audioBuffer, ws) {
    console.log(`[Pipeline] Audio buffer received (${audioBuffer.length} bytes). Starting cascaded pipeline.`);

    try {
        let transcribedText = await transcribeAudio(audioBuffer);

        if (!transcribedText || transcribedText.trim() === "") {
            console.warn(`[Pipeline] STT empty transcription. Returning error.`);
            send(ws, { type: 'pipeline_error',
                       error: 'Speech recognition detected no text or failed.' });
            return;
        }

        send(ws, { type: 'stt_result', text: transcribedText });
        await respondTo(transcribedText, ws);
    } catch (err) {
        console.error(`[Pipeline] Error: ${err.message}`);
        send(ws, { type: 'pipeline_error', error: err.message });
    }
}

// Everything after transcription: run the intent, then speak the reply.
// The wake-word path enters here with words the wake service already vetted.
async function respondTo(transcribedText, ws) {
    try {
        console.log(`[Pipeline] Executing intent...`);
        const unsubscribe = activityBus.subscribe(event => send(ws, { type: 'activity', ...event }));
        let llmResult;
        try {
            const job = intentQueue.submit(({ signal }) =>
                openclawBridge.executeIntent(transcribedText, { interactive: true, signal }));
            send(ws, { type: 'intent_accepted', id: job.id, position: job.position });
            llmResult = await job.result;

            const responseText = llmResult.response
                || llmResult.error
                || "Sorry, the intent execution failed.";
            llmResult = { ...llmResult, response: responseText };

            console.log(`[Pipeline] Response (${llmResult.status}): "${responseText.substring(0, 100)}..."`);
            send(ws, { type: 'intent_result', id: job.id, ...llmResult });
        } finally {
            unsubscribe();
        }
        const responseText = llmResult.response;

        const spokenText = speakableSummary(responseText);
        if (spokenText !== responseText) {
            console.log(`[Pipeline] Reply condensed for speech: ${responseText.length} -> ${spokenText.length} chars.`);
        }

        const textChunks = chunkTextDynamically(spokenText);
        console.log(`[Pipeline] Response chunked into ${textChunks.length} clauses for TTS.`);

        let spoken = 0;
        for (let i = 0; i < textChunks.length; i++) {
            if (!isOpen(ws)) {
                console.log('[Pipeline] Client disconnected; abandoning synthesis.');
                return;
            }
            const audioChunk = await synthesizeChunk(textChunks[i], i);
            if (audioChunk) { ws.send(audioChunk); spoken++; }
        }

        if (spoken === 0 && textChunks.length > 0) {
            send(ws, { type: 'speech_unavailable',
                       message: 'The reply could not be spoken; text only.' });
        }

        console.log(`[Pipeline] Complete: ${spoken}/${textChunks.length} chunk(s) spoken.`);
        send(ws, { type: 'pipeline_complete' });

    } catch (err) {
        console.error(`[Pipeline] Error: ${err.message}`);
        send(ws, { type: 'pipeline_error', error: err.message });
    }
}

module.exports = {
    handleIncomingAudio,
    respondTo,
    chunkTextDynamically,
    speakableSummary,
    transcribeAudio,
    synthesizeChunk,
    MAX_TTS_CHUNKS,
    MAX_SPOKEN_CHARS
};
