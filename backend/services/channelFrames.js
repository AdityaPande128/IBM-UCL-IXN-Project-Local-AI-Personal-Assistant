// The data channel carries three kinds of binary traffic, all chunked the
// same way because libwebrtc dislikes messages past a quarter megabyte:
//   0x01  a websocket binary frame in transit (voice in, speech out)
//   0x02  a file-lane request from the phone
//   0x03  a file-lane response back to it
// Frame: [tag][4B BE header length][header JSON][payload chunk]. The channel
// is ordered and reliable, so sequence numbers only assert what SCTP already
// promised — a gap means a bug, and the stream dies loudly.

const CHUNK_BYTES = 64 * 1024;
const TAG = { WS_BINARY: 0x01, FILE_REQ: 0x02, FILE_RES: 0x03 };
const MAX_STREAM_BYTES = { [TAG.WS_BINARY]: 8 * 1024 * 1024,
    [TAG.FILE_REQ]: 24 * 1024 * 1024, [TAG.FILE_RES]: 24 * 1024 * 1024 };

function encode(tag, header, payload) {
    const head = Buffer.from(JSON.stringify(header), 'utf8');
    const frame = Buffer.alloc(5 + head.length + (payload ? payload.length : 0));
    frame.writeUInt8(tag, 0);
    frame.writeUInt32BE(head.length, 1);
    head.copy(frame, 5);
    if (payload) payload.copy(frame, 5 + head.length);
    return frame;
}

function decode(frame) {
    if (!Buffer.isBuffer(frame) || frame.length < 5) return null;
    const tag = frame.readUInt8(0);
    if (tag < 0x01 || tag > 0x03) return null;
    const headLength = frame.readUInt32BE(1);
    if (5 + headLength > frame.length || headLength > 64 * 1024) return null;
    let header;
    try { header = JSON.parse(frame.subarray(5, 5 + headLength).toString('utf8')); }
    catch { return null; }
    return { tag, header, payload: frame.subarray(5 + headLength) };
}

// Split one logical message into frames for the wire.
function* chunk(tag, meta, body) {
    const payload = body || Buffer.alloc(0);
    const total = Math.max(1, Math.ceil(payload.length / CHUNK_BYTES));
    for (let seq = 0; seq < total; seq++) {
        const slice = payload.subarray(seq * CHUNK_BYTES, (seq + 1) * CHUNK_BYTES);
        const header = { ...(seq === 0 ? meta : {}), sid: meta.sid, seq, last: seq === total - 1 };
        yield encode(tag, header, slice);
    }
}

// Reassembles interleaved streams; returns a completed message or null.
// A malformed or oversized stream is dropped whole — never delivered short.
function assembler() {
    const streams = new Map();
    return function accept(frame) {
        const parsed = decode(frame);
        if (!parsed) return null;
        const { tag, header, payload } = parsed;
        const key = tag + ':' + header.sid;
        let stream = streams.get(key);
        if (header.seq === 0) {
            stream = { meta: header, parts: [], bytes: 0, next: 0 };
            streams.set(key, stream);
        }
        if (!stream || header.seq !== stream.next) { streams.delete(key); return null; }
        stream.next += 1;
        stream.bytes += payload.length;
        if (stream.bytes > (MAX_STREAM_BYTES[tag] || 0)) { streams.delete(key); return null; }
        stream.parts.push(Buffer.from(payload));
        if (!header.last) return null;
        streams.delete(key);
        return { tag, meta: stream.meta, body: Buffer.concat(stream.parts) };
    };
}

module.exports = { TAG, CHUNK_BYTES, encode, decode, chunk, assembler };
