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

export function ChatLog({ messages }: ChatLogProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <div className="chat-log">
      <div className="chat-log-messages">
        {messages.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-orb" />
            <div className="chat-empty-title">How can I help?</div>
            <div className="chat-empty-hint">Type below, or hold the mic to talk.</div>
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
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
