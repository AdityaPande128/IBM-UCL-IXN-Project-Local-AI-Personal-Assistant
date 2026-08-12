import { useEffect, useState } from "react";
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

function App() {
  const {
    connected,
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
  const [showActivity, setShowActivity] = useState(true);
  const [showDownloads, setShowDownloads] = useState(false);
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const [wizardActive, setWizardActive] = useState(false);
  const [view, setView] = useState<
    "chat" | "abilities" | "inbox" | "memory" | "audit" | "permissions"
  >("chat");

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
    if (!voiceNotice) return;
    const timer = setTimeout(() => setVoiceNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [voiceNotice]);

  const voiceNotReady = () => {
    setVoiceNotice(
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

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-logo">
          <span className="app-logo-orb" />
          <span className="app-logo-text">Jarvis</span>
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
            className={`activity-toggle ${view === "inbox" ? "activity-toggle--on" : ""}`}
            onClick={() => setView((v) => (v === "inbox" ? "chat" : "inbox"))}
          >
            Inbox
            {brief && brief.notices.length + brief.proposals.length > 0 && (
              <span className="inbox-badge">
                {brief.notices.length + brief.proposals.length}
              </span>
            )}
          </button>
          <button
            className={`activity-toggle ${view === "memory" ? "activity-toggle--on" : ""}`}
            onClick={() => setView((v) => (v === "memory" ? "chat" : "memory"))}
          >
            Memory
            {memory?.incognito && <span className="memory-badge">◐</span>}
          </button>
          <button
            className={`activity-toggle ${view === "abilities" ? "activity-toggle--on" : ""}`}
            onClick={() => setView((v) => (v === "abilities" ? "chat" : "abilities"))}
          >
            Abilities
          </button>
          <button
            className={`activity-toggle ${view === "audit" ? "activity-toggle--on" : ""}`}
            onClick={() => setView((v) => (v === "audit" ? "chat" : "audit"))}
          >
            Audit
          </button>
          <button
            className={`activity-toggle ${view === "permissions" ? "activity-toggle--on" : ""}`}
            onClick={() => setView((v) => (v === "permissions" ? "chat" : "permissions"))}
          >
            Permissions
          </button>
          <button
            className={`activity-toggle ${showActivity ? "activity-toggle--on" : ""}`}
            onClick={() => setShowActivity((visible) => !visible)}
          >
            Activity
          </button>
          <span className={`status-chip ${connected ? "status-chip--on" : "status-chip--off"}`}>
            <span className="status-chip-dot" />
            {connected ? "Online" : "Offline"}
          </span>
          {connected && (profile?.mode === "openclaw" || openclawConnected) && (
            <span className="status-chip status-chip--openclaw">
              <span className="status-chip-dot" />
              {profile?.mode === "openclaw" ? "OpenClaw mode" : "OpenClaw"}
            </span>
          )}
        </div>
      </header>

      {banner && <div className="service-banner">{banner}</div>}
      {voiceNotice && <div className="service-banner">{voiceNotice}</div>}
      {showDownloads && downloads && (
        <DownloadsPanel
          downloads={downloads}
          onAction={downloadAction}
          onChangeModel={() => {
            setShowDownloads(false);
            setView("abilities");
          }}
        />
      )}

      <div className="app-body">
        <main className="app-main">
          {view === "chat" && (
            <>
              <ChatLog messages={messages} />
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
              diagnostics={diagnostics}
              settingsResult={settingsResult}
              profile={profile}
              downloads={downloads}
              incognito={memory?.incognito ?? false}
              onRefresh={requestAbilities}
              onRemoveSkill={removeSkill}
              onSaveDiagnostics={saveDiagnostics}
              onUpdateSettings={updateSettings}
              onUpdateProfile={updateProfile}
              onSetIncognito={setIncognito}
              onDownloadAction={downloadAction}
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
        {showActivity && <ActivityPanel activities={activities} />}
      </div>

      <footer className="app-footer">
        <div className="input-container">
          <input
            type="text"
            className="chat-input"
            placeholder="Type a message..."
            disabled={!connected}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.currentTarget.value.trim() !== '') {
                sendIntent(e.currentTarget.value);
                e.currentTarget.value = '';
              }
            }}
          />
          {busy && (
            <button className="stop-button" onClick={sendAbort}>
              Stop
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
  );
}

export default App;
