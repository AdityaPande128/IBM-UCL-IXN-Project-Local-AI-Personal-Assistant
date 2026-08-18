import type { Proposal } from "../hooks/useWebSocket";

interface ApprovalCardProps {
  proposal: Proposal;
  onDecision: (id: string, decision: "yes" | "no") => void;
}

const KIND_LABELS: Record<string, string> = {
  build_skill: "Build a skill",
  delegate: "Delegate",
};

export function ApprovalCard({ proposal, onDecision }: ApprovalCardProps) {
  const reason = proposal.missing ?? proposal.why;

  return (
    <div className="approval-card">
      <div className="approval-card-header">
        <span className="approval-card-title">Approval required</span>
        <span className="approval-card-kind">
          {KIND_LABELS[proposal.kind] ?? "Approve this action"}
        </span>
      </div>

      {proposal.request && (
        <div className="approval-card-request">“{proposal.request}”</div>
      )}

      {reason && (
        <div className="approval-card-row">
          <span className="approval-card-key">Why</span>
          <span className="approval-card-value">{reason}</span>
        </div>
      )}

      {proposal.will && (
        <div className="approval-card-row">
          <span className="approval-card-key">Will</span>
          <span className="approval-card-value">{proposal.will}</span>
        </div>
      )}

      {proposal.estimate && (
        <div className="approval-card-row">
          <span className="approval-card-key">Takes</span>
          <span className="approval-card-value">{proposal.estimate}</span>
        </div>
      )}

      <div className="approval-card-actions">
        <button
          className="approval-button approval-button--approve"
          onClick={() => onDecision(proposal.id, "yes")}
        >
          Approve
        </button>
        <button
          className="approval-button approval-button--decline"
          onClick={() => onDecision(proposal.id, "no")}
        >
          Decline
        </button>
      </div>
    </div>
  );
}
