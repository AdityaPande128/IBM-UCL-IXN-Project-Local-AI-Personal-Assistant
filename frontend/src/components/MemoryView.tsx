import { useEffect, useState } from "react";
import { Pending } from "./Pending";
import { ArmButton } from "./Confirm";
import type { MemoryData, MemoryFact, WipePreview } from "../hooks/useWebSocket";

interface MemoryViewProps {
  memory: MemoryData | null;
  wipePreview: WipePreview | null;
  onRefresh: (status?: string) => void;
  onAdd: (text: string) => void;
  onRemove: (ids: string[]) => void;
  onPin: (id: string, pinned: boolean) => void;
  onPreviewWipe: (term: string) => void;
  onClearWipePreview: () => void;
  onWipeAll: () => void;
  onSetIncognito: (on: boolean) => void;
}

const STATUSES = ["active", "archived", "superseded", "all"] as const;

function age(fact: MemoryFact): string {
  const days = Math.floor((Date.now() - fact.created_at) / 86400000);
  if (days < 1) return "today";
  if (days < 14) return `${days} day${days === 1 ? "" : "s"} ago`;
  const weeks = Math.round(days / 7);
  if (days < 60) return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? "" : "s"} ago`;
}

export function MemoryView({
  memory,
  wipePreview,
  onRefresh,
  onAdd,
  onRemove,
  onPin,
  onPreviewWipe,
  onClearWipePreview,
  onWipeAll,
  onSetIncognito,
}: MemoryViewProps) {
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("active");
  const [draft, setDraft] = useState("");
  const [wipeTerm, setWipeTerm] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [armWipeAll, setArmWipeAll] = useState(false);

  useEffect(() => {
    onRefresh(status);
  }, [onRefresh, status]);

  // A fresh preview starts with everything selected: the user prunes, then acts.
  useEffect(() => {
    setChosen(new Set(wipePreview ? wipePreview.candidates.map((f) => f.id) : []));
  }, [wipePreview]);

  if (!memory) {
    return <Pending label="Opening the memory…" onRetry={() => onRefresh()} />;
  }

  const remember = () => {
    if (draft.trim()) {
      onAdd(draft);
      setDraft("");
    }
  };

  const toggleChosen = (id: string) => {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="inbox memory">
      <div className="inbox-headline">
        <p>
          {memory.active} remembered · {memory.archived} archived · {memory.superseded}{" "}
          superseded
          {memory.secure_delete && " — deletion here is unrecoverable"}
        </p>
        <button
          className={`inbox-clear ${memory.incognito ? "memory-incognito--on" : ""}`}
          onClick={() => onSetIncognito(!memory.incognito)}
          title={
            memory.incognito
              ? "Nothing is being recorded. Click to resume remembering."
              : "Stop recording: no new memories, no traces, until turned back on"
          }
        >
          {memory.incognito ? "◐ Private mode — nothing is being recorded" : "Private mode"}
        </button>
      </div>

      <section className="inbox-section">
        <div className="memory-add">
          <input
            type="text"
            className="settings-input"
            placeholder="Something to remember…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && remember()}
            disabled={memory.incognito}
          />
          <button className="inbox-approve" onClick={remember} disabled={memory.incognito}>
            Remember
          </button>
        </div>
      </section>

      <section className="inbox-section">
        <div className="inbox-section-head">
          <h2>What Jarvis knows</h2>
          <div className="memory-filters">
            {STATUSES.map((s) => (
              <button
                key={s}
                className={`inbox-clear ${status === s ? "memory-filter--on" : ""}`}
                onClick={() => setStatus(s)}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        {memory.facts.length === 0 && (
          <div className="inbox--empty">Nothing {status === "all" ? "" : status} here.</div>
        )}
        {memory.facts.map((fact) => (
          <article key={fact.id} className="inbox-card memory-fact">
            <div className="memory-fact-row">
              <button
                className={`memory-pin ${fact.pinned ? "memory-pin--on" : ""}`}
                onClick={() => onPin(fact.id, !fact.pinned)}
                title={fact.pinned ? "Pinned: never ages out" : "Pin so it never ages out"}
              >
                {fact.pinned ? "★" : "☆"}
              </button>
              <div className="memory-fact-text">
                <div className="inbox-card-title">{fact.text}</div>
                <div className="inbox-card-detail">
                  {fact.source === "inferred" ? "noticed in conversation" : "you told me"} ·{" "}
                  {age(fact)}
                  {fact.status !== "active" && ` · ${fact.status}`}
                </div>
              </div>
              <ArmButton
                label="Forget"
                confirmLabel="Forget forever"
                className="inbox-decline"
                onConfirm={() => onRemove([fact.id])}
              />
            </div>
          </article>
        ))}
      </section>

      <section className="inbox-section">
        <div className="inbox-section-head">
          <h2>Forget about a thing</h2>
        </div>
        <div className="memory-add">
          <input
            type="text"
            className="settings-input"
            placeholder="A name, a place, a topic…"
            value={wipeTerm}
            onChange={(e) => setWipeTerm(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && wipeTerm.trim() && onPreviewWipe(wipeTerm)}
          />
          <button
            className="inbox-clear"
            onClick={() => wipeTerm.trim() && onPreviewWipe(wipeTerm)}
          >
            Find mentions
          </button>
        </div>

        {wipePreview && (
          <div className="memory-wipe-review">
            <div className="inbox-card-detail">
              {wipePreview.candidates.length === 0
                ? `Nothing mentions “${wipePreview.term}”.`
                : `Everything mentioning “${wipePreview.term}” — untick what should stay:`}
            </div>
            {wipePreview.candidates.map((fact) => (
              <label key={fact.id} className="memory-wipe-candidate">
                <input
                  type="checkbox"
                  checked={chosen.has(fact.id)}
                  onChange={() => toggleChosen(fact.id)}
                />
                <span>
                  {fact.text}
                  <span className="inbox-card-detail"> · {age(fact)} · {fact.status}</span>
                </span>
              </label>
            ))}
            <div className="inbox-card-actions">
              {wipePreview.candidates.length > 0 && (
                <button
                  className="inbox-decline"
                  disabled={chosen.size === 0}
                  onClick={() => onRemove([...chosen])}
                >
                  Forget {chosen.size} of {wipePreview.candidates.length} — permanently
                </button>
              )}
              <button className="inbox-clear" onClick={onClearWipePreview}>
                Keep everything
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="inbox-section">
        <div className="inbox-section-head">
          <h2>Start over</h2>
        </div>
        <div className="inbox-card-actions">
          {!armWipeAll ? (
            <button className="inbox-clear" onClick={() => setArmWipeAll(true)}>
              Forget everything…
            </button>
          ) : (
            <>
              <button
                className="inbox-decline"
                onClick={() => {
                  onWipeAll();
                  setArmWipeAll(false);
                }}
              >
                Really erase every memory, unrecoverably
              </button>
              <button className="inbox-clear" onClick={() => setArmWipeAll(false)}>
                Keep
              </button>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
