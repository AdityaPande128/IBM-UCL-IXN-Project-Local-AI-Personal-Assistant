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

// The daemon's own PATH is the shell's, and its first python3 may be a
// bare framework build; the interpreter that has pypdf is found once from
// the usual homes and remembered.
const PYTHON_HOMES = [
    process.env.JARVIS_PYTHON,
    '/opt/anaconda3/bin/python3',
    '/opt/homebrew/bin/python3',
    'python3',
    '/usr/local/bin/python3',
    '/usr/bin/python3'
].filter(Boolean);

let pythonWithPdf;

function pythonForPdf() {
    if (pythonWithPdf !== undefined) return pythonWithPdf;
    pythonWithPdf = null;
    for (const candidate of PYTHON_HOMES) {
        try {
            execFileSync(candidate, ['-c', 'import pypdf'], { timeout: 10000, stdio: 'ignore' });
            pythonWithPdf = candidate;
            break;
        } catch { /* not this one */ }
    }
    return pythonWithPdf;
}

function extractPdf(file) {
    return execFileSync(pythonForPdf(), ['-c', PDF_SCRIPT, file], {
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
            ok = Boolean(pythonForPdf());
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
