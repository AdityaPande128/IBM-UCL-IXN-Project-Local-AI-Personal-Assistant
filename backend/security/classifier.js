const os = require('os');
const path = require('path');

const { SENSITIVITY, ORIGIN, label } = require('./labels');

const HOME = os.homedir();


const SECRET_DIRECTORIES = new Set([
    '.ssh',
    '.gnupg',
    '.aws',
    '.azure',
    '.kube',
    '.docker',
    '.password-store',
    'Keychains',
    'keyrings',
    'Safari',
    'Cookies',
    'Firefox',
    'Chrome Profile',
    'Electrum',
    'Exodus'
]);

const SECRET_PREFIXES = [
    path.join(HOME, 'Library', 'Keychains'),
    path.join(HOME, 'Library', 'Cookies'),
    path.join(HOME, 'Library', 'Application Support', 'Google', 'Chrome'),
    path.join(HOME, 'Library', 'Application Support', 'Firefox'),
    path.join(HOME, 'Library', 'Application Support', 'BraveSoftware'),
    path.join(HOME, 'Library', 'Containers', 'com.apple.Safari'),
    path.join(HOME, 'Library', 'Group Containers', 'group.com.apple.notes'),
    '/private/etc/ssl',
    '/etc/ssl'
];

const SECRET_FILENAMES = new Set([
    '.env',
    '.envrc',
    '.netrc',
    '.npmrc',
    '.pypirc',
    '.git-credentials',
    '.htpasswd',
    'credentials',
    'id_rsa',
    'id_dsa',
    'id_ecdsa',
    'id_ed25519',
    'secring.gpg',
    'shadow',
    'master.passwd',
    'login.keychain-db',
    'Cookies.binarycookies',
    'key4.db',
    'logins.json',
    'Login Data'
]);

const SECRET_EXTENSIONS = new Set([
    '.pem', '.key', '.p12', '.pfx', '.jks', '.keystore',
    '.asc', '.gpg', '.pgp', '.kdbx', '.agilekeychain', '.opvault',
    '.ppk', '.crt', '.cer', '.der'
]);

const SECRET_PATTERNS = [
    /^\.env\./i,
    /(^|[-_.])secrets?([-_.]|$)/i,
    /(^|[-_.])credentials?([-_.]|$)/i,
    /^id_[a-z0-9]+$/i,
    /\.key$/i
];


const PUBLIC_PREFIXES = [
    '/usr/share/doc',
    '/usr/share/man',
    '/Library/Documentation'
];


function segments(target) {
    return path.resolve(target).split(path.sep).filter(Boolean);
}

function underAny(target, prefixes) {
    const resolved = path.resolve(target);
    return prefixes.some(prefix => {
        const base = path.resolve(prefix);
        return resolved === base || resolved.startsWith(base + path.sep);
    });
}

function secretCheck(target) {
    const resolved = path.resolve(target);
    const name = path.basename(resolved);
    const extension = path.extname(name).toLowerCase();

    if (underAny(resolved, SECRET_PREFIXES)) {
        return { secret: true, reason: 'inside a credential or browser-profile store' };
    }

    for (const segment of segments(resolved).slice(0, -1)) {
        if (SECRET_DIRECTORIES.has(segment)) {
            return { secret: true, reason: `inside "${segment}"` };
        }
    }

    if (SECRET_FILENAMES.has(name)) {
        return { secret: true, reason: `"${name}" is a credential file` };
    }

    if (SECRET_EXTENSIONS.has(extension)) {
        return { secret: true, reason: `"${extension}" files carry key material` };
    }

    for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(name)) {
            return { secret: true, reason: `"${name}" matches a credential naming convention` };
        }
    }

    return { secret: false };
}

function classify(target, opts = {}) {
    const origin = opts.origin || ORIGIN.FILE;
    const { secret, reason } = secretCheck(target);

    if (secret) {
        return {
            label: label(origin, SENSITIVITY.SECRET),
            readable: false,
            reason
        };
    }

    if (underAny(target, PUBLIC_PREFIXES)) {
        return {
            label: label(origin, SENSITIVITY.PUBLIC),
            readable: true,
            reason: null
        };
    }

    return {
        label: label(origin, SENSITIVITY.PERSONAL),
        readable: true,
        reason: null
    };
}

function isReadable(target) {
    return !secretCheck(target).secret;
}

module.exports = {
    classify,
    isReadable,
    secretCheck,
    HOME,
    SECRET_DIRECTORIES,
    SECRET_EXTENSIONS,
    SECRET_FILENAMES,
    SECRET_PREFIXES,
    PUBLIC_PREFIXES
};
