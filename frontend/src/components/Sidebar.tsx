import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationSummary } from "../hooks/useWebSocket";

type View = "chat" | "abilities" | "inbox" | "memory" | "audit" | "permissions";

interface SidebarProps {
  open: boolean;
  conversations: ConversationSummary[];
  activeConversation: number | null;
  view: View;
  inboxCount: number;
  incognito: boolean;
  profileName: string;
  profileAvatar: string;
  onNewChat: () => void;
  onSelectConversation: (id: number) => void;
  onDeleteConversation: (id: number) => void;
  onSelectView: (view: View) => void;
  onOpenSettings: () => void;
}

const NAV: { view: View; label: string; icon: string }[] = [
  { view: "inbox", label: "Inbox", icon: "M3 8l7-5 7 5v8a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 16V8z M3 12h4l1.5 2h3L13 12h4" },
  { view: "memory", label: "Memory", icon: "M10 3a5 5 0 0 1 5 5c0 1.5-.6 2.6-1.5 3.6-.7.8-1 1.4-1 2.4h-5c0-1-.3-1.6-1-2.4C5.6 10.6 5 9.5 5 8a5 5 0 0 1 5-5z M8 17h4" },
  { view: "abilities", label: "Skills", icon: "M10 2l2.4 4.9L17.8 8l-3.9 3.8.9 5.4L10 14.6l-4.8 2.6.9-5.4L2.2 8l5.4-1.1z" },
  { view: "audit", label: "Audit", icon: "M4 3h12v14H4z M7 7h6 M7 10h6 M7 13h4" },
  { view: "permissions", label: "Permissions", icon: "M10 2l6 2.5V9c0 4-2.6 6.9-6 8.5C6.6 15.9 4 13 4 9V4.5z M7.5 9.6l2 2 3-3.4" },
];

function relativeDay(iso: string) {
  const then = new Date(iso);
  const today = new Date();
  const days = Math.floor((today.setHours(0, 0, 0, 0) - new Date(then).setHours(0, 0, 0, 0)) / 86400000);
  if (days === 0) return then.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (days < 0) return then.toLocaleDateString([], { day: "numeric", month: "short" });
  if (days === 1) return "Yesterday";
  if (days < 7) return then.toLocaleDateString([], { weekday: "short" });
  return then.toLocaleDateString([], { day: "numeric", month: "short" });
}

function initialsOf(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return parts.slice(0, 2).map((p) => p[0]!.toUpperCase()).join("");
}

const WIDTH_KEY = "jarvis-sidebar-width";
const MIN_WIDTH = 208;

// The sidebar may take up to 85% of the window; the ceiling moves with it.
function maxWidth() {
  return Math.max(MIN_WIDTH, Math.round(window.innerWidth * 0.85));
}

function storedWidth() {
  const value = Number(localStorage.getItem(WIDTH_KEY));
  return Number.isFinite(value) && value >= MIN_WIDTH ? Math.min(value, maxWidth()) : 248;
}

export function Sidebar({
  open, conversations, activeConversation, view, inboxCount, incognito,
  profileName, profileAvatar, onNewChat, onSelectConversation,
  onDeleteConversation, onSelectView, onOpenSettings,
}: SidebarProps) {
  const [arming, setArming] = useState<number | null>(null);
  const [width, setWidth] = useState(storedWidth);
  const dragging = useRef(false);

  useEffect(() => {
    localStorage.setItem(WIDTH_KEY, String(width));
  }, [width]);

  const startDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = "col-resize";
    const onMove = (move: MouseEvent) => {
      if (!dragging.current) return;
      setWidth(Math.min(maxWidth(), Math.max(MIN_WIDTH, move.clientX)));
    };
    const onUp = () => {
      dragging.current = false;
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  if (!open) return null;

  return (
    <aside className="sidebar" style={{ width }}>
      <button className="sidebar-new" onClick={onNewChat}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg>
        New chat
      </button>

      <div className="sidebar-section-label">Chats</div>
      <div className="sidebar-chats" role="list">
        {conversations.length === 0 && (
          <div className="sidebar-empty">Nothing yet — say hello.</div>
        )}
        {conversations.map((c) => (
          <div
            key={c.id}
            role="listitem"
            className={`sidebar-chat ${view === "chat" && activeConversation === c.id ? "sidebar-chat--active" : ""}`}
          >
            <button
              className="sidebar-chat-open"
              title={c.title}
              onClick={() => onSelectConversation(c.id)}
            >
              <span className="sidebar-chat-title">{c.title}</span>
              <span className="sidebar-chat-when">{relativeDay(c.updated_at)}</span>
            </button>
            {arming === c.id ? (
              <span className="sidebar-chat-confirm">
                <button
                  className="sidebar-chat-confirm-yes"
                  aria-label={`Delete “${c.title}”`}
                  onClick={() => { onDeleteConversation(c.id); setArming(null); }}
                >
                  Really delete
                </button>
                <button
                  className="sidebar-chat-confirm-no"
                  aria-label="Keep this chat"
                  onClick={() => setArming(null)}
                >
                  Keep
                </button>
              </span>
            ) : (
              <button
                className="sidebar-chat-delete"
                aria-label={`Delete “${c.title}”`}
                title="Delete this chat"
                onClick={() => setArming(c.id)}
              >
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M4 6h12M8 6V4h4v2M6 6l.8 10h6.4L14 6M8.5 9v4M11.5 9v4" />
                </svg>
              </button>
            )}
          </div>
        ))}
      </div>

      <nav className="sidebar-nav" aria-label="Sections">
        {NAV.map((item) => (
          <button
            key={item.view}
            className={`sidebar-nav-item ${view === item.view ? "sidebar-nav-item--active" : ""}`}
            onClick={() => onSelectView(item.view)}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d={item.icon} /></svg>
            {item.label}
            {item.view === "inbox" && inboxCount > 0 && (
              <span className="sidebar-badge">{inboxCount}</span>
            )}
            {item.view === "memory" && incognito && (
              <span className="sidebar-badge sidebar-badge--quiet">private</span>
            )}
          </button>
        ))}
        <button
          className="sidebar-nav-item"
          onClick={onOpenSettings}
          title="Settings (⌘,)"
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z" />
            <path d="M16.2 12.4a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H2a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3h.1a1.6 1.6 0 0 0 1-1.5V2a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8v.1a1.6 1.6 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
          </svg>
          Settings
        </button>
      </nav>

      <button className="sidebar-profile" onClick={onOpenSettings} title="Open settings">
        {profileAvatar ? (
          <img className="sidebar-avatar" src={profileAvatar} alt="" />
        ) : (
          <span className="sidebar-avatar sidebar-avatar--initials">{initialsOf(profileName)}</span>
        )}
        <span className="sidebar-profile-name">{profileName || "Set up your profile"}</span>
        <svg className="sidebar-profile-gear" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z" />
          <path d="M16.2 12.4a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H2a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3h.1a1.6 1.6 0 0 0 1-1.5V2a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8v.1a1.6 1.6 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
        </svg>
      </button>
      <div
        className="sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the sidebar"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={maxWidth()}
        aria-valuenow={width}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          setWidth((current) => {
            const next = Math.min(maxWidth(),
              Math.max(MIN_WIDTH, current + (e.key === "ArrowRight" ? 16 : -16)));
            localStorage.setItem(WIDTH_KEY, String(next));
            return next;
          });
        }}
        onMouseDown={startDrag}
      />
    </aside>
  );
}
