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
                    }
                }));
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

    await openclawBridge.initialize();

    server.listen(PORT, '127.0.0.1', () => {
        console.log(`[Jarvis] Backend daemon running on ws://localhost:${PORT}`);
        console.log(`[Jarvis] OpenClaw gateway: ${openclawBridge.isConnected() ? 'CONNECTED' : 'OFFLINE (standalone mode)'}`);
    });
}

boot();

module.exports = { server };
