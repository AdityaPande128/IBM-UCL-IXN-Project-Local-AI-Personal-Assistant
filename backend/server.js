const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { verifySandboxInitialized } = require('./middleware/pathValidator');
const { safeReaddir } = require('./utils/safeFs');
const openclawBridge = require('./services/openclawBridge');
const activityBus = require('./services/activityBus');
const aiPipeline = require('./services/aiPipeline');
const socketAuth = require('./services/socketAuth');
const intentQueue = require('./services/intentQueue');
const traceStore = require('./services/traceStore');
const skillRegistry = require('./services/skillRegistry');
const skillPins = require('./services/skillPins');
const procedureStore = require('./services/procedureStore');
const generationLog = require('./services/generationLog');
const webAgent = require('./services/webAgent');
const diagnostics = require('./services/diagnostics');
const settings = require('./services/settings');
const availability = require('./services/availability');
const watchers = require('./services/watchers');
const morningBrief = require('./services/morningBrief');
const channelAdapter = require('./services/channelAdapter');
const memoryStore = require('./services/memoryStore');
const memoryService = require('./services/memoryService');
const wakeWord = require('./services/wakeWord');
const distiller = require('./services/distiller');
const configReader = require('./utils/configReader');

verifySandboxInitialized();

const config = configReader.readConfig();
const PORT = process.env.PORT || config.ports.backend;
const SOCKET_TOKEN = socketAuth.issue(
    process.env.JARVIS_SOCKET_TOKEN_PATH
    || (config.security && config.security.socket_token_path));
const AUTH_GRACE_MS = 5000;

function syncOpenClawConfig() {
    const openclawPath = path.resolve(__dirname, './openclaw.json');
    try {
        let openclawConfig = {};
        if (fs.existsSync(openclawPath)) {
            openclawConfig = JSON.parse(fs.readFileSync(openclawPath, 'utf8'));
        }
        
        if (!openclawConfig.agents) openclawConfig.agents = {};
        if (!openclawConfig.agents.defaults) openclawConfig.agents.defaults = {};
        if (!openclawConfig.agents.defaults.model) openclawConfig.agents.defaults.model = {};
        
        const openclawModel = (config.generation && config.generation.model)
            || (config.router && config.router.model)
            || config.model_id;

        openclawConfig.agents.defaults.model.provider = "custom";
        openclawConfig.agents.defaults.model.modelId = openclawModel;
        openclawConfig.agents.defaults.model.baseUrl = `http://127.0.0.1:${config.ports.inference}/v1`;

        // The phone channel belongs to Jarvis: a bot token has exactly one
        // getUpdates consumer, so OpenClaw must never open its own Telegram
        // channel — phone messages reach it through the bridge instead.
        if (!openclawConfig.channels) openclawConfig.channels = {};
        openclawConfig.channels.telegram = {
            ...(openclawConfig.channels.telegram || {}),
            enabled: false,
            managedBy: "jarvis"
        };

        fs.writeFileSync(openclawPath, JSON.stringify(openclawConfig, null, 2), 'utf8');
        console.log(`[Jarvis Boot] Synchronized openclaw.json with model: ${openclawModel} and inference port: ${config.ports.inference}`);
    } catch (e) {
        console.error("[Jarvis Boot] Failed to synchronize openclaw.json:", e);
    }
}

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Personal Jarvis Backend Daemon Running.\n');
});

const MAX_FRAME_BYTES = (config.limits && config.limits.max_frame_bytes) || 32 * 1024 * 1024;
const wss = new WebSocket.Server({ server, maxPayload: MAX_FRAME_BYTES });

const clients = new Set();

async function withActivity(ws, work) {
    const unsubscribe = activityBus.subscribe(event => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'activity', ...event }));
        }
    });
    try {
        return await work();
    } finally {
        unsubscribe();
    }
}

function broadcast(data, excludeWs) {
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    for (const client of clients) {
        if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    }
}

