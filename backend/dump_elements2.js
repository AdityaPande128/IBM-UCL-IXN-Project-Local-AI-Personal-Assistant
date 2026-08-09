const fs = require('fs');
function injectDebug(file) {
    let content = fs.readFileSync(file, 'utf8');
    content = content.replace(`        if (!box) {
            console.log('[DEBUG] DUMPING ELEMENTS:');
            (observation.elements || []).forEach(e => {
                if (e.name) {
                    console.log('  Role:', e.role, 'Name:', e.name, 'Value:', e.value);
                }
            });
        }`, `        if (!box) {
            console.log('[DEBUG] DUMPING ALL ELEMENTS (INCLUDING NAMELESS):');
            (observation.elements || []).forEach(e => {
                console.log('  Role:', e.role, 'Name:', e.name, 'Value:', e.value);
            });
        }`);
    fs.writeFileSync(file, content);
}
injectDebug('/Users/adityapande/Coding/Jarvis/backend/services/webAgent.js');
