// The mail loop is provider-agnostic: recipes, mandate rules and the browser
// lanes work on whatever mailbox the linked browser is signed in to. The only
// thing that names a provider is the URL the planner steers to, and it lives
// here.

const PROVIDERS = {
    gmail: { label: 'Gmail', url: 'https://mail.google.com' },
    outlook: { label: 'Outlook (personal)', url: 'https://outlook.live.com/mail' },
    'outlook-work': { label: 'Outlook (work or school)', url: 'https://outlook.office.com/mail' }
};

function current(config) {
    const requested = (config.mail && config.mail.provider) || 'gmail';
    const name = PROVIDERS[requested] ? requested : 'gmail';
    return { name, ...PROVIDERS[name] };
}

module.exports = { PROVIDERS, current };
