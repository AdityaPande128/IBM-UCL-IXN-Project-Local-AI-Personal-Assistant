import { useEffect, useMemo, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useWebSocket } from "../hooks/useWebSocket";
import { Artifacts } from "./ChatLog";

export function OverlayBar() {
  const { connected, busy, messages, sendIntent } = useWebSocket();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen("overlay-shown", () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }).then((stop) => {
      unlisten = stop;
    });
    inputRef.current?.focus();
    return () => unlisten?.();
  }, []);

  const last = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.type === "assistant" || message.type === "error") return message;
    }
    return null;
  }, [messages]);

  const hide = () => {
    getCurrentWebviewWindow().hide().catch(() => {});
  };

  return (
    <div className="overlay-card">
      <div className="overlay-input-row">
        <span className="overlay-orb" />
        <input
          ref={inputRef}
          className="overlay-input"
          placeholder={
            connected ? "Ask about your screen — or anything else…" : "Connecting…"
          }
          disabled={!connected}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              hide();
              return;
            }
            if (e.key === "Enter" && e.currentTarget.value.trim() !== "") {
              sendIntent(e.currentTarget.value);
              e.currentTarget.value = "";
            }
          }}
        />
        {busy && <span className="overlay-busy">thinking…</span>}
      </div>
      {last && (
        <div
          className={`overlay-answer ${
            last.type === "error" ? "overlay-answer--error" : ""
          }`}
        >
          {last.text}
          {last.artifacts && <Artifacts artifacts={last.artifacts} />}
        </div>
      )}
    </div>
  );
}
