import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChatLog } from "./components/ChatLog";
import { PushToTalk } from "./components/PushToTalk";
import { ApprovalCard } from "./components/ApprovalCard";
import { ActivityPanel } from "./components/ActivityPanel";
import { AbilitiesView } from "./components/AbilitiesView";
import { InboxView } from "./components/InboxView";
import { MemoryView } from "./components/MemoryView";
import { AuditView } from "./components/AuditView";
import { PermissionsView } from "./components/PermissionsView";
import { Onboarding } from "./components/Onboarding";
import { Sidebar } from "./components/Sidebar";
import { SettingsView } from "./components/SettingsView";
import {
  DownloadsPanel,
  downloadsPending,
  downloadsPercent,
} from "./components/DownloadsPanel";
import { useWebSocket } from "./hooks/useWebSocket";
import { useAudioRecorder } from "./hooks/useAudioRecorder";
import { useWakeWord } from "./hooks/useWakeWord";
import { useServices, serviceBanner } from "./hooks/useServices";
import { applyTheme } from "./theme";
import "./index.css";

type View = "chat" | "abilities" | "inbox" | "memory" | "audit" | "permissions";

const VIEW_TITLES: Record<Exclude<View, "chat">, string> = {
  abilities: "Skills",
  inbox: "Inbox",
  memory: "Memory",
  audit: "Audit",
  permissions: "Permissions",
};

const SIDEBAR_KEY = "jarvis-sidebar";

const SUGGESTIONS = [
  "Check my inbox for unread emails",
  "How many PDFs are in my Downloads folder?",
  "What's on my calendar this week?",
];