wss.on('connection', (ws) => {
    let authenticated = false;
    const authTimer = setTimeout(() => {
        if (!authenticated) ws.close(4401, 'authentication timeout');
    }, AUTH_GRACE_MS);

    ws.on('message', async (message, isBinary) => {
        if (!authenticated) {
            let hello = null;
            if (!isBinary) {
                try { hello = JSON.parse(message.toString()); } catch { hello = null; }
            }
            if (hello && hello.type === 'auth' && socketAuth.verify(SOCKET_TOKEN, hello.token)) {
                authenticated = true;
                clearTimeout(authTimer);
                clients.add(ws);
                ws.send(JSON.stringify({
                    type: 'connected',
                    message: 'Welcome to Jarvis Backend Daemon',
                    openclaw: openclawBridge.isConnected()
                }));
            } else {
                ws.close(4401, 'unauthenticated');
            }
            return;
        }

        if (isBinary) {
            if (ws.wakeMode) {
                // Idle speech dies here: no reply, no record, no transcript.
                const probed = await wakeWord.probe(message);
                if (!probed.wake) return;
                ws.send(JSON.stringify({ type: 'wake', command: probed.command }));
                if (probed.command) {
                    await withActivity(ws, () => aiPipeline.respondTo(probed.command, ws));
                }
                return;
            }
            await aiPipeline.handleIncomingAudio(message, ws);
            return;
        }

        const textMsg = message.toString();

        try {
            const parsed = JSON.parse(textMsg);

            if (parsed.type === 'file_explore' && parsed.targetPath) {
                try {
                    const files = await safeReaddir(parsed.targetPath);
                    ws.send(JSON.stringify({ type: 'file_explore_result', status: 'success', files }));
                } catch (err) {
                    ws.send(JSON.stringify({ type: 'file_explore_result', status: 'error', error: err.message }));
                }
                return;
            }

            if (parsed.type === 'intent' && parsed.text) {
                const job = intentQueue.submit(({ signal }) =>
                    withActivity(ws, () =>
                        openclawBridge.executeIntent(parsed.text, { interactive: true, signal })));
                ws.send(JSON.stringify({ type: 'intent_accepted', id: job.id, position: job.position }));

                const result = await job.result;
                ws.send(JSON.stringify({ type: 'intent_result', id: job.id, ...result }));

                broadcast({ type: 'state_sync', skill: result.skill || null,
                            status: result.status }, ws);

                // Inference never writes memory: anything durable it spots in
                // this exchange becomes a consent card, not a row.
                if (result.status === 'success') {
                    memoryService.inferFrom(
                        `user: ${parsed.text}\nassistant: ${result.response || ''}`)
                        .catch(() => null);
                }
                return;
            }

            // The browser lane alone, without Jarvis's router or planner: another
            // agent (the evaluation runs OpenClaw this way) brings its own loop
            // and borrows only the execution surface. Same token, same queue,
            // same web policy — only the planning brain is the caller's.
            if (parsed.type === 'browse' && parsed.goal) {
                const job = intentQueue.submit(() =>
                    withActivity(ws, () =>
                        webAgent.browse(String(parsed.goal),
                            parsed.url ? { url: String(parsed.url) } : {})));
                ws.send(JSON.stringify({ type: 'browse_accepted', id: job.id }));

                const result = await job.result;
                ws.send(JSON.stringify({
                    type: 'browse_result', id: job.id,
                    status: result.status,
                    answer: result.answer ?? null,
                    url: result.url ?? null,
                    ...(result.reason ? { reason: result.reason } : {})
                }));
                return;
            }

            if (parsed.type === 'approval' && parsed.id) {
                const job = intentQueue.submit(({ signal }) =>
                    withActivity(ws, () =>
                        openclawBridge.answerProposal(parsed.id,
                            parsed.decision === 'yes' ? 'yes' : 'no', { signal })));
                const result = await job.result;
                ws.send(JSON.stringify({ type: 'intent_result', id: job.id, ...result }));
                return;
            }

            if (parsed.type === 'abort') {
                ws.send(JSON.stringify({ type: 'abort_result', ...intentQueue.abort(parsed.id) }));
                return;
            }

            if (parsed.type === 'abilities') {
                const tiers = (config.models && config.models.tiers) || {};
                ws.send(JSON.stringify({
                    type: 'abilities_result',
                    skills: skillRegistry.list().map(s => ({
                        name: s.name,
                        version: s.version,
                        description: s.description,
                        author: (s.provenance && s.provenance.author) || 'unknown',
                        capabilities: s.capabilities
                    })),
                    rejected: skillRegistry.errors(),
                    recipes: procedureStore.list().map(p => ({
                        name: p.name,
                        description: p.description || p.goal || '',
                        steps: Array.isArray(p.steps) ? p.steps.length : null
                    })),
                    builds: generationLog.read().slice(-50).reverse(),
                    tiers: Object.entries(tiers).map(([tier, spec]) => ({
                        tier, model: spec.model, policy: spec.policy
                    })),
                    openclaw: {
                        connected: openclawBridge.isConnected(),
                        dashboard: `http://127.0.0.1:${config.ports.openclaw}`
                    },
                    ...settings.describe(config)
                }));
                return;
            }

            if (parsed.type === 'settings_update') {
                const result = settings.apply({
                    tiers: parsed.tiers,
                    desktop_browser: parsed.desktop_browser,
                    mail_provider: parsed.mail_provider
                });
                if (result.status === 'applied') {
                    activityBus.publish('daemon', 'settings_applied', {});
                    ws.send(JSON.stringify({ type: 'settings_update_result',
                        status: 'applied', restarting: true }));
                    if (process.env.JARVIS_SETTINGS_RESTART !== 'off') {
                        setTimeout(() => process.exit(0), 400);
                    }
                } else {
                    ws.send(JSON.stringify({ type: 'settings_update_result', ...result }));
                }
                return;
            }

            if (parsed.type === 'skill_remove' && parsed.name) {
                const skill = skillRegistry.get(parsed.name);
                if (!skill) {
                    ws.send(JSON.stringify({ type: 'skill_remove_result',
                        status: 'unknown_skill', name: parsed.name }));
                    return;
                }
                if (!skill.provenance || skill.provenance.author !== 'generated') {
                    ws.send(JSON.stringify({ type: 'skill_remove_result', status: 'refused',
                        name: skill.name, response: 'Built-in skills cannot be removed.' }));
                    return;
                }
                fs.rmSync(skill.directory, { recursive: true, force: true });
                skillPins.remove(skill.name);
                skillRegistry.reload();
                activityBus.publish('registry', 'skill_removed', { skill: skill.name });
                ws.send(JSON.stringify({ type: 'skill_remove_result',
                    status: 'removed', name: skill.name }));
                return;
            }

            if (parsed.type === 'diagnostics') {
                try {
                    const bundle = diagnostics.collect(config);
                    activityBus.publish('daemon', 'diagnostics_saved', { path: bundle.path });
                    ws.send(JSON.stringify({ type: 'diagnostics_result',
                        status: 'saved', path: bundle.path }));
                } catch (err) {
                    ws.send(JSON.stringify({ type: 'diagnostics_result',
                        status: 'error', error: err.message }));
                }
                return;
            }

            if (parsed.type === 'watchers') {
                ws.send(JSON.stringify({
                    type: 'watchers_result',
                    watchers: watchers.list(),
                    notices: watchers.notices({ unseenOnly: false, limit: 50 })
                }));
                return;
            }

            if (parsed.type === 'watcher_add' && parsed.target) {
                try {
                    const watcher = watchers.add({
                        name: parsed.name,
                        target: parsed.target,
                        args: parsed.args || {},
                        intervalMinutes: parsed.interval_minutes
                    });
                    activityBus.publish('watchers', 'watcher_added', { name: watcher.name });
                    ws.send(JSON.stringify({ type: 'watcher_add_result',
                        status: 'added', watcher }));
                } catch (err) {
                    ws.send(JSON.stringify({ type: 'watcher_add_result',
                        status: 'refused', response: err.message }));
                }
                return;
            }

            if (parsed.type === 'watcher_remove' && parsed.id) {
                ws.send(JSON.stringify({
                    type: 'watcher_remove_result',
                    status: watchers.remove(parsed.id) ? 'removed' : 'unknown_watcher',
                    id: parsed.id
                }));
                return;
            }

            if (parsed.type === 'notices_seen' && Array.isArray(parsed.ids)) {
                ws.send(JSON.stringify({
                    type: 'notices_seen_result',
                    marked: watchers.markSeen(parsed.ids)
                }));
                return;
            }

            if (parsed.type === 'wake_mode') {
                ws.wakeMode = parsed.on === true;
                ws.send(JSON.stringify({ type: 'wake_mode_result', on: ws.wakeMode }));
                return;
            }

            if (parsed.type === 'memory') {
                ws.send(JSON.stringify({
                    type: 'memory_result',
                    facts: memoryStore.list({ status: parsed.status || 'active' }),
                    ...memoryService.status()
                }));
                return;
            }

            if (parsed.type === 'memory_add' && parsed.text) {
                try {
                    const fact = await memoryService.add(String(parsed.text));
                    ws.send(JSON.stringify({ type: 'memory_add_result',
                        status: 'remembered', fact }));
                } catch (err) {
                    ws.send(JSON.stringify({ type: 'memory_add_result',
                        status: 'refused', response: err.message }));
                }
                return;
            }

            if (parsed.type === 'memory_remove' && Array.isArray(parsed.ids)) {
                ws.send(JSON.stringify({
                    type: 'memory_remove_result',
                    removed: memoryStore.hardDelete(parsed.ids)
                }));
                return;
            }

            if (parsed.type === 'memory_pin' && parsed.id) {
                ws.send(JSON.stringify({
                    type: 'memory_pin_result',
                    fact: memoryStore.setPinned(parsed.id, parsed.pinned !== false)
                }));
                return;
            }

            if (parsed.type === 'memory_wipe' && parsed.term) {
                ws.send(JSON.stringify({
                    type: 'memory_wipe_result',
                    term: parsed.term,
                    candidates: memoryStore.wipeCandidates(parsed.term)
                }));
                return;
            }

            if (parsed.type === 'memory_wipe_all') {
                if (parsed.confirm !== true) {
                    ws.send(JSON.stringify({ type: 'memory_wipe_all_result',
                        status: 'refused', response: 'A full wipe needs confirm: true.' }));
                    return;
                }
                ws.send(JSON.stringify({ type: 'memory_wipe_all_result',
                    status: 'wiped', removed: memoryStore.wipeAll() }));
                return;
            }

            if (parsed.type === 'incognito') {
                ws.send(JSON.stringify({
                    type: 'incognito_result',
                    ...memoryService.setIncognito(parsed.on !== false)
                }));
                return;
            }

            if (parsed.type === 'brief') {
                const brief = morningBrief.assemble({
                    browse: goal => intentQueue.submit(() =>
                        webAgent.browse(String(goal))).result
                });
                ws.send(JSON.stringify({ type: 'brief_result', ...brief }));
                return;
            }

            if (parsed.type === 'status') {
                ws.send(JSON.stringify({
                    type: 'status_result',
                    openclaw: openclawBridge.isConnected(),
                    clients: clients.size
                }));
                return;
            }

        } catch (err) {
            console.error(`[Jarvis] Message handling failed: ${err.message}`);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'error', error: err.message }));
            }
        }
    });

    ws.on('close', () => {
        clearTimeout(authTimer);
        clients.delete(ws);
    });

    ws.on('error', (error) => {
        console.error(error);
    });
});

