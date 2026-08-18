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
const conversationStore = require('./services/conversationStore');
const traceStore = require('./services/traceStore');
const skillRegistry = require('./services/skillRegistry');
const skillPins = require('./services/skillPins');
const skillExporter = require('./services/skillExporter');
const procedureStore = require('./services/procedureStore');
const generationLog = require('./services/generationLog');
const webAgent = require('./services/webAgent');
const diagnostics = require('./services/diagnostics');
const settings = require('./services/settings');
const modelTiers = require('./services/modelTiers');
const availability = require('./services/availability');
const watchers = require('./services/watchers');
const morningBrief = require('./services/morningBrief');
const channelAdapter = require('./services/channelAdapter');
const memoryStore = require('./services/memoryStore');
const memoryService = require('./services/memoryService');
const wakeWord = require('./services/wakeWord');
const distiller = require('./services/distiller');
const configReader = require('./utils/configReader');
const auditView = require('./services/auditView');
const permissionsView = require('./services/permissionsView');
const checkpoints = require('./services/checkpoints');
const stateBundle = require('./services/stateBundle');
const profile = require('./services/profile');
const modelCatalog = require('./services/modelCatalog');
const modelDownloads = require('./services/modelDownloads');

verifySandboxInitialized();

// A staged checkpoint restore is applied before anything reads the stores —
// or the config, which the restore may also have replaced.
checkpoints.applyPending();

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

function voiceReady() {
    const chosen = profile.current();
    if (!chosen.voice.enabled) return false;
    const voice = (configReader.readConfig().models || {}).voice || {};
    if (!voice.stt || !modelCatalog.downloaded(voice.stt.model)) return false;
    if (chosen.voice.tts && voice.tts && !modelCatalog.downloaded(voice.tts.model)) return false;
    return true;
}

