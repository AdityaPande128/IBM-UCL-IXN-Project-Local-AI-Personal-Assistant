import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const router = require('../backend/services/router.js');

export const OpenClawCore = {
    async processIntent(prompt, skills) {
        const decision = await router.route(prompt, skills ? { skills } : {});

        return {
            intent_type:   decision.intent_type,
            confidence:    decision.confidence,
            reasoning:     decision.reasoning,
            target_skill:  decision.target_skill,
            parameters:    decision.parameters,
            schema_valid:  decision.schema_valid,
            schema_errors: decision.schema_errors,
            raw_response:  decision.raw_response,
            is_successful: decision.is_successful,

            action:        decision.action,
            attempts:      decision.attempts,
            router_latency_ms: decision.latency_ms
        };
    }
};

export const ROUTER_CONFIDENCE_THRESHOLD = router.CONFIDENCE_THRESHOLD;