async function boot() {
    syncOpenClawConfig();

    try {
        const interrupted = traceStore.reconcileInterrupted();
        if (interrupted) {
            console.log(`[Jarvis] Marked ${interrupted} plan(s) interrupted by the previous shutdown.`);
        }
    } catch (err) {
        console.warn(`[Jarvis] Startup reconciliation failed: ${err.message}`);
    }

    try {
        const held = availability.start();
        if (held.holding) console.log('[Jarvis] Stay-awake assertion held (releases itself on battery).');
        watchers.start();
        memoryService.start();
        distiller.start();
        morningBrief.start({
            browse: goal => intentQueue.submit(() => webAgent.browse(String(goal))).result
        });
        channelAdapter.start({
            execute: text => intentQueue.submit(({ signal }) =>
                openclawBridge.executeIntent(String(text), { interactive: true, signal })).result,
            answer: (id, decision) =>
                openclawBridge.answerProposal(id, decision === 'yes' ? 'yes' : 'no'),
            transcribe: async filePath => {
                const audio = await channelAdapter.downloadFile(filePath);
                return audio ? aiPipeline.transcribeAudio(audio) : null;
            },
            speak: async (chatId, text) => {
                const wav = await aiPipeline.synthesizeChunk(aiPipeline.speakableSummary(text), 0);
                if (wav) await channelAdapter.sendVoiceNote(chatId, wav);
            }
        });
    } catch (err) {
        console.warn(`[Jarvis] Availability startup failed: ${err.message}`);
    }

    await openclawBridge.initialize();

    server.listen(PORT, '127.0.0.1', () => {
        console.log(`[Jarvis] Backend daemon running on ws://localhost:${PORT}`);
        console.log(`[Jarvis] OpenClaw gateway: ${openclawBridge.isConnected() ? 'CONNECTED' : 'OFFLINE (standalone mode)'}`);
    });
}

boot();

module.exports = { server };
