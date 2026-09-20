#!/usr/bin/env node
// Catalogue-size sensitivity: pads the frozen 36-skill catalogue with decoy
// skills in domains no item touches, so every label stays valid while the
// selection stage has two or four times as many candidates to confuse. Writes
// skills-padded-72 and skills-padded-144 beside the frozen copy and prints
// any decoy whose name shares a content word with an item, for review.
//
//   node tools/router-pad.js

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const STUDY = path.join(ROOT, 'docs', 'measurements', 'router-study');
const FROZEN = path.join(STUDY, 'skills-frozen');

// [name, description, parameters]
const DECOYS = [
    ['git-current-branch', 'Reports the current branch of a git repository.', { repo: 'string' }],
    ['git-uncommitted-changes', 'Lists files with uncommitted changes in a git repository.', { repo: 'string' }],
    ['git-last-commit-message', 'Shows the message of the most recent commit in a repository.', { repo: 'string' }],
    ['git-stale-branches', 'Lists local git branches with no commits in the last 90 days.', { repo: 'string' }],
    ['git-repo-size', 'Reports the on-disk size of a git repository and its .git folder.', { repo: 'string' }],
    ['git-tag-list', 'Lists the tags of a git repository, newest first.', { repo: 'string' }],
    ['git-contributor-count', 'Counts distinct commit authors in a git repository.', { repo: 'string' }],
    ['git-init-here', 'Initialises a new git repository in a folder.', { folder: 'string' }],
    ['git-ignored-files', 'Lists files that the repository .gitignore currently excludes.', { repo: 'string' }],
    ['git-blame-line', 'Shows who last changed a given line of a file in a git repository.', { file: 'string', line: 'number' }],
    ['docker-running-containers', 'Lists the Docker containers currently running.', {}],
    ['docker-image-sizes', 'Reports the size of each local Docker image.', {}],
    ['docker-prune-dangling', 'Removes dangling Docker images that no container uses.', {}],
    ['docker-container-logs', 'Shows the last lines of a Docker container log.', { container: 'string', lines: 'number' }],
    ['docker-stop-container', 'Stops a running Docker container by name.', { container: 'string' }],
    ['docker-compose-status', 'Reports the status of services in a docker-compose project.', { project: 'string' }],
    ['docker-port-map', 'Lists the published ports of a running container.', { container: 'string' }],
    ['docker-restart-container', 'Restarts a Docker container by name.', { container: 'string' }],
    ['sqlite-list-tables', 'Lists the tables in a SQLite database file.', { database: 'string' }],
    ['sqlite-row-count', 'Counts the rows in a table of a SQLite database.', { database: 'string', table: 'string' }],
    ['sqlite-table-schema', 'Prints the schema of a table in a SQLite database.', { database: 'string', table: 'string' }],
    ['sqlite-vacuum', 'Compacts a SQLite database file.', { database: 'string' }],
    ['sqlite-export-table', 'Exports one SQLite table to a JSON file.', { database: 'string', table: 'string', output: 'string' }],
    ['sqlite-integrity-check', 'Runs an integrity check on a SQLite database.', { database: 'string' }],
    ['postgres-connection-test', 'Checks whether a local PostgreSQL server accepts connections.', { port: 'number' }],
    ['sqlite-largest-tables', 'Ranks the tables of a SQLite database by row count.', { database: 'string' }],
    ['sqlite-index-list', 'Lists the indexes defined in a SQLite database.', { database: 'string' }],
    ['sqlite-run-query', 'Runs a read-only SQL query against a SQLite database.', { database: 'string', query: 'string' }],
    ['audio-duration', 'Reports the duration of an audio file.', { file: 'string' }],
    ['audio-sample-rate', 'Reports the sample rate and channel count of an audio file.', { file: 'string' }],
    ['audio-normalize-loudness', 'Normalises the loudness of an audio file to a target level.', { file: 'string', lufs: 'number' }],
    ['audio-trim-silence', 'Trims leading and trailing silence from an audio file.', { file: 'string' }],
    ['audio-to-mono', 'Downmixes a stereo audio file to mono.', { file: 'string' }],
    ['audio-split-chapters', 'Splits an audio file at given timestamps into chapter files.', { file: 'string', timestamps: 'string' }],
    ['audio-fade-edges', 'Applies a short fade in and fade out to an audio file.', { file: 'string', seconds: 'number' }],
    ['audio-bitrate-report', 'Reports the bitrate of every audio file in a folder.', { folder: 'string' }],
    ['audio-concatenate', 'Joins several audio files into one in the order given.', { files: 'string', output: 'string' }],
    ['audio-peak-level', 'Reports the peak level of an audio file in dBFS.', { file: 'string' }],
    ['video-duration', 'Reports the duration and frame rate of a video file.', { file: 'string' }],
    ['video-extract-audio', 'Extracts the audio track of a video file to a separate file.', { file: 'string' }],
    ['video-thumbnail-at', 'Captures a single frame of a video at a timestamp.', { file: 'string', timestamp: 'string' }],
    ['video-resolution-report', 'Reports the resolution of every video file in a folder.', { folder: 'string' }],
    ['video-trim-clip', 'Cuts a clip out of a video between two timestamps.', { file: 'string', start: 'string', end: 'string' }],
    ['video-mute-track', 'Removes the audio track from a video file.', { file: 'string' }],
    ['video-frame-count', 'Counts the frames in a video file.', { file: 'string' }],
    ['video-subtitle-list', 'Lists the subtitle tracks embedded in a video file.', { file: 'string' }],
    ['mesh-vertex-count', 'Counts the vertices and faces of a 3D mesh file.', { file: 'string' }],
    ['mesh-bounding-box', 'Reports the bounding box dimensions of a 3D model file.', { file: 'string' }],
    ['mesh-scale-model', 'Scales a 3D model file by a factor.', { file: 'string', factor: 'number' }],
    ['stl-to-obj', 'Converts an STL mesh file to OBJ.', { file: 'string' }],
    ['mesh-center-origin', 'Recentres a 3D model on its origin.', { file: 'string' }],
    ['gcode-print-time', 'Estimates the print time of a G-code file.', { file: 'string' }],
    ['ping-host', 'Pings a host a few times and reports the round-trip times.', { host: 'string' }],
    ['dns-lookup', 'Resolves a hostname to its addresses.', { host: 'string' }],
    ['port-open-check', 'Checks whether a TCP port is open on a host.', { host: 'string', port: 'number' }],
    ['local-ip-address', 'Reports the local IP address of this Mac on the current network.', {}],
    ['public-ip-address', 'Reports the public IP address of this connection.', {}],
    ['traceroute-host', 'Traces the network route to a host.', { host: 'string' }],
    ['listening-ports', 'Lists the ports on which local processes are listening.', {}],
    ['wifi-signal-strength', 'Reports the signal strength of the current Wi-Fi connection.', {}],
    ['dns-server-list', 'Lists the DNS servers the system currently uses.', {}],
    ['network-interface-list', 'Lists the network interfaces and their states.', {}],
    ['brew-outdated', 'Lists Homebrew packages with newer versions available.', {}],
    ['brew-installed-list', 'Lists installed Homebrew packages.', {}],
    ['brew-package-info', 'Shows the description and version of a Homebrew package.', { package: 'string' }],
    ['npm-outdated-global', 'Lists globally installed npm packages that are outdated.', {}],
    ['pip-installed-list', 'Lists installed Python packages and their versions.', {}],
    ['brew-cleanup', 'Removes old versions of Homebrew packages from the cache.', {}],
    ['npm-audit-project', 'Runs a security audit on an npm project.', { project: 'string' }],
    ['pip-check-conflicts', 'Checks installed Python packages for dependency conflicts.', {}],
    ['regex-test', 'Tests a regular expression against a sample string.', { pattern: 'string', sample: 'string' }],
    ['regex-count-matches', 'Counts matches of a regular expression in a file.', { pattern: 'string', file: 'string' }],
    ['regex-explain', 'Explains what a regular expression matches, piece by piece.', { pattern: 'string' }],
    ['regex-replace-in-file', 'Replaces every match of a pattern in a file with a replacement.', { pattern: 'string', replacement: 'string', file: 'string' }],
    ['regex-extract-groups', 'Extracts capture groups from every match in a file.', { pattern: 'string', file: 'string' }],
    ['regex-validate', 'Checks whether a regular expression is syntactically valid.', { pattern: 'string' }],
    ['file-sha256', 'Computes the SHA-256 checksum of a file.', { file: 'string' }],
    ['file-md5', 'Computes the MD5 checksum of a file.', { file: 'string' }],
    ['verify-checksum', 'Verifies a file against an expected SHA-256 checksum.', { file: 'string', expected: 'string' }],
    ['checksum-manifest', 'Writes a manifest of SHA-256 checksums for every file in a folder.', { folder: 'string' }],
    ['hash-string', 'Computes the SHA-256 hash of a text string.', { text: 'string' }],
    ['base64-encode-file', 'Encodes a file as base64 text.', { file: 'string' }],
    ['convert-units', 'Converts a quantity between units of length, mass or temperature.', { value: 'number', from: 'string', to: 'string' }],
    ['currency-format', 'Formats a number as a currency string in a given locale.', { value: 'number', locale: 'string' }],
    ['timezone-convert', 'Converts a time from one timezone to another.', { time: 'string', from: 'string', to: 'string' }],
    ['epoch-to-date', 'Converts a Unix timestamp to a readable date.', { epoch: 'number' }],
    ['date-difference', 'Reports the number of days between two dates.', { start: 'string', end: 'string' }],
    ['roman-numeral', 'Converts a number to and from Roman numerals.', { value: 'string' }],
    ['color-hex-to-rgb', 'Converts a hex colour code to RGB values.', { hex: 'string' }],
    ['color-contrast-ratio', 'Computes the WCAG contrast ratio between two colours.', { foreground: 'string', background: 'string' }],
    ['color-palette-from-image', 'Extracts the dominant colours of an image.', { file: 'string', count: 'number' }],
    ['color-lighten', 'Lightens a hex colour by a percentage.', { hex: 'string', percent: 'number' }],
    ['color-complement', 'Reports the complementary colour of a hex colour.', { hex: 'string' }],
    ['color-name-lookup', 'Finds the nearest named CSS colour to a hex code.', { hex: 'string' }],
    ['qr-code-generate', 'Generates a QR code image for a text string.', { text: 'string', output: 'string' }],
    ['qr-code-decode', 'Reads the text encoded in a QR code image.', { file: 'string' }],
    ['barcode-generate', 'Generates a barcode image for a numeric code.', { code: 'string', output: 'string' }],
    ['qr-wifi-card', 'Generates a QR code that joins a Wi-Fi network.', { ssid: 'string', password: 'string', output: 'string' }],
    ['qr-vcard', 'Generates a QR code containing a contact card.', { name: 'string', phone: 'string', output: 'string' }],
    ['qr-batch-from-csv', 'Generates a QR code image per row of a CSV of links.', { file: 'string', folder: 'string' }],
    ['font-list-installed', 'Lists the fonts installed on this Mac.', {}],
    ['font-file-info', 'Reports the family, style and glyph count of a font file.', { file: 'string' }],
    ['font-subset', 'Subsets a font file to a given set of characters.', { file: 'string', characters: 'string' }],
    ['font-convert-woff2', 'Converts a TTF or OTF font file to WOFF2.', { file: 'string' }],
    ['font-preview-image', 'Renders a sample string in a font file to an image.', { file: 'string', text: 'string' }],
    ['font-missing-glyphs', 'Lists characters of a text that a font file cannot render.', { file: 'string', text: 'string' }],
    ['latex-compile', 'Compiles a LaTeX source file to PDF.', { file: 'string' }],
    ['latex-word-count', 'Counts the words in the body of a LaTeX document.', { file: 'string' }],
    ['latex-list-citations', 'Lists the citation keys used in a LaTeX document.', { file: 'string' }],
    ['bibtex-validate', 'Checks a BibTeX file for malformed entries.', { file: 'string' }],
    ['latex-list-figures', 'Lists the figures included in a LaTeX document.', { file: 'string' }],
    ['latex-clean-aux', 'Deletes the auxiliary files a LaTeX build leaves behind.', { folder: 'string' }],
];

