import { useCallback, useEffect } from "react";
import { Pending } from "./Pending";
import type { AuditData } from "../hooks/useWebSocket";

interface AuditViewProps {
  audit: AuditData | null;
  onRefresh: (since?: number) => void;
}

const LAST_SEEN_KEY = "jarvis-audit-last-seen";

function sinceLastSeen(): number | undefined {
  const stored = Number(localStorage.getItem(LAST_SEEN_KEY));
  return Number.isFinite(stored) && stored > 0 ? stored : undefined;
}

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, {
        weekday: "short", hour: "2-digit", minute: "2-digit",
        day: "numeric", month: "short",
      });
}

export function AuditView({ audit, onRefresh }: AuditViewProps) {
  useEffect(() => {
    onRefresh(sinceLastSeen());
  }, [onRefresh]);

  const markCaughtUp = useCallback(() => {
    localStorage.setItem(LAST_SEEN_KEY, String(Date.now()));
    onRefresh(Date.now());
  }, [onRefresh]);

  if (!audit) {
    return (
      <div className="abilities">
        <Pending label="Reading the record…" onRetry={() => onRefresh()} />
      </div>
    );
  }

  const quiet =
    audit.summary.plans === 0 &&
    audit.summary.decisions === 0 &&
    audit.summary.approvals === 0 &&
    audit.summary.builds === 0 &&
    audit.summary.notices === 0;

  return (
    <div className="abilities">
      <section className="abilities-section">
        <h2>While you were away</h2>
        <div className="diag-note">
          Everything below is read from the records the assistant keeps as it
          works — the plan traces, the security audit trail, the approvals and
          the build ledger — since {when(audit.since)}.
        </div>
        <div className="diag-row">
          <button className="diag-button" onClick={markCaughtUp}>
            Mark caught up
          </button>
          <span className="build-meta">
            {audit.summary.plans} {audit.summary.plans === 1 ? "task" : "tasks"} ·{" "}
            {audit.summary.succeeded} succeeded · {audit.summary.failed} failed ·{" "}
            {audit.summary.decisions} {audit.summary.decisions === 1 ? "decision" : "decisions"} ·{" "}
            {audit.summary.denied} {audit.summary.denied === 1 ? "refusal" : "refusals"} ·{" "}
            {audit.summary.approvals} {audit.summary.approvals === 1 ? "approval" : "approvals"} ·{" "}
            {audit.summary.builds} {audit.summary.builds === 1 ? "build" : "builds"} ·{" "}
            {audit.summary.notices} {audit.summary.notices === 1 ? "notice" : "notices"}
          </span>
        </div>
      </section>

      {quiet && (
        <section className="abilities-section">
          <div className="abilities-empty">Nothing happened in this window.</div>
        </section>
      )}

      {audit.plans.length > 0 && (
        <section className="abilities-section">
          <h2>Tasks</h2>
          <div className="build-list">
            {audit.plans.map((plan, index) => (
              <div key={index} className="build-row">
                <span
                  className={`ability-chip ability-chip--${
                    plan.status === "success" ? "ok"
                      : plan.status === "failed" ? "bad" : "mid"
                  }`}
                >
                  {plan.status}
                </span>
                <span className="build-request">{plan.request}</span>
                <span className="build-meta">
                  {when(plan.at)}
                  {plan.steps ? ` · ${plan.steps} step(s)` : ""}
                  {plan.surface ? ` · ${plan.surface}` : ""}
                  {plan.error ? ` · ${plan.error}` : ""}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {audit.decisions.length > 0 && (
        <section className="abilities-section">
          <h2>Security decisions</h2>
          <div className="build-list">
            {audit.decisions.map((decision, index) => (
              <div key={index} className="build-row">
                <span
                  className={`ability-chip ability-chip--${
                    decision.decision === "allow" ? "ok" : "bad"
                  }`}
                >
                  {decision.decision}
                </span>
                <span className="build-request">
                  {decision.summary || `${decision.channel}: ${decision.action}`}
                </span>
                <span className="build-meta">
                  {when(decision.at)}
                  {decision.destination ? ` · ${decision.destination}` : ""}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {audit.approvals.length > 0 && (
        <section className="abilities-section">
          <h2>Approvals</h2>
          <div className="build-list">
            {audit.approvals.map((approval, index) => (
              <div key={index} className="build-row">
                <span
                  className={`ability-chip ability-chip--${
                    approval.status === "granted" ? "ok" : "bad"
                  }`}
                >
                  {approval.status}
                </span>
                <span className="build-request">{approval.summary}</span>
                <span className="build-meta">{when(approval.at)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {audit.builds.length > 0 && (
        <section className="abilities-section">
          <h2>Skills built</h2>
          <div className="build-list">
            {audit.builds.map((build, index) => (
              <div key={index} className="build-row">
                <span
                  className={`ability-chip ability-chip--${
                    build.outcome === "registered" ? "ok" : "bad"
                  }`}
                >
                  {build.outcome}
                </span>
                <span className="build-request">{build.request}</span>
                <span className="build-meta">
                  {when(build.at)}
                  {build.skill ? ` · ${build.skill}` : ""}
                  {build.failure ? ` · ${build.failure}` : ""}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {audit.notices.length > 0 && (
        <section className="abilities-section">
          <h2>Watcher notices</h2>
          <div className="build-list">
            {audit.notices.map((notice, index) => (
              <div key={index} className="build-row">
                <span className="build-request">{notice.title}</span>
                <span className="build-meta">
                  {when(notice.at)} · {notice.body}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
