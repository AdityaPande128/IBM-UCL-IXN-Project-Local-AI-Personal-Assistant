import { useEffect, useState } from "react";

interface PendingProps {
  label: string;
  onRetry: () => void;
}

// A loading line that admits defeat: after a while without data it stops
// pretending and offers a way to ask again.
export function Pending({ label, onRetry }: PendingProps) {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setStale(true), 8000);
    return () => clearTimeout(timer);
  }, []);

  if (!stale) {
    return <div className="abilities-empty">{label}</div>;
  }
  return (
    <div className="abilities-empty">
      The assistant isn't answering.{" "}
      <button className="ob-mini-button" onClick={() => { setStale(false); onRetry(); }}>
        Try again
      </button>
    </div>
  );
}
