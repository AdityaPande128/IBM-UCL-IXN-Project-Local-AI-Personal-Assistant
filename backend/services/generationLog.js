const fs = require('fs');
const path = require('path');

const LOG_PATH = path.resolve(__dirname, '..', 'skills', '.generation-log.json');

const STAGES = {
    REQUESTED: 'requested',
    MODEL_CALL: 'model_call',
    PARSED: 'parsed',
    STATIC_CHECK: 'static_check',
    VERIFIED: 'verified',
    REGISTERED: 'registered'
};

const FAILURES = {
    MODEL_UNREACHABLE: 'model_unreachable',
    UNPARSEABLE: 'unparseable_response',
    SCHEMA_INVALID: 'schema_invalid',
    NAME_COLLISION: 'name_collision',
    SYNTAX_ERROR: 'script_syntax_error',
    FORBIDDEN_IMPORT: 'forbidden_import',
    NO_TESTS: 'no_tests_authored',
    VERIFICATION_FAILED: 'verification_failed',
    VERIFICATION_TIMEOUT: 'verification_timeout',
    WRITE_FAILED: 'write_failed'
};

function read() {
    try {
        if (!fs.existsSync(LOG_PATH)) return [];
        return JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
    } catch (err) {
        console.warn(`[GenerationLog] Could not read ledger: ${err.message}`);
        return [];
    }
}

function append(entry) {
    const record = {
        timestamp: new Date().toISOString(),
        ...entry
    };

    try {
        const entries = read();
        entries.push(record);
        fs.writeFileSync(LOG_PATH, JSON.stringify(entries, null, 2));
    } catch (err) {
        console.warn(`[GenerationLog] Could not write ledger: ${err.message}`);
    }
    return record;
}

function summarise() {
    const entries = read();
    const byOutcome = {};
    const byFailure = {};
    const attemptCounts = [];

    for (const entry of entries) {
        byOutcome[entry.outcome] = (byOutcome[entry.outcome] || 0) + 1;
        if (entry.failure) byFailure[entry.failure] = (byFailure[entry.failure] || 0) + 1;
        if (entry.outcome === 'registered') attemptCounts.push(entry.attempts || 1);
    }

    const firstTry = attemptCounts.filter(n => n === 1).length;

    return {
        total: entries.length,
        registered: byOutcome.registered || 0,
        rejected: byOutcome.rejected || 0,
        first_try_successes: firstTry,
        retry_successes: attemptCounts.length - firstTry,
        failures_by_type: byFailure
    };
}

module.exports = { append, read, summarise, STAGES, FAILURES, LOG_PATH };
