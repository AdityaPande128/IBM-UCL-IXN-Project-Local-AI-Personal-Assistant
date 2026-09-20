import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import type { ChannelStatus, DirectPairing } from "../hooks/useWebSocket";
import { BotSteps } from "./BotSteps";

// One screen for reaching Jarvis from a phone, shared by onboarding and
// settings: pick the app, then follow its instructions. The Android and
// iOS apps pair by scanning a QR that carries this Mac's address and the
// pairing secret; Telegram pairs by a code sent to the user's own bot.
export type PhoneChoice = "android" | "ios" | "telegram" | null;

interface PhoneLinkProps {
  channel: ChannelStatus | null;
  directPairing: DirectPairing | null;
  choice: PhoneChoice;
  onChoose: (choice: PhoneChoice) => void;
  onRequestDirectPairing: () => void;
  onRequestChannel: () => void;
  onSetChannelToken: (token: string) => void;
  telegramExtra?: React.ReactNode;
  compact?: boolean;
}

export function PhoneLink({
  channel, directPairing, choice, onChoose, onRequestDirectPairing,
  onRequestChannel, onSetChannelToken, telegramExtra, compact,
}: PhoneLinkProps) {
  const [tokenDraft, setTokenDraft] = useState("");

  useEffect(() => {
    if (choice === "android" || choice === "ios") onRequestDirectPairing();
    if (choice === "telegram") onRequestChannel();
  }, [choice, onRequestDirectPairing, onRequestChannel]);

  const options: { key: PhoneChoice; title: string; note: string }[] = [
    { key: "android", title: "Android", note: "The Jarvis app for Android" },
    { key: "ios", title: "iOS", note: "The Jarvis app for iPhone" },
    { key: "telegram", title: "Telegram", note: "Android or iOS, through a bot of your own" },
  ];

  return (
    <div className={`phone-link ${compact ? "phone-link--compact" : ""}`}>
      <div className="phone-choices" role="radiogroup" aria-label="How to connect your phone">
        {options.map((o) => (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={choice === o.key}
            className={`phone-choice ${choice === o.key ? "phone-choice--on" : ""}`}
            onClick={() => onChoose(choice === o.key ? null : o.key)}
          >
            <span className="phone-choice-title">{o.title}</span>
            <span className="phone-choice-note">{o.note}</span>
          </button>
        ))}
      </div>

      {(choice === "android" || choice === "ios") && (
        <AppPairing platform={choice} pairing={directPairing} onRefresh={onRequestDirectPairing} />
      )}

      {choice === "telegram" && (
        <div className="phone-panel">
          {channel?.error && <div className="ob-verdict ob-verdict--bad">{channel.error}</div>}
          {!channel?.has_token ? (
            <>
              <BotSteps />
              <div className="diag-row">
                <input
                  className="ob-input"
                  type="password"
                  placeholder="Bot token from @BotFather"
                  value={tokenDraft}
                  onChange={(e) => setTokenDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing && tokenDraft.trim()) {
                      onSetChannelToken(tokenDraft.trim());
                      setTokenDraft("");
                    }
                  }}
                />
                <button
                  className="ob-next"
                  disabled={!tokenDraft.trim()}
                  onClick={() => { onSetChannelToken(tokenDraft.trim()); setTokenDraft(""); }}
                >
                  Connect
                </button>
              </div>
            </>
          ) : channel.paired ? (
            <div className="ob-verdict ob-verdict--ok">Paired — your phone reaches Jarvis.</div>
          ) : channel.running && channel.pairing_code ? (
            <>
              <p className="ob-hint">
                Send this code to your bot from the phone that should be allowed to talk to Jarvis:
              </p>
              <div className="channel-code">{channel.pairing_code}</div>
            </>
          ) : (
            <p className="ob-hint">
              {channel.enabled
                ? "The token is saved; starting the channel…"
                : "A token is saved but the channel is disabled in config."}
            </p>
          )}
          {telegramExtra}
        </div>
      )}
    </div>
  );
}

function AppPairing({ platform, pairing, onRefresh }: {
  platform: "android" | "ios";
  pairing: DirectPairing | null;
  onRefresh: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const appName = platform === "android" ? "Jarvis Android app" : "Jarvis iOS app";

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pairing?.payload) return;
    QRCode.toCanvas(canvas, pairing.payload, {
      width: 232, margin: 1, errorCorrectionLevel: "M",
      color: { dark: "#111111", light: "#ffffff" },
    }).catch(() => {});
  }, [pairing?.payload]);

  return (
    <div className="phone-panel phone-panel--split">
      <ol className="bot-steps phone-steps">
        <li>Download the <strong>{appName}</strong> and open it.</li>
        <li>Make sure the phone is on the same Wi-Fi as this Mac for the first connection.</li>
        <li>Tap <strong>Pair with a Mac</strong> in the app and point the camera at the code on the right.</li>
        <li>
          That is all. The code carries this Mac's address and a secret made here; the app keeps it
          and reaches Jarvis from anywhere afterwards over its own encrypted link.
        </li>
      </ol>
      <div className="phone-qr">
        {pairing?.error ? (
          <div className="ob-verdict ob-verdict--bad">{pairing.error}</div>
        ) : pairing?.payload ? (
          <>
            <canvas ref={canvasRef} className="phone-qr-canvas" aria-label="Pairing code" />
            <span className="ob-hint">
              {pairing.host}:{pairing.port}
              {pairing.lan_bind ? "" : " · LAN access is off in config"}
            </span>
            <span className="ob-hint">Treat this code like a password.</span>
          </>
        ) : (
          <span className="ob-hint">Preparing the pairing code…</span>
        )}
        <button className="ob-mini-button" onClick={onRefresh}>Refresh</button>
      </div>
    </div>
  );
}
