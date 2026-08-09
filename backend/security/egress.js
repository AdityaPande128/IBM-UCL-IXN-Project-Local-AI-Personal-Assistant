const labels = require('./labels');
const store = require('./store');

const DECISION = {
    ALLOW: 'allow',
    APPROVE: 'approve',
    DENY: 'deny'
};

const CHANNEL = {
    NETWORK: 'network',
    MESSAGE: 'message',
    CLIPBOARD: 'clipboard',
    FILE_WRITE: 'file-write'
};

function evaluate(label, channel = 'unknown') {
    const value = label || labels.UNKNOWN;

    if (labels.isSecret(value)) {
        return {
            decision: DECISION.DENY,
            reason: 'credential material must never be transmitted; no approval can authorise this'
        };
    }

    if (labels.atLeast(value, labels.SENSITIVITY.PERSONAL)) {
        return {
            decision: DECISION.APPROVE,
            reason: `personal data would leave by ${channel}; this needs explicit approval`
        };
    }

    return { decision: DECISION.ALLOW, reason: 'no sensitive data in this flow' };
}

function guard(flow) {
    const label = labels.join(...(flow.inputs || []));
    const { decision, reason } = (flow.policy || evaluate)(label, flow.channel);

    let approvalId = null;
    if (decision === DECISION.APPROVE) {
        approvalId = store.requestApproval({
            channel: flow.channel,
            action: flow.action,
            label,
            destination: flow.destination,
            summary: flow.summary || `${flow.action} to ${flow.destination || 'an external destination'}`,
            preview: flow.preview
        });
    }

    const auditId = store.recordDecision({
        channel: flow.channel,
        action: flow.action,
        decision,
        label,
        destination: flow.destination,
        summary: flow.summary,
        detail: { reason, inputs: (flow.inputs || []).length },
        approvalId
    });

    return {
        decision,
        reason,
        label,
        auditId,
        approvalId,
        allowed: decision === DECISION.ALLOW
    };
}

function resolve(approvalId, granted) {
    const request = store.getApproval(approvalId);
    if (!request) {
        return { allowed: false, reason: 'no such approval' };
    }

    const changed = store.resolveApproval(approvalId, granted);
    if (!changed) {
        store.recordDecision({
            channel: request.channel,
            action: request.action,
            decision: DECISION.DENY,
            label: request.label,
            destination: request.destination,
            summary: request.summary,
            detail: { reason: 'approval already resolved; authorisation is single-use' },
            approvalId
        });
        return { allowed: false, reason: 'this approval has already been used' };
    }

    store.recordDecision({
        channel: request.channel,
        action: request.action,
        decision: granted ? DECISION.ALLOW : DECISION.DENY,
        label: request.label,
        destination: request.destination,
        summary: request.summary,
        detail: { reason: granted ? 'approved by the user' : 'declined by the user' },
        approvalId
    });

    return {
        allowed: Boolean(granted),
        reason: granted ? 'approved by the user' : 'declined by the user'
    };
}

function partitionContext(instruction, passages = []) {
    const trusted = [];
    const untrusted = [];

    for (const passage of passages) {
        const label = passage.label || labels.UNKNOWN;
        (labels.isInstructionSafe(label) ? trusted : untrusted).push({
            ...passage,
            label,
            origin: labels.describe(label)
        });
    }

    return {
        instruction,
        trusted,
        untrusted,
        label: labels.join(...passages.map(p => p.label || labels.UNKNOWN)),
        hasUntrusted: untrusted.length > 0
    };
}

module.exports = {
    DECISION,
    CHANNEL,
    evaluate,
    guard,
    resolve,
    partitionContext
};