const STOP = new Set(['file', 'files', 'folder', 'list', 'report', 'check', 'count', 'the', 'a', 'to', 'in', 'of', 'my', 'and', 'from', 'into', 'with', 'for', 'on', 'all', 'every', 'this', 'me', 'it', 'is', 'up', 'string', 'convert', 'generate']);

function skillMd(name, description, params) {
    const lines = ['---', `name: ${name}`, 'version: 1.0.0', `description: ${description}`];
    if (Object.keys(params).length) {
        lines.push('parameters:');
        for (const [p, type] of Object.entries(params)) {
            lines.push(`  ${p}:`, `    type: ${type}`, '    required: true', `    description: The ${p.replace(/_/g, ' ')}.`);
        }
    }
    lines.push('exec:', '  type: command', `  argv: ["echo", "decoy", "${name}"]`, `reply: "${description}"`,
        'capabilities:', '  exec: true', '  filesystem: []', '  network: false',
        'provenance:', '  author: builtin', '---', '', `Decoy skill for the catalogue-size sensitivity probe. ${description}`, '');
    return lines.join('\n');
}

function main() {
    if (DECOYS.length < 108) throw new Error(`need 108 decoys, have ${DECOYS.length}`);
    const names = new Set(DECOYS.map(d => d[0]));
    if (names.size !== DECOYS.length) throw new Error('duplicate decoy names');
    const frozenNames = new Set(fs.readdirSync(FROZEN));
    for (const n of names) if (frozenNames.has(n)) throw new Error(`decoy clashes with a frozen skill: ${n}`);

    const items = [];
    for (const f of ['items.jsonl', 'items-final.jsonl', 'items-supplement.jsonl']) {
        const p = path.join(STUDY, f);
        if (fs.existsSync(p)) items.push(...fs.readFileSync(p, 'utf8').trim().split('\n').map(l => JSON.parse(l)));
    }
    const overlaps = [];
    for (const [name] of DECOYS) {
        const words = name.split('-').filter(w => w.length > 3 && !STOP.has(w));
        for (const it of items) {
            const text = ` ${it.prompt.toLowerCase()} `;
            const hit = words.filter(w => text.includes(` ${w}`));
            if (hit.length) overlaps.push(`${name} ~ ${it.id} "${it.prompt}" (${hit.join(',')})`);
        }
    }

    for (const [size, count] of [[72, 36], [144, 108]]) {
        const dir = path.join(STUDY, `skills-padded-${size}`);
        fs.rmSync(dir, { recursive: true, force: true });
        fs.cpSync(FROZEN, dir, { recursive: true });
        for (const [name, description, params] of DECOYS.slice(0, count)) {
            fs.mkdirSync(path.join(dir, name));
            fs.writeFileSync(path.join(dir, name, 'SKILL.md'), skillMd(name, description, params));
        }
        // The registry is the judge of what counts: a decoy it rejects pads nothing.
        const loaded = require('child_process').execFileSync('node', ['-e',
            'console.log(require("./services/skillRegistry").list().length)'],
            { cwd: path.resolve(__dirname, '..'), env: { ...process.env, JARVIS_SKILLS_DIR: dir }, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n').pop();
        if (Number(loaded) !== size) throw new Error(`${dir}: registry loaded ${loaded} skills, expected ${size}`);
        console.log(`${path.relative(ROOT, dir)}: ${loaded} skills loaded by the registry`);
    }
    console.log(`decoy/item word overlaps to review (${overlaps.length}):`);
    for (const o of overlaps) console.log('  ' + o);
}

main();
