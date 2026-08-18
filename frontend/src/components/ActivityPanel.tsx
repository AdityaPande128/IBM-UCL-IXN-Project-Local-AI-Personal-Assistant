import { useEffect, useRef } from "react";
import type { ActivityEvent } from "../hooks/useWebSocket";

interface ActivityPanelProps {
  activities: ActivityEvent[];
}

export function ActivityPanel({ activities }: ActivityPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
    if (nearBottom) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activities]);

  return (
    <aside className="activity-panel">
      <div className="activity-panel-header">
        <span className="activity-panel-title">Activity</span>
        <span className="activity-panel-count">{activities.length}</span>
      </div>
      <div className="activity-panel-entries" ref={listRef}>
        {activities.length === 0 && (
          <div className="activity-empty">Nothing happening yet</div>
        )}
        {activities.map((entry) => (
          <div key={entry.id} className="activity-entry">
            <div className="activity-entry-head">
              <span className={`activity-source activity-source--${entry.source}`}>
                {entry.source}
              </span>
              <span className="activity-event">{entry.event}</span>
              <span className="activity-time">
                {new Date(entry.at).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
              </span>
            </div>
            {entry.detail && <div className="activity-detail">{entry.detail}</div>}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </aside>
  );
}
