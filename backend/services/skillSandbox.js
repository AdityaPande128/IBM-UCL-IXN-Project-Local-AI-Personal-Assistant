const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();

const SENSITIVE_READ_PATHS = [
    '~/.ssh',
    '~/.aws',
    '~/.gnupg',
    '~/.kube',
    '~/.docker',
    '~/.netrc',
    '~/.npmrc',
    '~/.git-credentials',
    '~/.config/gh',
    '~/.claude',
    '~/Library/Keychains',
    '~/Library/Application Support/Google/Chrome',
    '~/Library/Application Support/Firefox',
    '~/Library/Safari',
    '~/Library/Cookies',
    '~/Library/Messages',
    '~/Library/Mail'
];

const JARVIS_PRIVATE_PATHS = [
    path.join(__dirname, '..', 'data'),
    path.join(__dirname, '..', 'skills')
];

function resolvePath(declared) {
    let expanded = String(declared).trim();
    if (expanded === '~') expanded = HOME;
    else if (expanded.startsWith('~/')) expanded = path.join(HOME, expanded.slice(2));

    expanded = path.resolve(expanded);

    let existing = expanded;
    const trailing = [];
    while (!fs.existsSync(existing)) {
        const parent = path.dirname(existing);
        if (parent === existing) return expanded;
        trailing.unshift(path.basename(existing));
        existing = parent;
    }

    try {
        return path.join(fs.realpathSync(existing), ...trailing);
    } catch {
        return expanded;
    }
}

