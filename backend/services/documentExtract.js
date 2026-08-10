const fs = require('fs');
const { execFileSync } = require('child_process');

// PDF text comes out through the same Python that runs the inference server —
// the corpus cannot be embedded without that environment alive, so leaning on
// it for extraction adds no new dependency to the machine. docx goes through
// macOS's own textutil. Both are probed once; a missing tool means the
// extension is simply not ingestible on this machine, never an error.

const MAX_EXTRACT_CHARS = 400000;
const TIMEOUT_MS = 30000;

const PDF_SCRIPT = `
import sys
from pypdf import PdfReader
reader = PdfReader(sys.argv[1])
for page in reader.pages:
    text = page.extract_text() or ""
    if text.strip():
        print(text)
`;

function extractPdf(file) {
    return execFileSync('python3', ['-c', PDF_SCRIPT, file], {
        encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024
    });
}

function extractDocx(file) {
    return execFileSync('/usr/bin/textutil', ['-convert', 'txt', '-stdout', file], {
        encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024
    });
}

const EXTRACTORS = {
    '.pdf': extractPdf,
    '.docx': extractDocx
};

const probed = new Map();

function available(extension) {
    if (probed.has(extension)) return probed.get(extension);

    let ok = false;
    try {
        if (extension === '.pdf') {
            execFileSync('python3', ['-c', 'import pypdf'], { timeout: 10000 });
            ok = true;
        } else if (extension === '.docx') {
            ok = process.platform === 'darwin' && fs.existsSync('/usr/bin/textutil');
        }
    } catch {
        ok = false;
    }
    probed.set(extension, ok);
    return ok;
}

function supported() {
    return new Set(Object.keys(EXTRACTORS).filter(available));
}

function extract(file, extension) {
    const extractor = EXTRACTORS[extension];
    if (!extractor || !available(extension)) return null;
    try {
        const text = extractor(file);
        const trimmed = String(text || '').replace(/\r\n/g, '\n').trim();
        return trimmed ? trimmed.slice(0, MAX_EXTRACT_CHARS) : null;
    } catch (err) {
        console.warn(`[Extract] ${file}: ${err.message.split('\n')[0]}`);
        return null;
    }
}

module.exports = { extract, supported, available, EXTRACTORS, MAX_EXTRACT_CHARS };
