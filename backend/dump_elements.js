const fs = require('fs');
function injectDebug(file) {
    let content = fs.readFileSync(file, 'utf8');
    content = content.replace('console.log(\'[DEBUG] Starting checkFill with box:\', !!box);', `
        if (!box) {
            console.log('[DEBUG] DUMPING ELEMENTS:');
            (observation.elements || []).forEach(e => {
                if (e.name) {
                    console.log('  Role:', e.role, 'Name:', e.name, 'Value:', e.value);
                }
            });
        }
        console.log('[DEBUG] Starting checkFill with box:', !!box);
    `);
    fs.writeFileSync(file, content);
}
injectDebug('/Users/adityapande/Coding/Jarvis/backend/services/webAgent.js');
