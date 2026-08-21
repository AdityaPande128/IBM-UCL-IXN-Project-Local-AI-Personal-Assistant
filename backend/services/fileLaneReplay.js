const http = require('http');

// Framed file ops replayed against the local HTTP lane with the daemon's
// own token — one implementation for every tunnel that carries them, so
// the same caps and the same refusals apply however the bytes arrived.
function replay({ port, token }, meta, body, respond) {
    const options = { headers: { authorization: `Bearer ${token}` } };
    if (meta.op === 'put') {
        options.method = 'PUT';
        options.headers['x-filename'] = String(meta.name || 'upload');
        const req = http.request(`http://127.0.0.1:${port}/files`, options, res => {
            const pieces = [];
            res.on('data', piece => pieces.push(piece));
            res.on('end', () => respond(res.statusCode, {
                json: Buffer.concat(pieces).toString('utf8') }));
        });
        req.on('error', err => respond(502, { json: JSON.stringify({ error: err.message }) }));
        req.end(body);
        return;
    }
    if (meta.op === 'get' && /^[0-9a-f]{12,16}$/.test(String(meta.id || ''))) {
        const req = http.request(`http://127.0.0.1:${port}/files/${meta.id}`, options, res => {
            const pieces = [];
            res.on('data', piece => pieces.push(piece));
            res.on('end', () => respond(res.statusCode, {
                mime: res.headers['content-type'] || 'application/octet-stream',
                name: meta.id
            }, Buffer.concat(pieces)));
        });
        req.on('error', err => respond(502, { json: JSON.stringify({ error: err.message }) }));
        req.end();
        return;
    }
    respond(400, { json: JSON.stringify({ error: 'unknown file op' }) });
}

module.exports = { replay };
