import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
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
const WAKE_KEY = "jarvis-wake";

// Visibility of system status: while Jarvis works, the chat says which part
// of the machinery is turning, in words, from the live activity feed.
function describeActivity(latest?: { source: string; event: string; at: number }): string {
  if (!latest || Date.now() - latest.at > 120000) return "Thinking…";
  switch (`${latest.source}/${latest.event}`) {
    case "router/decision": return "Choosing how to handle it…";
    case "planner/planning": return "Working out a plan…";
    case "plan/step": return "Working through the plan…";
    case "generator/attempt": return "Writing a new skill…";
    case "generator/verifying": return "Testing the new skill in a sandbox…";
    case "generator/tests_failed": return "A test failed — rewriting and retrying…";
    case "generator/installed": return "Skill installed — running it…";
    case "skill/running": return "Running the skill…";
    case "bridge/proposal": return "Waiting for your go-ahead…";
    default: return "Thinking…";
  }
}

const SUGGESTIONS = [
  "Check my inbox for unread emails",
  "How many PDFs are in my Downloads folder?",
  "What's on my calendar this week?",
];

function App() {
  const {
    connected,
    channel,
    requestChannel,
    setChannelToken,
    clearChannel,
    conversations,
    activeConversation,
    profileError,
    selectConversation,
    deleteConversation,
    busy,
    messages,
    activities,
    proposal,
    abilities,
    diagnostics,
    settingsResult,
    brief,
    requestBrief,
    resolveApproval,
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
    wakeHeardAt,
    reportClientError,
    setWakeMode,
    sendBinary,
    sendIntent,
    sendDecision,
    saveFile,
    savedFile,
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
  const [wakeWanted, setWakeWanted] = useState(
    localStorage.getItem(WAKE_KEY) !== "off"
  );
  const [wakeMenuOpen, setWakeMenuOpen] = useState(false);
  const [wakeFlash, setWakeFlash] = useState(false);
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);
  const [wizardActive, setWizardActive] = useState(false);
  const [splashLate, setSplashLate] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSplashLate(true), 10000);
    return () => clearTimeout(timer);
  }, []);
  // A finished save shows itself: the copy is revealed where it landed.
  useEffect(() => {
    if (savedFile) revealItemInDir(savedFile.path).catch(() => {});
  }, [savedFile]);
  const [view, setView] = useState<View>("chat");
  const inputRef = useRef<HTMLInputElement>(null);

  const profile = onboarding?.profile ?? null;
  // Before a profile exists nothing is gated; a recorded choice is what
  // turns voice off.
  const voiceEnabled = profile ? profile.voice.enabled : true;

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

  // The recorded wish arms the ears whenever the pieces are ready; turning
  // it off closes the microphone at once. Failure to open the mic clears
  // the wish rather than pretending.
  useEffect(() => {
    if (!wakeWanted) {
      stopListening();
      setWakeMode(false);
      return;
    }
    if (!connected || !voiceReady || !voiceEnabled || listening) {
      reportClientError(`wake: waiting (connected=${connected} voiceReady=${voiceReady} `
        + `voiceEnabled=${voiceEnabled} listening=${listening})`, true);
      return;
    }
    reportClientError("wake: opening the microphone…", true);
    startListening().then((opened) => {
      if (opened === true) {
        reportClientError("wake: microphone open, listening armed", true);
        setWakeMode(true);
      } else {
        setWakeWanted(false);
        localStorage.setItem(WAKE_KEY, "off");
        reportClientError(`Wake listening could not open the microphone: ${opened}`);
        pushToast(`The microphone could not be opened (${opened}). If it was `
          + "never asked for, check System Settings → Privacy & Security → Microphone.");
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wakeWanted, connected, voiceReady, voiceEnabled]);

  const setWake = useCallback((on: boolean) => {
    reportClientError(`wake toggle -> ${on ? "on" : "off"}`, true);
    setWakeWanted(on);
    localStorage.setItem(WAKE_KEY, on ? "on" : "off");
    if (on && !voiceReady && profile) voiceNotReady();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceReady, profile, reportClientError]);

  // A summons lights the pill and calls the window back up: minimized or
  // buried, saying the words brings Jarvis to the front.
  useEffect(() => {
    if (!wakeHeardAt) return;
    setWakeFlash(true);
    if (inShell) {
      const win = getCurrentWindow();
      win.unminimize().catch(() => {});
      win.show().catch(() => {});
      win.setFocus().catch(() => {});
    }
    const timer = setTimeout(() => setWakeFlash(false), 4000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wakeHeardAt]);

  // The pill says Listening for as long as the summons is being worked on.
  useEffect(() => {
    if (!busy) setWakeFlash(false);
  }, [busy]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, sidebarOpen ? "open" : "closed");
  }, [sidebarOpen]);

  const pushToast = useCallback((text: string) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev.slice(-2), { id, text }]);
    // Longer messages earn longer on-screen time.
    const life = Math.min(12000, 3500 + text.length * 35);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, life);
  }, []);

  const newChat = useCallback(() => {
    selectConversation(null);
    setView("chat");
    inputRef.current?.focus();
  }, [selectConversation]);

  const inShell = "__TAURI_INTERNALS__" in window;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (wizardActive) return;
      const meta = e.metaKey || e.ctrlKey;
      // Inside the shell the native menu owns these accelerators.
      if (!inShell && meta && e.key === "n") {
        e.preventDefault();
        newChat();
      } else if (!inShell && meta && e.key === "b") {
        e.preventDefault();
        setSidebarOpen((open) => !open);
      } else if (!inShell && meta && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      } else if (e.key === "Escape" && !settingsOpen) {
        setShowActivity(false);
        setShowDownloads(false);
        setWakeMenuOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inShell, newChat, settingsOpen, wizardActive]);

  useEffect(() => {
    if (!inShell) return;
    const ready = listen<string>("jarvis-menu", (event) => {
      if (wizardActive) return;
      if (event.payload === "new-chat") newChat();
      else if (event.payload === "settings") setSettingsOpen(true);
      else if (event.payload === "toggle-sidebar") setSidebarOpen((open) => !open);
      else if (event.payload === "toggle-activity") setShowActivity((visible) => !visible);
    });
    return () => {
      ready.then((unlisten) => unlisten());
    };
  }, [inShell, newChat, wizardActive]);

  const voiceNotReady = () => {
    pushToast(
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
    const opened = await startRecording();
    if (opened !== true) {
      reportClientError(`The microphone could not be opened: ${opened}`);
      pushToast(`The microphone could not be opened (${opened}). If it was `
        + "never asked for, check System Settings → Privacy & Security → Microphone.");
    }
  };

  const handleStop = () => {
    const audioData = stopRecording();
    if (audioData) {
      sendBinary(audioData);
    }
  };


  if (onboarding === null) {
    return (
      <div className="app">
        <div className="splash">
          <span className="chat-empty-orb" />
          <div className="chat-empty-title">Jarvis</div>
          <div className="chat-empty-hint">
            {banner ?? (splashLate
              ? "The assistant's core is not answering. Quit and reopen Jarvis; if it persists, check ~/.jarvis/logs."
              : "Starting up…")}
          </div>
        </div>
      </div>
    );
  }

  if (wizardActive) {
    return (
      <div className="app">
        <Onboarding
          connected={connected}
          channel={channel}
          onRequestChannel={requestChannel}
          onSetChannelToken={setChannelToken}
          data={onboarding}
          downloads={downloads}
          applyResult={onboardingApply}
          onApply={applyOnboarding}
          onComplete={completeOnboarding}
          onDownloadAction={downloadAction}
          onFinished={() => {
            setWizardActive(false);
            setWakeWanted(localStorage.getItem(WAKE_KEY) !== "off");
          }}
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
        inboxCount={brief
          ? brief.notices.length + brief.proposals.length + brief.approvals.length
          : 0}
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
        <header className={`app-header ${sidebarOpen ? "" : "app-header--inset"}`} data-tauri-drag-region>
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
              <div className="wake-control">
                <button
                  className={`activity-toggle ${listening && wakeMode ? "wake-toggle--live" : ""} ${wakeFlash ? "wake-toggle--heard" : ""}`}
                  onClick={() => setWakeMenuOpen((open) => !open)}
                  aria-haspopup="menu"
                  aria-expanded={wakeMenuOpen}
                  title="“Hey Jarvis” settings"
                >
                  {wakeFlash ? "● Listening" : listening && wakeMode ? "“Hey Jarvis” active" : "Hey Jarvis · off"}
                </button>
                {wakeMenuOpen && (
                  <div className="wake-menu" role="menu">
                    <label className="wake-menu-row">
                      <input
                        type="checkbox"
                        className="switch"
                        checked={wakeWanted}
                        onChange={(e) => setWake(e.target.checked)}
                      />
                      <span>Listen for “Hey Jarvis”</span>
                    </label>
                    <div className="wake-menu-hint">
                      {wakeWanted
                        ? "Listening happens on this Mac only: each snippet of speech is checked for “Hey Jarvis” and discarded the instant it isn't — nothing is stored, nothing leaves the machine."
                        : "The microphone stays closed until this is on. Once on, speech is checked locally for “Hey Jarvis” and dropped the instant it isn't — never stored, never sent anywhere."}
                    </div>
                  </div>
                )}
              </div>
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
              title={connected ? "Connected" : "Reconnecting…"}
            >
              <span className="sr-only">
                {connected ? "Connected to the assistant" : "Reconnecting to the assistant"}
              </span>
            </span>
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
                  onFileSave={connected ? saveFile : undefined}
                  voiceEnabled={voiceEnabled}
                  busy={busy}
                  busyLine={busy ? describeActivity(activities[activities.length - 1]) : null}
                />
                {proposal && <ApprovalCard proposal={proposal} onDecision={sendDecision} />}
              </>
            )}
            {proposal && view !== "chat" && (
              <div className="proposal-float">
                <ApprovalCard proposal={proposal} onDecision={sendDecision} />
              </div>
            )}
            {view === "inbox" && (
              <InboxView
                brief={brief}
                onRefresh={requestBrief}
                onDecision={sendDecision}
                onResolveApproval={resolveApproval}
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
                if (e.key === "Enter" && !e.nativeEvent.isComposing
                    && e.currentTarget.value.trim() !== "") {
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
          connected={connected}
          channel={channel}
          onRequestChannel={requestChannel}
          onSetChannelToken={setChannelToken}
          onClearChannel={clearChannel}
          abilities={abilities}
          diagnostics={diagnostics}
          settingsResult={settingsResult}
          profile={profile}
          wakeWanted={wakeWanted}
          onSetWake={setWake}
          profileError={profileError}
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

      {toasts.length > 0 && (
        <div className={`toast-stack ${proposal ? "toast-stack--raised" : ""}`}>
          {toasts.map((t) => (
            <div key={t.id} className="toast" role="status">
              {t.text}
              <button
                className="toast-dismiss"
                aria-label="Dismiss"
                onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default App;
