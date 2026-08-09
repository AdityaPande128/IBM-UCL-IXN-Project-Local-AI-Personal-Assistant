import { useState } from "react";
import { ChatLog } from "./components/ChatLog";
import { PushToTalk } from "./components/PushToTalk";
import { ApprovalCard } from "./components/ApprovalCard";
import { ActivityPanel } from "./components/ActivityPanel";
import { AbilitiesView } from "./components/AbilitiesView";
import { useWebSocket } from "./hooks/useWebSocket";
import { useAudioRecorder } from "./hooks/useAudioRecorder";
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
    sendBinary,
    sendIntent,
    sendDecision,
    sendAbort,
    requestAbilities,
    removeSkill,
    saveDiagnostics,
  } = useWebSocket();
  const { recording, startRecording, stopRecording } = useAudioRecorder();
  const services = useServices();
  const banner = serviceBanner(services);
  const [showActivity, setShowActivity] = useState(true);
  const [view, setView] = useState<"chat" | "abilities">("chat");

  const handleStart = async () => {
    await startRecording();
  };

  const handleStop = () => {
    const audioData = stopRecording();
    if (audioData) {
      sendBinary(audioData);
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
            className={`activity-toggle ${view === "abilities" ? "activity-toggle--on" : ""}`}
            onClick={() => setView((v) => (v === "chat" ? "abilities" : "chat"))}
          >
            {view === "chat" ? "Abilities" : "Chat"}
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
          {view === "chat" ? (
            <>
              <ChatLog messages={messages} />
              {proposal && <ApprovalCard proposal={proposal} onDecision={sendDecision} />}
            </>
          ) : (
            <AbilitiesView
              abilities={abilities}
              diagnostics={diagnostics}
              onRefresh={requestAbilities}
              onRemoveSkill={removeSkill}
              onSaveDiagnostics={saveDiagnostics}
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