function App() {
  const {
    connected,
    conversations,
    activeConversation,
    selectConversation,
    deleteConversation,
    openclawConnected,
    busy,
    messages,
    activities,
    proposal,
    abilities,
    diagnostics,
    settingsResult,
    brief,
    requestBrief,
    markNoticesSeen,
    memory,
    wipePreview,
    requestMemory,
    addMemory,
    removeMemories,
    pinMemory,
    previewWipe,
    clearWipePreview,
    wipeAllMemory,
    setIncognito,
    wakeMode,
    setWakeMode,
    sendBinary,
    sendIntent,
    sendDecision,
    sendAbort,
    requestAbilities,
    removeSkill,
    saveDiagnostics,
    updateSettings,
    audit,
    requestAudit,
    permissions,
    requestPermissions,
    checkpointResult,
    createCheckpoint,
    listCheckpoints,
    restoreCheckpoint,
    bundleResult,
    exportBundle,
    importBundle,
    onboarding,
    downloads,
    voiceReady,
    onboardingApply,
    applyOnboarding,
    completeOnboarding,
    updateProfile,
    downloadAction,
  } = useWebSocket();
  const { recording, startRecording, stopRecording } = useAudioRecorder();
  const { listening, startListening, stopListening } = useWakeWord(sendBinary);
  const services = useServices();
  const banner = serviceBanner(services);
  const [sidebarOpen, setSidebarOpen] = useState(
    localStorage.getItem(SIDEBAR_KEY) !== "closed"
  );
  const [showActivity, setShowActivity] = useState(false);
  const [showDownloads, setShowDownloads] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [wizardActive, setWizardActive] = useState(false);
  const [view, setView] = useState<View>("chat");
  const inputRef = useRef<HTMLInputElement>(null);

  const profile = onboarding?.profile ?? null;
  // Before a profile exists nothing is gated; a recorded choice is what
  // turns voice off.
  const voiceEnabled = profile ? profile.voice.enabled : true;

  useEffect(() => {
    invoke("ensure_screen_access").catch(() => {});
  }, []);

  // The wizard owns the screen from the moment a profile is missing until
  // its hello animation has played — not merely until onboarded flips.
  useEffect(() => {
    if (onboarding && !onboarding.profile.onboarded) setWizardActive(true);
  }, [onboarding]);

  // The profile's theme is the durable copy; once onboarded it wins over
  // whatever localStorage last saw.
  useEffect(() => {
    if (profile?.onboarded) applyTheme(profile.theme);
  }, [profile?.onboarded, profile?.theme]);

  // The menu-bar dot mirrors the one state that opens the microphone.
  useEffect(() => {
    invoke("set_wake_indicator", { listening: listening && wakeMode }).catch(() => {});
  }, [listening, wakeMode]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, sidebarOpen ? "open" : "closed");
  }, [sidebarOpen]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  const newChat = useCallback(() => {
    selectConversation(null);
    setView("chat");
    inputRef.current?.focus();
  }, [selectConversation]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === "n") {
        e.preventDefault();
        newChat();
      } else if (meta && e.key === "b") {
        e.preventDefault();
        setSidebarOpen((open) => !open);
      } else if (e.key === "Escape" && !settingsOpen) {
        setShowActivity(false);
        setShowDownloads(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newChat, settingsOpen]);

  const voiceNotReady = () => {
    setToast(
      "Voice isn't ready just yet — the speech models are still downloading. "
      + "The mic lights up as soon as they finish."
    );
    downloadAction("status");
  };

  const handleStart = async () => {
    if (!voiceReady && profile) {
      voiceNotReady();
      return;
    }
    await startRecording();
  };

  const handleStop = () => {
    const audioData = stopRecording();
    if (audioData) {
      sendBinary(audioData);
    }
  };

  // The mic opens and the daemon arms together; either failing leaves both off.
  const toggleWake = async () => {
    if (listening) {
      stopListening();
      setWakeMode(false);
      return;
    }
    if (!voiceReady && profile) {
      voiceNotReady();
      return;
    }
    if (await startListening()) {
      setWakeMode(true);
    }
  };

  if (onboarding === null) {
    return (
      <div className="app">
        <div className="splash">
          <span className="chat-empty-orb" />
          <div className="chat-empty-title">Jarvis</div>
          <div className="chat-empty-hint">{banner ?? "Starting up…"}</div>
        </div>
      </div>
    );
  }

  if (wizardActive) {
    return (
      <div className="app">
        <Onboarding
          connected={connected}
          data={onboarding}
          downloads={downloads}
          applyResult={onboardingApply}
          onApply={applyOnboarding}
          onComplete={completeOnboarding}
          onDownloadAction={downloadAction}
          onFinished={() => setWizardActive(false)}
        />
      </div>
    );
  }

  const activeTitle =
    view === "chat"
      ? conversations.find((c) => c.id === activeConversation)?.title ?? "New chat"
      : VIEW_TITLES[view];

  return (
    <div className="app-shell">
      <Sidebar
        open={sidebarOpen}
        conversations={conversations}
        activeConversation={activeConversation}
        view={view}
        inboxCount={brief ? brief.notices.length + brief.proposals.length : 0}
        incognito={memory?.incognito ?? false}
        profileName={profile?.name ?? ""}
        profileAvatar={profile?.avatar ?? ""}
        onNewChat={newChat}
        onSelectConversation={(id) => {
          selectConversation(id);
          setView("chat");
        }}
        onDeleteConversation={deleteConversation}
        onSelectView={setView}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <div className="app-column">
        <header className="app-header">
          <div className="app-header-left">
            <button
              className="icon-button"
              aria-label={sidebarOpen ? "Hide the sidebar" : "Show the sidebar"}
              title={`${sidebarOpen ? "Hide" : "Show"} sidebar (⌘B)`}
              onClick={() => setSidebarOpen((open) => !open)}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <rect x="3" y="4" width="14" height="12" rx="2" />
                <path d="M8 4v12" />
              </svg>
            </button>
            {!sidebarOpen && (
              <button
                className="icon-button"
                aria-label="New chat"
                title="New chat (⌘N)"
                onClick={newChat}
              >
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M10 4v12M4 10h12" />
                </svg>
              </button>
            )}
            <h1 className="app-title" title={activeTitle}>{activeTitle}</h1>
          </div>
          <div className="app-status">
            {voiceEnabled && (
              <button
                className={`activity-toggle ${listening && wakeMode ? "wake-toggle--live" : ""}`}
                onClick={toggleWake}
                title={listening
                  ? "Listening for “Hey Jarvis” — click to close the microphone"
                  : "Start listening for “Hey Jarvis” (nothing is recorded until you do)"}
              >
                {listening && wakeMode ? "● Listening" : "Hey Jarvis"}
              </button>
            )}
            {downloadsPending(downloads) && (
              <button
                className={`activity-toggle ${showDownloads ? "activity-toggle--on" : ""}`}
                onClick={() => {
                  setShowDownloads((visible) => !visible);
                  downloadAction("status");
                }}
              >
                Downloads
                {downloadsPercent(downloads) !== null && ` ${downloadsPercent(downloads)}%`}
              </button>
            )}
            <button
              className={`icon-button ${showActivity ? "icon-button--on" : ""}`}
              aria-label={showActivity ? "Hide activity" : "Show activity"}
              title="What Jarvis is doing right now"
              onClick={() => setShowActivity((visible) => !visible)}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M2 10h4l2-5 4 10 2-5h4" />
              </svg>
              {busy && <span className="icon-button-dot" aria-hidden="true" />}
            </button>
            <span
              className={`status-dot ${connected ? "status-dot--on" : "status-dot--off"}`}
              role="status"
              title={connected
                ? openclawConnected || profile?.mode === "openclaw"
                  ? "Connected · OpenClaw available"
                  : "Connected"
                : "Reconnecting…"}
            />
          </div>
        </header>

        {banner && <div className="service-banner">{banner}</div>}
        {!connected && !banner && (
          <div className="service-banner">Reconnecting to the assistant…</div>
        )}
        {showDownloads && downloads && (
          <DownloadsPanel
            downloads={downloads}
            onAction={downloadAction}
            onChangeModel={() => {
              setShowDownloads(false);
              setSettingsOpen(true);
            }}
          />
        )}

        <div className="app-body">
          <main className="app-main">
            {view === "chat" && (
              <>
                <ChatLog
                  messages={messages}
                  greetingName={profile?.name}
                  suggestions={SUGGESTIONS}
                  onSuggest={connected ? sendIntent : undefined}
                />
                {proposal && <ApprovalCard proposal={proposal} onDecision={sendDecision} />}
              </>
            )}
            {view === "inbox" && (
              <InboxView
                brief={brief}
                onRefresh={requestBrief}
                onDecision={sendDecision}
                onMarkSeen={markNoticesSeen}
              />
            )}
            {view === "memory" && (
              <MemoryView
                memory={memory}
                wipePreview={wipePreview}
                onRefresh={requestMemory}
                onAdd={addMemory}
                onRemove={removeMemories}
                onPin={pinMemory}
                onPreviewWipe={previewWipe}
                onClearWipePreview={clearWipePreview}
                onWipeAll={wipeAllMemory}
                onSetIncognito={setIncognito}
              />
            )}
            {view === "abilities" && (
              <AbilitiesView
                key={connected ? "online" : "offline"}
                abilities={abilities}
                onRefresh={requestAbilities}
                onRemoveSkill={removeSkill}
              />
            )}
            {view === "audit" && (
              <AuditView
                key={connected ? "online" : "offline"}
                audit={audit}
                onRefresh={requestAudit}
              />
            )}
            {view === "permissions" && (
              <PermissionsView
                key={connected ? "online" : "offline"}
                permissions={permissions}
                checkpointResult={checkpointResult}
                bundleResult={bundleResult}
                onRefresh={requestPermissions}
                onCreateCheckpoint={createCheckpoint}
                onListCheckpoints={listCheckpoints}
                onRestoreCheckpoint={restoreCheckpoint}
                onExportBundle={exportBundle}
                onImportBundle={importBundle}
              />
            )}
          </main>
          {showActivity && (
            <div className="activity-drawer">
              <ActivityPanel activities={activities} />
            </div>
          )}
        </div>

        <footer className="app-footer">
          <div className="input-container">
            <input
              ref={inputRef}
              type="text"
              className="chat-input"
              placeholder={connected ? "Message Jarvis…" : "Reconnecting…"}
              disabled={!connected}
              onKeyDown={(e) => {
                if (e.key === "Enter" && e.currentTarget.value.trim() !== "") {
                  sendIntent(e.currentTarget.value);
                  e.currentTarget.value = "";
                  if (view !== "chat") setView("chat");
                }
              }}
            />
            {busy ? (
              <button className="stop-button" onClick={sendAbort}>
                Stop
              </button>
            ) : (
              <button
                className="send-button"
                aria-label="Send"
                disabled={!connected}
                onClick={() => {
                  const field = inputRef.current;
                  if (field && field.value.trim() !== "") {
                    sendIntent(field.value);
                    field.value = "";
                    if (view !== "chat") setView("chat");
                    field.focus();
                  }
                }}
              >
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M10 16V4M5 9l5-5 5 5" />
                </svg>
              </button>
            )}
            {voiceEnabled && (
              <PushToTalk
                recording={recording}
                disabled={!connected}
                onStart={handleStart}
                onStop={handleStop}
              />
            )}
          </div>
        </footer>
      </div>

      {settingsOpen && (
        <SettingsView
          abilities={abilities}
          diagnostics={diagnostics}
          settingsResult={settingsResult}
          profile={profile}
          downloads={downloads}
          incognito={memory?.incognito ?? false}
          onRefresh={requestAbilities}
          onSaveDiagnostics={saveDiagnostics}
          onUpdateSettings={updateSettings}
          onUpdateProfile={updateProfile}
          onSetIncognito={setIncognito}
          onDownloadAction={downloadAction}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

export default App;
