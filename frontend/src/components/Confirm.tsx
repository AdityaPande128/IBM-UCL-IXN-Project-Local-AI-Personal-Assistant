import { useState } from "react";

interface ArmButtonProps {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  className?: string;
  disabled?: boolean;
}

// One grammar for every destructive action: a first click arms, then a
// danger-filled confirm next to a neutral escape.
export function ArmButton({ label, confirmLabel, onConfirm, className, disabled }: ArmButtonProps) {
  const [armed, setArmed] = useState(false);

  if (armed) {
    return (
      <span className="arm-confirm">
        <button
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
