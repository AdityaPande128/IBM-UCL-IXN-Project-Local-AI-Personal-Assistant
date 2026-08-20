const test = require('node:test');
const assert = require('node:assert');

const natPmp = require('../services/natPmp');

test('the mapping request carries port and lifetime exactly per RFC 6886', () => {
    const req = natPmp.buildMapRequest(8080, 8080, 3600);
    assert.equal(req.length, 12);
    assert.equal(req[0], 0, 'version 0');
    assert.equal(req[1], 2, 'opcode 2 is TCP');
    assert.equal(req.readUInt16BE(4), 8080);
    assert.equal(req.readUInt16BE(6), 8080);
    assert.equal(req.readUInt32BE(8), 3600);
});

test('a granted mapping parses; a refused or garbled one is null', () => {
    const ok = Buffer.alloc(16);
    ok[1] = 130;
    ok.writeUInt16BE(0, 2);
    ok.writeUInt16BE(8080, 8);
    ok.writeUInt16BE(43210, 10);
    ok.writeUInt32BE(1800, 12);
    assert.deepEqual(natPmp.parseMapResponse(ok),
        { internalPort: 8080, externalPort: 43210, lifetime: 1800 });

    const refused = Buffer.from(ok);
    refused.writeUInt16BE(2, 2); // not authorized
    assert.equal(natPmp.parseMapResponse(refused), null);
    assert.equal(natPmp.parseMapResponse(Buffer.from([9, 9])), null);
    assert.equal(natPmp.parseMapResponse(null), null);
});

test('the external address reply yields a dotted quad, or nothing', () => {
    const ok = Buffer.alloc(12);
    ok[1] = 128;
    ok[8] = 82; ok[9] = 4; ok[10] = 100; ok[11] = 7;
    assert.equal(natPmp.parseExternalResponse(ok), '82.4.100.7');
    const refused = Buffer.from(ok);
    refused.writeUInt16BE(3, 2);
    assert.equal(natPmp.parseExternalResponse(refused), null);
});