function sbplString(value) {
    return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const UNSCOPED = new Set();
for (const broad of [HOME, '/', '/Users', '/private', '/tmp', '/var', '/etc', os.tmpdir()]) {
    UNSCOPED.add(broad);
    try {
        UNSCOPED.add(fs.realpathSync(broad));
    } catch {
    }
}

function isUnscoped(resolved) {
    const text = String(resolved);
    const normalised = text.length > 1 ? text.replace(/\/+$/, '') : text;
    return UNSCOPED.has(normalised);
}

function deriveScopesFromParameters(parameters = {}) {
    const scopes = [];

    for (const value of Object.values(parameters)) {
        if (typeof value !== 'string') continue;
        const trimmed = value.trim();
        if (!trimmed.startsWith('/') && !trimmed.startsWith('~')) continue;

        const resolved = resolvePath(trimmed);
        if (isUnscoped(resolved)) continue;

        scopes.push(resolved);
        const parent = path.dirname(resolved);
        if (!isUnscoped(parent)) scopes.push(parent);
    }

    return [...new Set(scopes)];
}

function interpreterPrefixes(skill) {
    const command = (skill.exec && skill.exec.argv && skill.exec.argv[0]) || '';
    if (!command || command.includes('/')) {
        return command.startsWith(HOME) ? [path.dirname(path.dirname(command))] : [];
    }

    try {
        const resolved = require('child_process')
            .execFileSync('/usr/bin/which', [command], { encoding: 'utf8' }).trim();
        if (!resolved) return [];

        const real = fs.realpathSync(resolved);
        if (!real.startsWith(HOME + path.sep)) return [];

        return [path.dirname(path.dirname(real))];
    } catch {
        return [];
    }
}

function shouldEnforce(skill, mode = 'generated') {
    if (mode === 'never') return false;
    if (mode === 'always') return true;
    return (skill.provenance && skill.provenance.author) === 'generated';
}

function buildProfile(skill, tempDir, parameters = {}, allowRead = []) {
    const capabilities = skill.capabilities || {};
    const lines = [
        '(version 1)',
        '(deny default)',
        '',
        '; System paths stay readable so the interpreter can start; the user\'s',
        '; home directory does not. Rules are last-match-wins, so the deny below',
        '; overrides this allow, and the re-allows after it override the deny.',
        '(allow file-read*)',
        '(allow file-read-metadata)',
        '(allow sysctl-read)',
        '(allow file-ioctl)',
        '(allow mach-lookup)',
        '',
        '; The user\'s data is not readable by default.',
        `(deny file-read* (subpath ${sbplString(HOME)}))`
    ];

    if (capabilities.exec !== false) {
        lines.push('(allow process-exec process-fork)');
    }

    lines.push('', '; Writes are confined to declared paths plus private scratch.');

    const declared = (capabilities.filesystem || []).map(resolvePath);
    const tooBroad = declared.filter(isUnscoped);
    const scopedDeclarations = declared.filter(d => !isUnscoped(d));

    if (tooBroad.length) {
        console.warn(
            `[SkillSandbox] "${skill.name}" declares ${tooBroad.join(', ')}, which grants ` +
            `everything and is therefore ignored; using scopes derived from this invocation.`
        );
        lines.push(`; Ignored over-broad declaration(s): ${tooBroad.join(', ')}`);
    }

    const writable = [
        tempDir,
        ...scopedDeclarations,
        ...deriveScopesFromParameters(parameters)
    ];

    for (const target of [...new Set(writable)]) {
        lines.push(`(allow file-write* (subpath ${sbplString(target)}))`);
    }
    lines.push('(allow file-write-data (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr"))');
    // TMPDIR is a symlink into /private/var/folders; the grant follows the
    // job's own directory there, not the whole per-user temp universe.
    let realTemp = tempDir;
    try { realTemp = fs.realpathSync(tempDir); } catch { }
    if (realTemp !== tempDir) {
        lines.push(`(allow file-write* (subpath ${sbplString(realTemp)}))`);
        lines.push(`(allow file-read* (subpath ${sbplString(realTemp)}))`);
    }

    lines.push('', '; Readable despite the home-directory denial.');
    lines.push(`(allow file-read* (subpath ${sbplString(skill.directory)}))`);
    lines.push(`(allow file-read* (subpath ${sbplString(tempDir)}))`);

    for (const prefix of interpreterPrefixes(skill)) {
        lines.push(`(allow file-read* (subpath ${sbplString(prefix)}))`);
    }
    for (const target of [...new Set(writable)]) {
        lines.push(`(allow file-read* (subpath ${sbplString(target)}))`);
    }

    for (const granted of allowRead) {
        lines.push('; The user granted this run read access here.');
        lines.push(`(allow file-read* (subpath ${sbplString(resolvePath(granted))}))`);
    }

    lines.push('', '; The skill cannot modify itself.');
    lines.push(`(deny file-write* (subpath ${sbplString(skill.directory)}))`);

    lines.push('', '; Never readable or writable, whatever the invocation asked for.');
    for (const sensitive of SENSITIVE_READ_PATHS) {
        const resolved = resolvePath(sensitive);
        lines.push(`(deny file-read* (subpath ${sbplString(resolved)}))`);
        lines.push(`(deny file-write* (subpath ${sbplString(resolved)}))`);
    }

    lines.push('', '; The assistant\'s own profile and stores are not the skill\'s to touch.');
    for (const privatePath of JARVIS_PRIVATE_PATHS) {
        const resolved = resolvePath(privatePath);
        lines.push(`(deny file-read* (subpath ${sbplString(resolved)}))`);
        lines.push(`(deny file-write* (subpath ${sbplString(resolved)}))`);
    }
    lines.push(`(allow file-read* (subpath ${sbplString(skill.directory)}))`);
    lines.push(`(deny file-write* (subpath ${sbplString(skill.directory)}))`);

    lines.push('');
    if (capabilities.network === true) {
        lines.push('; Manifest declares network access.');
        lines.push('(allow network*)');
    } else {
        lines.push('; No network capability declared.');
        lines.push('(deny network*)');
    }

    return lines.join('\n') + '\n';
}

function wrap(skill, argv, tempDir, mode = 'generated', parameters = {}, allowRead = []) {
    if (!shouldEnforce(skill, mode)) {
        return { argv, profilePath: null, enforced: false };
    }

    if (!fs.existsSync('/usr/bin/sandbox-exec')) {
        console.warn(`[SkillSandbox] sandbox-exec unavailable — "${skill.name}" runs unconfined.`);
        return { argv, profilePath: null, enforced: false };
    }

    const profile = buildProfile(skill, tempDir, parameters);
    const profilePath = path.join(tempDir, '.skill-sandbox.sb');
    fs.writeFileSync(profilePath, profile, 'utf8');

    return {
        argv: ['sandbox-exec', '-f', profilePath, ...argv],
        profilePath,
        enforced: true
    };
}

module.exports = {
    wrap,
    buildProfile,
    deriveScopesFromParameters,
    isUnscoped,
    shouldEnforce,
    resolvePath,
    SENSITIVE_READ_PATHS
};
