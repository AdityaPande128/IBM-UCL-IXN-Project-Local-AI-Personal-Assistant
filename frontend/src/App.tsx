import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChatLog } from "./components/ChatLog";
import { PushToTalk } from "./components/PushToTalk";
import { ApprovalCard } from "./components/ApprovalCard";
import { ActivityPanel } from "./components/ActivityPanel";
import { AbilitiesView } from "./components/AbilitiesView";
import { InboxView } from "./components/InboxView";
import { useWebSocket } from "./hooks/useWebSocket";
import { useAudioRecorder } from "./hooks/useAudioRecorder";
import { useWakeWord } from "./hooks/useWakeWord";
import { useServices, serviceBanner } from "./hooks/useServices";
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
  } = useWebSocket();
  const { recording, startRecording, stopRecording } = useAudioRecorder();
  const { listening, startListening, stopListening } = useWakeWord(sendBinary);
  const services = useServices();
  const banner = serviceBanner(services);
  const [showActivity, setShowActivity] = useState(true);
  const [view, setView] = useState<"chat" | "abilities" | "inbox">("chat");

  useEffect(() => {
    invoke("ensure_screen_access").catch(() => {});
  }, []);

  const handleStart = async () => {
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
    if (await startListening()) {
      setWakeMode(true);
    }
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-logo">
          <span className="app-logo-orb" />
          <span className="app-logo-text">Jarvis</span>
        </div>
        <div className="app-status">
          <button
            className={`activity-toggle ${listening && wakeMode ? "wake-toggle--live" : ""}`}
            onClick={toggleWake}
            title={listening
              ? "Listening for “Hey Jarvis” — click to close the microphone"
              : "Start listening for “Hey Jarvis” (nothing is recorded until you do)"}
          >
            {listening && wakeMode ? "● Listening" : "Hey Jarvis"}
          </button>
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
            className={`activity-toggle ${view === "abilities" ? "activity-toggle--on" : ""}`}
            onClick={() => setView((v) => (v === "abilities" ? "chat" : "abilities"))}
          >
            Abilities
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
          {connected && openclawConnected && (
            <span className="status-chip status-chip--openclaw">
              <span className="status-chip-dot" />
              OpenClaw
            </span>
          )}
        </div>
      </header>

      {banner && <div className="service-banner">{banner}</div>}

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
          {view === "abilities" && (
            <AbilitiesView
              key={connected ? "online" : "offline"}
              abilities={abilities}
              diagnostics={diagnostics}
              settingsResult={settingsResult}
              onRefresh={requestAbilities}
              onRemoveSkill={removeSkill}
              onSaveDiagnostics={saveDiagnostics}
              onUpdateSettings={updateSettings}
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
          <PushToTalk
            recording={recording}
            disabled={!connected}
            onStart={handleStart}
            onStop={handleStop}
          />
        </div>
      </footer>
    </div>
  );
}

export default App;