// One atomic act: the profile, the tier table and the download queue are all
// written before the restart, so whichever daemon wakes up next finds a
// consistent picture and simply starts downloading.
function applyOnboarding(parsed) {
    const current = configReader.readConfig();
    const improvement = parsed.improvement === true;
    const selection = {
        engine: String(parsed.engine || ''),
        smith: improvement ? String(parsed.smith || '') : null,
        voice: !!(parsed.voice && parsed.voice.enabled),
        tts: !!(parsed.voice && parsed.voice.tts)
    };

    const checked = modelCatalog.checkSelection(current, selection);
    if (!checked.ok) return { status: 'invalid', error: checked.error };

    const applied = profile.apply({
        name: parsed.name,
        theme: parsed.theme,
        mode: parsed.mode,
        improvement,
        voice: { enabled: selection.voice, tts: selection.tts }
    });
    if (applied.status !== 'applied') return applied;

    const cfg = configReader.readConfig();
    // Without improvement no smith was chosen, but the tier keeps a value —
    // the class default — so enabling improvement later starts from a sane
    // table. Generation is gated on the profile, not on the tier's absence.
    const defaults = modelTiers.effective({
        models: { hardware_defaults: (cfg.models || {}).hardware_defaults }
    });
    const smith = selection.smith || (defaults.smith && defaults.smith.model) || null;
    cfg.models = cfg.models || {};
    cfg.models.tiers = modelCatalog.tiersFor({ engine: selection.engine, smith });
    fs.writeFileSync(configReader.configPath(), JSON.stringify(cfg, null, 2) + '\n');

    const voiceModels = (cfg.models || {}).voice || {};
    const items = [{ model: selection.engine, kind: 'engine' }];
    if (selection.voice && voiceModels.stt) {
        items.push({ model: voiceModels.stt.model, kind: 'voice' });
        if (selection.tts && voiceModels.tts) {
            items.push({ model: voiceModels.tts.model, kind: 'voice' });
        }
    }
    if (improvement && selection.smith) {
        items.push({ model: selection.smith, kind: 'smith' });
    }
    modelDownloads.manager.enqueue(items, { defer: true });

    return { status: 'applied', restarting: true };
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

            if (parsed.type === 'channel_status') {
                ws.send(JSON.stringify({ type: 'channel_status_result',
                    ...channelSnapshot() }));
                return;
            }

            if (parsed.type === 'channel_set_token' && typeof parsed.token === 'string') {
                const secret = parsed.token.trim();
                if (!/^\d+:[\w-]{20,}$/.test(secret)) {
                    ws.send(JSON.stringify({ type: 'channel_status_result',
                        error: 'That does not look like a Telegram bot token — it '
                            + 'comes from @BotFather and looks like 1234567:AA…',
                        ...channelSnapshot() }));
                    return;
                }
                channelAdapter.stop();
                fs.writeFileSync(channelAdapter.TOKEN_PATH, secret + '\n', { mode: 0o600 });
                channelAdapter.start(channelDeps());
                ws.send(JSON.stringify({ type: 'channel_status_result',
                    ...channelSnapshot() }));
                return;
            }

            if (parsed.type === 'channel_clear') {
                channelAdapter.stop();
                channelAdapter.unpair();
                try { fs.unlinkSync(channelAdapter.TOKEN_PATH); } catch { }
                ws.send(JSON.stringify({ type: 'channel_status_result',
                    ...channelSnapshot() }));
                return;
            }

            if (parsed.type === 'conversations_list') {
                ws.send(JSON.stringify({ type: 'conversations_result',
                    conversations: conversationStore.list() }));
                return;
            }

            if (parsed.type === 'conversation_select') {
                const wanted = parsed.id == null ? null : Number(parsed.id);
                const id = wanted !== null && conversationStore.exists(wanted) ? wanted : null;
                ws.conversationId = id;
                ws.send(JSON.stringify({ type: 'conversation_messages', id,
                    messages: id === null ? [] : conversationStore.messages(id) }));
                return;
            }

            if (parsed.type === 'conversation_delete' && parsed.id) {
                const id = Number(parsed.id);
                const removed = conversationStore.remove(id);
                if (ws.conversationId === id) ws.conversationId = null;
                ws.send(JSON.stringify({ type: 'conversation_delete_result', id, removed,
                    conversations: conversationStore.list() }));
                return;
            }

            if (parsed.type === 'intent' && parsed.text) {
                // The executor follows the profile's mode at the moment the
                // intent arrives, so switching modes never needs a restart.
                const mode = profile.current().mode;
                const job = intentQueue.submit(({ signal }) =>
                    withActivity(ws, () =>
                        openclawBridge.executeIntent(parsed.text, {
                            interactive: true, signal,
                            ...(mode === 'openclaw' ? { executor: 'openclaw' } : {})
                        })));
                ws.send(JSON.stringify({ type: 'intent_accepted', id: job.id, position: job.position }));
                const started = conversationStore.append(ws, 'user', parsed.text);
                if (started) ws.send(JSON.stringify({ type: 'conversation_started', ...started }));

                const result = await job.result;
                ws.send(JSON.stringify({ type: 'intent_result', id: job.id, ...result }));
                conversationStore.append(ws, result.status === 'error' ? 'error' : 'assistant',
                    result.response ?? result.error ?? 'No response.', result.artifacts);

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
                const tiers = modelTiers.effective(config);
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
                    // A newly chosen model may not be on disk yet; queue it
                    // for the daemon that comes back after the restart.
                    if (parsed.tiers) {
                        const wanted = Object.values(parsed.tiers)
                            .map(spec => spec && spec.model)
                            .filter(model => model && !modelCatalog.downloaded(model))
                            .map(model => ({ model, kind: 'model' }));
                        if (wanted.length) {
                            modelDownloads.manager.enqueue(wanted, { defer: true });
                        }
                    }
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

            if (parsed.type === 'skill_export' && parsed.name) {
                const pack = skillExporter.exportPack(parsed.name);
                const wrapper = pack.status === 'exported'
                    ? skillExporter.exportWrapper(parsed.name)
                    : null;
                if (pack.status === 'exported') {
                    activityBus.publish('registry', 'skill_exported', { skill: pack.name });
                }
                ws.send(JSON.stringify({ type: 'skill_export_result',
                    ...pack, wrapper: wrapper && wrapper.path }));
                return;
            }

            if (parsed.type === 'skill_import' && parsed.path) {
                const result = await skillExporter.importPack(parsed.path);
                if (result.status === 'installed') {
                    activityBus.publish('registry', 'skill_imported', { skill: result.name });
                }
                ws.send(JSON.stringify({ type: 'skill_import_result', ...result }));
                return;
            }

            if (parsed.type === 'audit') {
                ws.send(JSON.stringify({ type: 'audit_result',
                    ...auditView.digest(parsed.since) }));
                return;
            }

            if (parsed.type === 'permissions') {
                ws.send(JSON.stringify({ type: 'permissions_result',
                    ...permissionsView.snapshot(config) }));
                return;
            }

            if (parsed.type === 'checkpoint') {
                if (parsed.action === 'create') {
                    try {
                        const created = checkpoints.create('manual');
                        checkpoints.prune((config.checkpoints || {}).keep ?? 5);
                        activityBus.publish('daemon', 'checkpoint_created', { name: created.name });
                        ws.send(JSON.stringify({ type: 'checkpoint_result',
                            status: 'created', ...created, checkpoints: checkpoints.list() }));
                    } catch (err) {
                        ws.send(JSON.stringify({ type: 'checkpoint_result',
                            status: 'refused', reason: err.message }));
                    }
                    return;
                }
                if (parsed.action === 'restore' && parsed.name) {
                    const staged = checkpoints.restore(parsed.name);
                    ws.send(JSON.stringify({ type: 'checkpoint_result', ...staged }));
                    if (staged.status === 'staged'
                        && process.env.JARVIS_SETTINGS_RESTART !== 'off') {
                        setTimeout(() => process.exit(0), 400);
                    }
                    return;
                }
                ws.send(JSON.stringify({ type: 'checkpoint_result',
                    status: 'listed', checkpoints: checkpoints.list() }));
                return;
            }

            if (parsed.type === 'bundle_export') {
                try {
                    const bundle = stateBundle.exportBundle();
                    activityBus.publish('daemon', 'bundle_exported', { path: bundle.path });
                    ws.send(JSON.stringify({ type: 'bundle_export_result', ...bundle }));
                } catch (err) {
                    ws.send(JSON.stringify({ type: 'bundle_export_result',
                        status: 'error', reason: err.message }));
                }
                return;
            }

            if (parsed.type === 'bundle_import' && parsed.path) {
                let staged;
                try {
                    staged = stateBundle.importBundle(parsed.path);
                } catch (err) {
                    staged = { status: 'refused', reason: err.message };
                }
                ws.send(JSON.stringify({ type: 'bundle_import_result', ...staged }));
                if (staged.status === 'staged'
                    && process.env.JARVIS_SETTINGS_RESTART !== 'off') {
                    setTimeout(() => process.exit(0), 400);
                }
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

            if (parsed.type === 'onboarding') {
                const current = configReader.readConfig();
                ws.send(JSON.stringify({
                    type: 'onboarding_result',
                    profile: profile.read(current),
                    catalog: modelCatalog.describe(current),
                    downloads: modelDownloads.manager.status(),
                    voice_ready: voiceReady()
                }));
                return;
            }

            if (parsed.type === 'onboarding_apply') {
                const result = applyOnboarding(parsed);
                ws.send(JSON.stringify({ type: 'onboarding_apply_result', ...result }));
                if (result.status === 'applied'
                    && process.env.JARVIS_SETTINGS_RESTART !== 'off') {
                    // The restart reloads the tier table everywhere; the
                    // download queue was persisted and resumes on boot.
                    setTimeout(() => process.exit(0), 400);
                }
                return;
            }

            if (parsed.type === 'onboarding_complete') {
                const applied = profile.apply({ onboarded: true });
                activityBus.publish('daemon', 'onboarded', {});
                ws.send(JSON.stringify({ type: 'onboarding_complete_result', ...applied }));
                return;
            }

            if (parsed.type === 'profile_update') {
                const applied = profile.apply({
                    name: parsed.name,
                    mode: parsed.mode,
                    theme: parsed.theme,
                    improvement: parsed.improvement,
                    voice: parsed.voice
                });
                if (applied.status === 'applied') {
                    activityBus.publish('daemon', 'profile_updated', {});
                }
                ws.send(JSON.stringify({ type: 'profile_update_result', ...applied }));
                return;
            }

            if (parsed.type === 'download') {
                if (parsed.action === 'stop' && parsed.model) {
                    modelDownloads.manager.stop(String(parsed.model));
                }
                if (parsed.action === 'start' && parsed.model) {
                    const model = String(parsed.model);
                    const known = modelDownloads.manager.status().queue
                        .some(job => job.model === model);
                    // Starting a model the queue has never seen enqueues it —
                    // how settings kick off a download for a late choice.
                    if (known) modelDownloads.manager.start(model);
                    else modelDownloads.manager.enqueue([{ model, kind: 'model' }]);
                }
                ws.send(JSON.stringify({
                    type: 'download_status',
                    ...modelDownloads.manager.status(),
                    voice_ready: voiceReady()
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

// The pairing code is minted only while the channel runs unpaired, so the
// settings pane can show it without ever inventing one for a dead channel.
function channelSnapshot() {
    const state = channelAdapter.status();
    return {
        ...state,
        pairing_code: state.running && !state.paired
            ? channelAdapter.currentPairingCode() : null
    };
}

function channelDeps() {
    return {
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
    };
}

async function boot() {
    syncOpenClawConfig();

    modelDownloads.manager.subscribe(job =>
        broadcast({ type: 'download_progress', job }));
    modelDownloads.manager.resume();

    try {
        const interrupted = traceStore.reconcileInterrupted();
        if (interrupted) {
            console.log(`[Jarvis] Marked ${interrupted} plan(s) interrupted by the previous shutdown.`);
        }
    } catch (err) {
        console.warn(`[Jarvis] Startup reconciliation failed: ${err.message}`);
    }

    // Checkpointed store snapshots: one on a schedule, pruned to a budget.
    const checkpointSettings = config.checkpoints || {};
    if (checkpointSettings.enabled !== false) {
        const intervalMs = (checkpointSettings.interval_hours ?? 24) * 60 * 60 * 1000;
        const keep = checkpointSettings.keep ?? 5;
        const takeCheckpoint = () => {
            try {
                const created = checkpoints.create('scheduled');
                const pruned = checkpoints.prune(keep);
                activityBus.publish('daemon', 'checkpoint_created',
                    { name: created.name, pruned: pruned.length });
            } catch (err) {
                console.warn(`[Jarvis] Scheduled checkpoint failed: ${err.message}`);
            }
        };
        const newest = checkpoints.list()
            .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
            .at(-1);
        if (!newest || Date.now() - Date.parse(newest.createdAt) > intervalMs) {
            takeCheckpoint();
        }
        setInterval(takeCheckpoint, intervalMs).unref();
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
        channelAdapter.start(channelDeps());
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
