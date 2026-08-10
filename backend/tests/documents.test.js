const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

const documentExtract = require('../services/documentExtract');
const corpusIndexer = require('../services/corpusIndexer');

const PDF_READY = documentExtract.available('.pdf');
const DOCX_READY = documentExtract.available('.docx');

// A complete one-page PDF built by hand, offsets computed so the xref is
// exact — no library needed to write what the extractor must read.
function minimalPdf(text) {
    const escaped = text.replace(/([()\\])/g, '\\$1');
    const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;

    const bodies = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
            + '/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
    ];

    let pdf = '%PDF-1.4\n';
    const offsets = [];
    bodies.forEach((body, index) => {
        offsets.push(pdf.length);
        pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    });

    const xrefAt = pdf.length;
    pdf += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) {
        pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\n`
        + `startxref\n${xrefAt}\n%%EOF\n`;
    return Buffer.from(pdf, 'latin1');
}

function scratch() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-documents-'));
    return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}


test('a pdf yields labelled document chunks', { skip: !PDF_READY }, () => {
    const scope = scratch();
    try {
        const file = path.join(scope.dir, 'lease.pdf');
        fs.writeFileSync(file, minimalPdf('The riverside lease ends in March 2027 and the deposit returns with it'));

        const records = corpusIndexer.recordsForFile(file);

        assert.ok(records.length >= 1);
        assert.match(records[0].text, /riverside lease ends in March 2027/);
        assert.strictEqual(records[0].meta.kind, 'document');
        assert.strictEqual(records[0].meta.name, 'lease.pdf');
        assert.ok(records[0].meta.label, 'every chunk carries its label');
    } finally {
        scope.cleanup();
    }
});

test('a docx yields its words back through textutil', { skip: !DOCX_READY }, () => {
    const scope = scratch();
    try {
        const source = path.join(scope.dir, 'notes.txt');
        const docx = path.join(scope.dir, 'notes.docx');
        fs.writeFileSync(source, 'The plumber is booked for Tuesday morning.');
        execFileSync('/usr/bin/textutil',
            ['-convert', 'docx', '-output', docx, source]);

        const records = corpusIndexer.recordsForFile(docx);

        assert.ok(records.length >= 1);
        assert.match(records[0].text, /plumber is booked for Tuesday/);
        assert.strictEqual(records[0].meta.name, 'notes.docx');
    } finally {
        scope.cleanup();
    }
});

test('an unreadable or empty binary is skipped, never an error', () => {
    const scope = scratch();
    try {
        const file = path.join(scope.dir, 'broken.pdf');
        fs.writeFileSync(file, Buffer.from('not a pdf at all'));

        assert.deepStrictEqual(corpusIndexer.recordsForFile(file), []);
    } finally {
        scope.cleanup();
    }
});

test('discovery includes exactly the extractable extensions', () => {
    const supported = documentExtract.supported();
    for (const extension of supported) {
        assert.ok(documentExtract.EXTRACTORS[extension],
            `${extension} is claimed but has no extractor`);
    }
    assert.ok(!supported.has('.xlsx'), 'nothing is claimed that cannot be read');
});

test('plain text files still read exactly as before', () => {
    const scope = scratch();
    try {
        const file = path.join(scope.dir, 'plain.md');
        fs.writeFileSync(file, 'Just words on disk, enough of them to survive the chunker minimum.');

        const records = corpusIndexer.recordsForFile(file);
        assert.strictEqual(records.length, 1);
        assert.match(records[0].text, /Just words on disk/);
    } finally {
        scope.cleanup();
    }
});
