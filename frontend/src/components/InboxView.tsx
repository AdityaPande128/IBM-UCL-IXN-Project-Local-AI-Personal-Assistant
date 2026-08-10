import { useEffect } from "react";
import type { BriefData } from "../hooks/useWebSocket";

interface InboxViewProps {
  brief: BriefData | null;
  onRefresh: () => void;
  onDecision: (id: string, decision: "yes" | "no") => void;
  onMarkSeen: (ids: number[]) => void;
}

export function InboxView({ brief, onRefresh, onDecision, onMarkSeen }: InboxViewProps) {
  useEffect(() => {
    onRefresh();
  }, [onRefresh]);

  if (!brief) {
    return <div className="inbox inbox--empty">Gathering the morning…</div>;
  }

  const waiting = brief.proposals;
  const empty = !brief.notices.length && !waiting.length && !brief.approvals.length;

  return (
    <div className="inbox">
      <div className="inbox-headline">
        <p>{brief.text}</p>
        <button className="inbox-refresh" onClick={onRefresh}>
          Refresh
        </button>
      </div>

      {empty && <div className="inbox--empty">Nothing waiting. Enjoy the quiet.</div>}

      {brief.notices.length > 0 && (
        <section className="inbox-section">
          <div className="inbox-section-head">
            <h2>Changed since you looked</h2>
            <button
              className="inbox-clear"
              onClick={() => onMarkSeen(brief.notices.map((n) => n.id))}
            >
              Mark all read
            </button>
          </div>
          {brief.notices.map((notice) => (
            <article key={notice.id} className="inbox-card">
              <div className="inbox-card-title">{notice.title}</div>
              <pre className="inbox-card-body">{notice.body}</pre>
              <div className="inbox-card-actions">
                <span className="inbox-when">
                  {new Date(notice.at).toLocaleString()}
                </span>
                <button className="inbox-clear" onClick={() => onMarkSeen([notice.id])}>
                  Mark read
                </button>
              </div>
            </article>
          ))}
        </section>
      )}

      {waiting.length > 0 && (
        <section className="inbox-section">
          <div className="inbox-section-head">
            <h2>Waiting for your yes</h2>
          </div>
          {waiting.map((item) => (
            <article key={item.id} className="inbox-card inbox-card--consent">
              <div className="inbox-card-title">
                {item.summary || `${item.kind} proposal`}
              </div>
              {item.goal && <div className="inbox-card-detail">{item.goal}</div>}
              <div className="inbox-card-actions">
                <button
                  className="inbox-approve"
                  onClick={() => onDecision(item.id, "yes")}
                >
                  Approve
                </button>
                <button
                  className="inbox-decline"
                  onClick={() => onDecision(item.id, "no")}
                >
                  Decline
                </button>
              </div>
            </article>
          ))}
        </section>
      )}

      {brief.approvals.length > 0 && (
        <section className="inbox-section">
          <div className="inbox-section-head">
            <h2>Approvals in flight</h2>
          </div>
          {brief.approvals.map((approval) => (
            <article key={approval.id} className="inbox-card">
              <div className="inbox-card-title">{approval.summary}</div>
              <div className="inbox-card-detail">
                {approval.action} over {approval.channel} — answer it where it was
                asked
              </div>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
