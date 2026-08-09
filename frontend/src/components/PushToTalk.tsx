interface PushToTalkProps {
  recording: boolean;
  disabled: boolean;
  onStart: () => void;
  onStop: () => void;
}

export function PushToTalk({
  recording,
  disabled,
  onStart,
  onStop,
}: PushToTalkProps) {
  return (
    <div className="ptt-container">
      <button
        className={`ptt-button ${recording ? "ptt-button--active" : ""} ${disabled ? "ptt-button--disabled" : ""}`}
        onMouseDown={!disabled ? onStart : undefined}
        onMouseUp={!disabled ? onStop : undefined}
        onMouseLeave={recording ? onStop : undefined}
        onTouchStart={!disabled ? onStart : undefined}
        onTouchEnd={!disabled ? onStop : undefined}
        disabled={disabled}
      >
        <div className="ptt-icon">
          {recording ? (
            <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5z" />
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
            </svg>
          )}
        </div>
        {recording && (
          <>
            <div className="ptt-pulse ptt-pulse--1" />
            <div className="ptt-pulse ptt-pulse--2" />
            <div className="ptt-pulse ptt-pulse--3" />
          </>
        )}
      </button>
    </div>
  );
}
