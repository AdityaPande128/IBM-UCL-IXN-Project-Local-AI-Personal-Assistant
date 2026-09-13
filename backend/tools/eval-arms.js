// The evaluation arms, one table for eval-arm.js (which writes them) and
// eval-run.js (which refuses to run under anything else). Arm C is the
// configuration the study chose on 2026-09-06; C0 is the as-built arm the
// 2026-09-01 revision recorded, kept so its rows stay attributable.
const FOUR_B = 'mlx-community/Qwen3-4B-Instruct-2507-4bit';
const GEMMA = 'mlx-community/gemma-4-E4B-it-qat-4bit';
const SMITH = 'mlx-community/Qwen2.5-Coder-14B-Instruct-4bit';

const ARMS = {
    P: {
        guard: { model: FOUR_B, policy: 'resident' },
        engine: { model: FOUR_B, policy: 'resident' },
        smith: { model: FOUR_B, policy: 'resident' },
    },
    C: {
        guard: { model: GEMMA, policy: 'resident' },
        engine: { model: GEMMA, policy: 'resident' },
        smith: { model: SMITH, policy: 'transient' },
    },
    C0: {
        guard: { model: FOUR_B, policy: 'resident' },
        engine: { model: FOUR_B, policy: 'resident' },
        smith: { model: SMITH, policy: 'transient' },
    },
};

// What the live inference server says it is serving, compared tier by tier
// with the arm; the state file records intent, /health records fact.
async function healthMismatch(arm, base = 'http://127.0.0.1:8787') {
    const expected = ARMS[arm];
    if (!expected) return [`unknown arm "${arm}"`];
    let health;
    try {
        const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
        health = await res.json();
    } catch (err) {
        return [`inference server not reachable at ${base}: ${err.message}`];
    }
    const tiers = (health.llm && health.llm.tiers) || {};
    const problems = [];
    for (const [tier, spec] of Object.entries(expected)) {
        if (tiers[tier] !== spec.model) {
            problems.push(`${tier}: server serves ${tiers[tier] || 'nothing'}, arm ${arm} needs ${spec.model}`);
        }
    }
    return problems;
}

module.exports = { ARMS, healthMismatch, FOUR_B, GEMMA, SMITH };
