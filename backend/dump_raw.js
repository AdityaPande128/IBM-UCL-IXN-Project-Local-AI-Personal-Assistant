const fs = require('fs');
function injectDebug(file) {
    let content = fs.readFileSync(file, 'utf8');
    content = content.replace(`    const all = (raw.elements || []).filter(element =>`, `    console.log('[DEBUG] RAW ELEMENTS TOTAL:', (raw.elements || []).length);
    (raw.elements || []).forEach(e => {
        if (/to|recipient/i.test(e.name || '') || /to|recipient/i.test(e.value || '')) {
            console.log('[DEBUG] RAW MATCH:', e.role, e.name, e.value);
        }
    });
    const all = (raw.elements || []).filter(element =>`);
    fs.writeFileSync(file, content);
}
injectDebug('/Users/adityapande/Coding/Jarvis/backend/services/chromeSurface.js');
