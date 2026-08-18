import { useEffect, useRef, useState } from "react";

interface ArmButtonProps {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  className?: string;
  disabled?: boolean;
}

// One grammar for every destructive action: a first click arms, then a
// danger-filled confirm next to a neutral escape. An armed state is not a
// standing hazard: it disarms on Esc and on its own after a few seconds.
export function ArmButton({ label, confirmLabel, onConfirm, className, disabled }: ArmButtonProps) {
  const [armed, setArmed] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!armed) return;
    confirmRef.current?.focus();
    const timer = setTimeout(() => setArmed(false), 6000);
    return () => clearTimeout(timer);
  }, [armed]);

  if (armed) {
    return (
      <span
        className="arm-confirm"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            setArmed(false);
          }
        }}
      >
        <button
          ref={confirmRef}
          className="arm-confirm-yes"
          disabled={disabled}
          onClick={() => {
            onConfirm();
            setArmed(false);
          }}
        >
          {confirmLabel}
        </button>
        <button className="arm-confirm-no" onClick={() => setArmed(false)}>
          Keep
        </button>
      </span>
    );
  }
  return (
    <button
      className={className ?? "ability-remove"}
      disabled={disabled}
      onClick={() => setArmed(true)}
    >
      {label}
    </button>
  );
}
