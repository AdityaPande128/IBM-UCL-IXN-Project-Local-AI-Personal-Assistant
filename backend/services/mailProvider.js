// The mail loop is provider-agnostic: recipes, mandate rules and the browser
// lanes work on whatever mailbox the linked browser is signed in to. The only
// thing that names a provider is the URL the planner steers to, and it lives
// here. With config.mail.accounts a user can hold several mailboxes at once
// ("personal": "gmail", "work": "outlook-work") and steer by name: a request
// that says "work mail" goes to the work account, anything else to the default.

const PROVIDERS = {
    gmail: { label: 'Gmail', url: 'https://mail.google.com',
             calendar: 'https://calendar.google.com' },
    outlook: { label: 'Outlook (personal)', url: 'https://outlook.live.com/mail',
               calendar: 'https://outlook.live.com/calendar' },
    'outlook-work': { label: 'Outlook (work or school)', url: 'https://outlook.office.com/mail',
                      calendar: 'https://outlook.office.com/calendar' }
};

function current(config) {
    const requested = (config.mail && config.mail.provider) || 'gmail';
    const name = PROVIDERS[requested] ? requested : 'gmail';
    return { name, ...PROVIDERS[name] };
}

function accounts(config) {
    const named = (config.mail && config.mail.accounts) || {};
    const list = [];
    for (const [account, provider] of Object.entries(named)) {
        if (!PROVIDERS[provider]) continue;
        list.push({ account, name: provider, ...PROVIDERS[provider] });
    }
    return list;
}

function hostOf(url) {
    try { return new URL(url).hostname; } catch { return null; }
}

const MAIL_HOSTS = new Set(Object.values(PROVIDERS).map(p => hostOf(p.url)));

// Each mailbox spells a search URL its own way; the query syntax (from:, to:)
// is common to both. A host not named here gets no URL — guessing a shape
// navigates to a dead page and burns the loop's budget, while the ladder
// search through the page's own box already handles an unknown mailbox.
//
// The 'sent' scope exists because Outlook searches conversations: from: and
// to: return the same threads, and only the Sent Items folder isolates what
// the user themselves sent. Gmail search is message-scoped and needs no
// folder.
const SEARCH_URLS = {
    'mail.google.com': (origin, query) =>
        `${origin}/mail/u/0/#search/${encodeURIComponent(query)}`,
    'outlook.live.com': (origin, query, scope) =>
        `${origin}/mail/0/${scope === 'sent' ? 'sentitems' : 'search'}`
        + `?q=${encodeURIComponent(query)}`,
    'outlook.office.com': (origin, query, scope) =>
        `${origin}/mail/${scope === 'sent' ? 'sentitems' : 'search'}`
        + `?q=${encodeURIComponent(query)}`
};

function searchUrl(pageUrl, query, scope) {
    try {
        const url = new URL(pageUrl);
        const build = SEARCH_URLS[url.hostname];
        return build ? build(url.origin, query, scope) : null;
    } catch {
        return null;
    }
}

// A recipe is only as portable as the mailbox it was learned on. A procedure
// surfaced on one provider's host neither replays nor gets offered when the
// request steers to a different provider; the work falls back to browsing
// the mailbox the user actually chose.
function surfaceApplies(surface, request, config) {
    if (!MAIL_HOSTS.has(surface)) return true;
    return surface === hostOf(forRequest(request, config).url);
}

// Steering is deliberately narrow: the account name must qualify a mail word
// ("work mail", "uni inbox", "the personal account"). A bare mention steers
// nothing — "tell my work colleague" is about a colleague, not a mailbox —
// and a miss lands on the default account, never on a wrong action.
function forRequest(text, config) {
    const request = String(text || '');
    for (const acct of accounts(config)) {
        const name = acct.account.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const qualifies = new RegExp(
            `\\b${name}\\s+(mail|e-?mail|inbox|mailbox|account|calendar)s?\\b`, 'i');
        if (qualifies.test(request)) return acct;
    }
    return current(config);
}

module.exports = {
    PROVIDERS, MAIL_HOSTS,
    current, accounts, forRequest, surfaceApplies, searchUrl
};
