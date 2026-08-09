// One vocabulary for everything that goes wrong, across every path: routing,
// planning, the web loop, skill execution and skill generation. The classes are
// the ones observed during development, not hypothetical ones, and two of them
// (credential_boundary, mandate_blocked) are the system working as designed —
// they are kept in the taxonomy because a refusal still ends a request.

const traceStore = require('./traceStore');
const ledger = require('./generationLog');

const CLASSES = [
    'capability_gap',        // nothing installed could do it; planner said so
    'plan_invalid',          // the planner's output failed validation
    'site_drift',            // a learned recipe stopped matching its site
    'execution_error',       // a step or skill crashed doing the work
    'timeout',               // a model call or step ran out of time
    'model_unreachable',     // the inference server was down
    'credential_boundary',   // stopped at a password or payment field, by design
    'mandate_blocked',       // an action outside the user's mandate was refused
    'generation_malformed',  // the generator's response could not be used
    'generation_static',     // a generated script failed syntax or import checks
    'verification_failed',   // a generated skill failed its own test gate
    'grounding_failure',     // passed its tests but failed on the user's real data
    'internal_error'         // our own machinery broke
];

const LEDGER_MAP = {
    model_unreachable: 'model_unreachable',
    unparseable_response: 'generation_malformed',
    schema_invalid: 'generation_malformed',
    no_tests_authored: 'generation_malformed',
    script_syntax_error: 'generation_static',
    forbidden_import: 'generation_static',
    verification_failed: 'verification_failed',
    verification_timeout: 'verification_failed',
    grounded_trial_failed: 'grounding_failure',
    name_collision: 'generation_malformed',
    write_failed: 'internal_error'
};

function classifyStep({ capability = '', error = '' }) {
    const text = String(error);
    if (/timed out|timeout/i.test(text)) return 'timeout';
    if (/ECONNREFUSED|unreachable|transport_error/i.test(text)) return 'model_unreachable';
    if (/password|credential|payment|sign.?in/i.test(text)) return 'credential_boundary';
    if (/mandate|not authorised|not authorized|outside what was asked/i.test(text)) return 'mandate_blocked';
    if (/invalid plan|validation/i.test(text)) return 'plan_invalid';
    if (String(capability).startsWith('procedure.')) return 'site_drift';
    return 'execution_error';
}

function classifyGeneration(record) {
    return LEDGER_MAP[record.failure] || 'internal_error';
}

function bucket(report, name, example) {
    const entry = report.classes[name] || (report.classes[name] = { count: 0, examples: [] });
    entry.count += 1;
    report.total += 1;
    if (entry.examples.length < 3) entry.examples.push(example);
}

// Aggregates every recorded failure into the taxonomy. Reads the stores as
// they are — nothing is written, so it is safe to call from diagnostics.
function report() {
    const out = { generated_at: new Date().toISOString(), total: 0, classes: {} };

    try {
        for (const gap of traceStore.gaps(200)) {
            bucket(out, 'capability_gap',
                { ts: gap.ts, request: gap.request, error: gap.error });
        }
        for (const step of traceStore.failedSteps(500)) {
            bucket(out, classifyStep(step),
                { ts: step.ts, request: step.request, capability: step.capability, error: step.error });
        }
    } catch { }

    try {
        for (const record of ledger.read()) {
            if (record.outcome !== 'rejected') continue;
            bucket(out, classifyGeneration(record),
                { ts: record.timestamp, request: record.request, error: record.detail });
        }
    } catch { }

    return out;
}

module.exports = { CLASSES, classifyStep, classifyGeneration, report };
