import { useEffect, useRef } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { MessageArtifacts } from "../hooks/useWebSocket";

interface ChatMessage {
  id: string;
  type: "user" | "assistant" | "system" | "error";
  text: string;
  timestamp: Date;
  artifacts?: MessageArtifacts;
}

interface ChatLogProps {
  messages: ChatMessage[];
  greetingName?: string;
  suggestions?: string[];
  onSuggest?: (text: string) => void;
  voiceEnabled?: boolean;
  busy?: boolean;
  busyLine?: string | null;
}

function formatTime(date: Date) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function revealFile(path: string) {
  revealItemInDir(path).catch(() => {});
}

function Artifacts({ artifacts }: { artifacts: MessageArtifacts }) {
  return (
    <div className="artifacts">
      {artifacts.files?.map((file) => (
        <button
          key={file.path}
          className="artifact-file"
          title={file.path}
          onClick={() => revealFile(file.path)}
        >
          <span className="artifact-file-name">{file.name}</span>
          <span className="artifact-file-meta">{formatBytes(file.bytes)}</span>
        </button>
      ))}
      {artifacts.table && (
        <div className="artifact-table-wrap">
          <table className="artifact-table">
            <thead>
              <tr>
                {artifacts.table.columns.map((column, i) => (
                  <th key={i}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {artifacts.table.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {artifacts.table.total > artifacts.table.rows.length && (
            <div className="artifact-table-more">
              showing {artifacts.table.rows.length} of {artifacts.table.total} rows
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function greeting(name?: string) {
  const hour = new Date().getHours();
  const part = hour < 5 ? "Up late" : hour < 12 ? "Good morning"
    : hour < 18 ? "Good afternoon" : "Good evening";
  return name ? `${part}, ${name}.` : `${part}.`;
}

export function ChatLog({ messages, greetingName, suggestions, onSuggest, voiceEnabled, busy, busyLine }: ChatLogProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  // Follow new output only while the reader is already at the bottom; a
  // scroll back into history is never yanked away. Position is sampled as
  // the reader scrolls — measuring after the append would count the new
  // message's own height against them.
  const followRef = useRef(true);
  useEffect(() => {
    if (followRef.current) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy, busyLine]);

  return (
    <div
      className="chat-log"
      ref={logRef}
      onScroll={(e) => {
        const log = e.currentTarget;
        followRef.current =
          log.scrollHeight - log.scrollTop - log.clientHeight < 120;
      }}
    >
      <div className="chat-log-messages">
        {messages.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-orb" />
            <div className="chat-empty-title">{greeting(greetingName)}</div>
            <div className="chat-empty-hint">
              {voiceEnabled ? "Type below, or tap the mic to talk." : "Type below to get started."}
            </div>
            {onSuggest && (suggestions?.length ?? 0) > 0 && (
              <div className="chat-suggestions">
                {suggestions!.map((prompt) => (
                  <button
                    key={prompt}
                    className="chat-suggestion"
                    onClick={() => onSuggest(prompt)}
                  >
                    {prompt}
                  </button>
                ))}
                <div className="chat-suggestions-note">
                  These act for real — mail and calendar ones open Jarvis's
                  browser window on your desktop.
                </div>
              </div>
            )}
          </div>
        )}
        {messages.map((msg) =>
          msg.type === "system" ? (
            <div key={msg.id} className="chat-system">
              {msg.text}
            </div>
          ) : (
            <div key={msg.id} className={`chat-row chat-row--${msg.type}`}>
              <div className="chat-meta">
                <span>
                  {msg.type === "user" ? "You" : msg.type === "error" ? "Error" : "Jarvis"}
                </span>
                <span className="chat-meta-time">{formatTime(msg.timestamp)}</span>
              </div>
              <div className="chat-bubble">
                {msg.text}
                {msg.artifacts && <Artifacts artifacts={msg.artifacts} />}
              </div>
            </div>
          )
        )}
        {busy && (
          <div className="chat-row chat-row--assistant" aria-live="polite">
            <div className="chat-meta">
              <span>Jarvis</span>
            </div>
            <div className="chat-bubble chat-bubble--thinking">
              <span className="thinking-dots" aria-hidden="true">
                <span /><span /><span />
              </span>
              <span className="thinking-line">{busyLine ?? "Thinking…"}</span>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
