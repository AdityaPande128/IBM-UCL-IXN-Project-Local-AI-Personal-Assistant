import { useEffect, useRef } from "react";

interface ChatMessage {
  id: string;
  type: "user" | "assistant" | "system" | "error";
  text: string;
  timestamp: Date;
}

interface ChatLogProps {
  messages: ChatMessage[];
}

function formatTime(date: Date) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
              <div className="chat-bubble">{msg.text}</div>
            </div>
          )
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
