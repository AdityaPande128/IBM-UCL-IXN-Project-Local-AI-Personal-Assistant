// Cookie banners are dismissed mechanically, before the model ever sees the
// page. They are never part of the task, they cover the controls that are, and
// a small model spends its whole action budget fighting them — the Tate run
// died clicking a link the banner covered. The privacy default is decline:
// the accept-everything button is never pressed on the user's behalf, and a
// banner offering nothing but acceptance is left alone.

const CONSENT = '\\bcookies?\\b|\\bconsent\\b|we value your privacy|privacy (choices|preferences)';
const DECLINE = '\\b(reject|decline|refuse|deny)\\b|only (necessary|essential)'
    + '|(necessary|essential)( cookies)? only|strictly necessary|continue without';

async function dismiss(page) {
    return page.evaluate(([consentSource, declineSource]) => {
        const consent = new RegExp(consentSource, 'i');
        const decline = new RegExp(declineSource, 'i');

        const visible = (el) => {
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return rect.width > 4 && rect.height > 4
                && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const label = (el) =>
            (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();

        // The button is found first and its surroundings checked after —
        // banner frameworks name their containers after themselves (OneTrust,
        // TrustArc), so no list of container selectors survives contact with
        // the field. A decline-shaped control inside consent-shaped prose is
        // the banner, whatever the div is called.
        const controls = [...document.querySelectorAll(
            'button, [role="button"], a, input[type="button"], input[type="submit"]')]
            .filter(visible)
            .filter(el => decline.test(label(el)) && label(el).length <= 40);

        for (const control of controls) {
            let matched = false;
            let hops = 0;
            for (let up = control.parentElement; up && hops < 8; up = up.parentElement, hops += 1) {
                const text = up.innerText || '';
                if (consent.test(text)) { matched = true; break; }
                if (text.length > 2500) break;
            }
            if (matched) {
                control.click();
                return { dismissed: true, label: label(control).slice(0, 60) };
            }
        }
        return { dismissed: false };
    }, [CONSENT, DECLINE]);
}

module.exports = { dismiss, CONSENT, DECLINE };
