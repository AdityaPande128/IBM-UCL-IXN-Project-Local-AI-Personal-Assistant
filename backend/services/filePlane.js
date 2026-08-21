const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const socketAuth = require('./socketAuth');
const conversationStore = require('./conversationStore');
const fileIndex = require('./fileIndex');

// The phone's file lane: uploads land in a staging inbox inside the hard
// sandbox root, downloads resolve minted artifact ids back to real files.
// Rides the same HTTP server the websocket lives on; same token, as a bearer.

const MAX_BYTES = 50 * 1024 * 1024;
const EXTENSIONS = new Set(['pdf', 'docx', 'doc', 'txt', 'md', 'csv',
    'png', 'jpg', 'jpeg', 'heic', 'webp', 'gif']);
const CONTENT_TYPES = {
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown',
    csv: 'text/csv', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    heic: 'image/heic', webp: 'image/webp', gif: 'image/gif',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc: 'application/msword'
};

let state = null;

function init({ token, inbox }) {
    state = { token, inbox };
}

function authorized(req) {
    if (!state) return false;
    const header = String(req.headers.authorization || '');
    const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    return socketAuth.verify(state.token, presented);
}

function sanitize(rawName) {
    let name = path.basename(String(rawName || 'upload'));
    try { name = decodeURIComponent(name); } catch { /* keep as sent */ }
    name = name.replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, ' ').trim();
    return name.slice(-80) || 'upload';
}

function refuse(res, code, message) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
}

function upload(req, res) {
    if (!authorized(req)) return refuse(res, 401, 'bad token');
    const name = sanitize(req.headers['x-filename']);
    const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    if (!EXTENSIONS.has(ext)) return refuse(res, 415, `.${ext || '?'} is not accepted`);

    const id = crypto.randomBytes(6).toString('hex');
    const dest = path.join(state.inbox, `${id}-${name}`);
    const sink = fs.createWriteStream(dest, { mode: 0o600 });
    let size = 0;
    let failed = false;

    req.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BYTES && !failed) {
            failed = true;
            sink.destroy();
            fs.unlink(dest, () => {});
            refuse(res, 413, 'over the 50 MB cap');
            req.destroy();
        }
    });
    req.on('error', () => {
        if (failed) return;
        failed = true;
        sink.destroy();
        fs.unlink(dest, () => {});
    });
    sink.on('error', err => {
        if (failed) return;
        failed = true;
        refuse(res, 500, err.message);
    });
    sink.on('finish', () => {
        if (failed) return;
        // Registered so retrieval can find it; the crawl is a per-file
        // upsert and the inbox is one directory deep.
        try { fileIndex.crawl({ roots: [state.inbox], maxDepth: 2 }); }
        catch { /* indexing is best-effort; the path still works */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id, name, size }));
        console.log(`[Files] Received ${name} (${size} bytes) as ${id}.`);
    });
    req.pipe(sink);
}

function fromInbox(id) {
    let entries;
    try { entries = fs.readdirSync(state.inbox); } catch { return null; }
    const hit = entries.find(entry => entry.startsWith(`${id}-`));
    if (!hit) return null;
    return { path: path.join(state.inbox, hit), name: hit.slice(id.length + 1) };
}

function download(req, res, id) {
    if (!authorized(req)) return refuse(res, 401, 'bad token');
    if (!/^[0-9a-f]{12,16}$/.test(id)) return refuse(res, 404, 'no such file');
    const found = fromInbox(id) || conversationStore.artifactPath(id);
    if (!found || !fs.existsSync(found.path)) return refuse(res, 404, 'no such file');
    const ext = found.name.includes('.') ? found.name.split('.').pop().toLowerCase() : '';
    res.writeHead(200, {
        'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${found.name.replace(/[\r\n"]/g, '')}"`,
        'Content-Length': fs.statSync(found.path).size
    });
    fs.createReadStream(found.path).pipe(res);
}

// True when the request belonged to the file lane, handled or refused.
function route(req, res) {
    const url = String(req.url || '');
    if (url === '/files' && req.method === 'PUT') {
        if (!state) { refuse(res, 503, 'file lane not ready'); return true; }
        upload(req, res);
        return true;
    }
    if (url.startsWith('/files/') && req.method === 'GET') {
        if (!state) { refuse(res, 503, 'file lane not ready'); return true; }
        download(req, res, url.slice('/files/'.length));
        return true;
    }
    return false;
}

// Uploaded ids named on an intent become real paths the planner can read.
function resolveAttachments(ids) {
    if (!state || !Array.isArray(ids)) return [];
    return ids.slice(0, 5)
        .map(raw => String(raw))
        .filter(id => /^[0-9a-f]{12,16}$/.test(id))
        .map(id => { const found = fromInbox(id); return found && { id, ...found }; })
        .filter(Boolean);
}

module.exports = { init, route, resolveAttachments };
