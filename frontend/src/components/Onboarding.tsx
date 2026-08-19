import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DownloadJob,
  DownloadsData,
  OnboardingApplyPayload,
  OnboardingApplyResult,
  OnboardingData,
} from "../hooks/useWebSocket";
import { applyTheme, storedTheme, type Theme } from "../theme";
import { VOICE_CHOICES } from "../voices";
import { BotSteps } from "./BotSteps";

type Step =
  | "theme"
  | "name"
  | "mode"
  | "risk"
  | "permissions"
  | "voice"
  | "phone"
  | "models"
  | "download"
  | "hello";

const STEPS: Step[] = [
  "theme", "name", "mode", "risk", "permissions", "voice", "phone", "models", "download", "hello",
];

const STEP_NAMES: Record<Step, string> = {
  theme: "Appearance", name: "Your name", mode: "Executor", risk: "Ground rules",
  permissions: "Permissions", voice: "Voice", phone: "Phone", models: "Models",
  download: "Download", hello: "",
};

interface Feature {
  id: string;
  title: string;
  what: string;
  grants: { name: string; how: string }[];
}

const FEATURES: Feature[] = [
  {
    id: "voice",
    title: "Voice and “Hey Jarvis”",
    what: "Talk to Jarvis instead of typing, and wake it hands-free.",
    grants: [
      {
        name: "Microphone",
        how: "System Settings → Privacy & Security → Microphone → switch on Jarvis",
      },
    ],
  },
  {
    id: "web",
    title: "Mail, calendar and the web",
    what: "Jarvis drives its own browser window for mail, bookings and lookups.",
    grants: [
      {
        name: "No macOS permission needed",
        how: "Sign in to your mailbox in the linked browser the first time Jarvis opens it.",
      },
    ],
  },
  {
    id: "files",
    title: "Working with your files",
    what: "Finding, summarising and attaching documents from folders you choose.",
    grants: [
      {
        name: "Files and Folders",
        how: "macOS asks the first time Jarvis opens a folder — approve only folders "
          + "you have backed up. Full Disk Access (System Settings → Privacy & "
          + "Security) grants everything at once and is not recommended.",
      },
    ],
  },
  {
    id: "alerts",
    title: "Watchers and the morning brief",
    what: "A quiet note when something you asked Jarvis to watch changes.",
    grants: [
      {
        name: "Notifications",
        how: "System Settings → Notifications → Jarvis → Allow notifications",
      },
    ],
  },
  {
    id: "system",
    title: "Controlling apps and settings",
    what: "Skills that press the buttons for you — volume, dark mode, opening apps.",
    grants: [
      {
        name: "Accessibility",
        how: "System Settings → Privacy & Security → Accessibility → switch on Jarvis",
      },
      {
        name: "Automation",
        how: "System Settings → Privacy & Security → Automation → allow Jarvis to "
          + "control System Events",
      },
    ],
  },
  {
    id: "screen",
    title: "Capturing the screen when asked",
    what: "The screen-capture skill saves a screenshot to the Desktop, only when you ask. Jarvis cannot see or read the image — no vision model runs.",
    grants: [
      {
        name: "Screen Recording",
        how: "System Settings → Privacy & Security → Screen Recording & System Audio "
          + "→ add Jarvis",
      },
    ],
  },
];

const TERMS = [
  "Everything runs on this Mac. Your words, files and models never leave it, "
    + "and there is no account and no cloud.",
  "Actions that change things — sending, booking, deleting, spending — always "
    + "stop and ask you first. Skills Jarvis writes for itself run sandboxed, and "
    + "each is checked against its pinned content before every run.",
  "You choose what Jarvis can reach. Only grant access to files and folders "
    + "that are backed up; keep anything irreplaceable out of its reach.",
  "Jarvis is provided as-is, without warranty of any kind. The developer "
    + "cannot be held responsible for any loss of data or other damage arising "
    + "from its use. If you do not accept this, do not continue.",
];

function gb(bytes: number | null | undefined): string {
  if (!bytes) return "0.0";
  return (bytes / 1024 ** 3).toFixed(1);
}

function DownloadRow({
  job,
  label,
  onStop,
  onStart,
}: {
  job: DownloadJob;
  label: string;
  onStop: () => void;
  onStart: () => void;
}) {
  const pct = job.status === "done"
    ? 100
    : job.total_bytes
      ? Math.min(99, Math.round((job.received_bytes / job.total_bytes) * 100))
      : 0;
  const detail =
    job.status === "done" ? "downloaded"
    : job.status === "error" ? `failed: ${job.error ?? "unknown error"}`
    : job.status === "stopped" ? "paused"
    : job.status === "downloading"
      ? `${gb(job.received_bytes)} of ${job.total_bytes ? gb(job.total_bytes) : "?"} GB`
    : "waiting…";

  return (
    <div className="ob-download-row">
      <div className="ob-download-head">
        <span className="ob-download-name">{label}</span>
        <span className={`ob-download-state ob-download-state--${job.status}`}>
          {detail}
        </span>
        {(job.status === "downloading" || job.status === "queued") && (
          <button className="ob-mini-button" onClick={onStop}>Pause</button>
        )}
        {(job.status === "stopped" || job.status === "error") && (
          <button className="ob-mini-button" onClick={onStart}>Resume</button>
        )}
      </div>
      <div className="ob-bar">
        <div
          className={`ob-bar-fill ${job.status === "done" ? "ob-bar-fill--done" : ""}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

interface OnboardingProps {
  connected: boolean;
  data: OnboardingData;
  downloads: DownloadsData | null;
  applyResult: OnboardingApplyResult | null;
  channel: import("../hooks/useWebSocket").ChannelStatus | null;
  onRequestChannel: () => void;
  onSetChannelToken: (token: string) => void;
  onApply: (payload: OnboardingApplyPayload) => void;
  onComplete: (fresh?: boolean) => void;
  onDownloadAction: (action: "start" | "stop" | "status", model?: string) => void;
  onFinished: () => void;
}

export function Onboarding({
  connected,
  data,
  downloads,
  applyResult,
  channel,
  onRequestChannel,
  onSetChannelToken,
  onApply,
  onComplete,
  onDownloadAction,
  onFinished,
}: OnboardingProps) {
  const { catalog, profile } = data;

  // A daemon restart mid-flow lands back here with the profile already
  // written and a queue on disk: resume at the download page, not page one.
  // Decided once, at mount: the models step applies the profile and
  // restarts the daemon mid-wizard, and a fresh run must not start reading
  // as a resume when its own half-written profile comes back over the wire.
  const [resumed] = useState(
    () => Boolean(profile.name) && data.downloads.queue.length > 0
  );
  const [step, setStep] = useState<Step>(resumed ? "download" : "theme");

  // A resume carries the profile's recorded choices, not the defaults the
  // first run started from.
  const [theme, setTheme] = useState<Theme>(resumed ? profile.theme : storedTheme());
  const [name, setName] = useState(profile.name);
  const [mode, setMode] = useState<"jarvis" | "openclaw">(profile.mode);
  const [agreed, setAgreed] = useState(false);
  const [voiceOn, setVoiceOn] = useState(resumed ? profile.voice.enabled : true);
  const [tts, setTts] = useState(resumed ? profile.voice.tts : true);
  const [voiceName, setVoiceName] = useState(resumed ? (profile.voice.voice ?? "af_heart") : "af_heart");
  const [wake, setWake] = useState(localStorage.getItem("jarvis-wake") !== "off");
  const [improvement, setImprovement] = useState(resumed ? profile.improvement : true);

  useEffect(() => {
    if (resumed) applyTheme(profile.theme);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recommendedEngine = catalog.engines.find((e) => e.recommended)
    ?? catalog.engines[0];
  const recommendedSmith = catalog.smiths.find((e) => e.recommended)
    ?? catalog.smiths[0];
  const [engine, setEngine] = useState(recommendedEngine?.model ?? "");
  const [smith, setSmith] = useState(recommendedSmith?.model ?? "");

  const engineEntry = catalog.engines.find((e) => e.model === engine);
  const smithEntry = catalog.smiths.find((e) => e.model === smith);

  // The same arithmetic the daemon applies on the way in; the daemon's
  // verdict is the one that counts, this one just keeps the button honest.
  const verdict = useMemo(() => {
    const budget = catalog.budget_gb;
    if (budget === null || !engineEntry) return { ok: true, text: "" };
    const reserve = voiceOn ? catalog.voice_reserve_gb ?? 0 : 0;
    const available = budget - reserve;
    if (engineEntry.ram_gb > available) {
      return {
        ok: false,
        text: `${engineEntry.label} needs ${engineEntry.ram_gb.toFixed(1)} GB of memory `
          + `but only ${available.toFixed(1)} GB is safe to use on this Mac.`,
      };
    }
    if (improvement && smithEntry && smithEntry.ram_gb > available) {
      return {
        ok: false,
        text: `${smithEntry.label} needs ${smithEntry.ram_gb.toFixed(1)} GB when it runs `
          + `but only ${available.toFixed(1)} GB is safe to use on this Mac.`,
      };
    }
    const disk = catalog.machine.free_disk_gb;
    const wanted = [
      engineEntry.downloaded ? 0 : engineEntry.disk_gb,
      improvement && smithEntry && !smithEntry.downloaded ? smithEntry.disk_gb : 0,
      voiceOn && catalog.voice.stt && !catalog.voice.stt.downloaded
        ? catalog.voice.stt.disk_gb : 0,
      voiceOn && tts && catalog.voice.tts && !catalog.voice.tts.downloaded
        ? catalog.voice.tts.disk_gb : 0,
    ].reduce((a, b) => a + b, 0);
    if (disk !== null && wanted > 0 && wanted + 2 > disk) {
      return {
        ok: false,
        text: `These downloads need about ${wanted.toFixed(1)} GB of disk but only `
          + `${disk.toFixed(1)} GB is free.`,
      };
    }
    return {
      ok: true,
      text: `Fits comfortably: ${engineEntry.ram_gb.toFixed(1)} GB in use`
        + `${improvement && smithEntry
          ? `, up to ${smithEntry.ram_gb.toFixed(1)} GB while improving` : ""}`
        + `${voiceOn ? `, ${(catalog.voice_reserve_gb ?? 0).toFixed(1)} GB kept for voice`
          : ""}, within the ${budget} GB budget.`,
    };
  }, [catalog, engineEntry, smithEntry, improvement, voiceOn, tts]);

  const queue = downloads?.queue ?? data.downloads.queue;
  const baseJob = queue.find((j) => j.kind === "engine");
  const baseReady = baseJob?.status === "done";
  const allDone = queue.length > 0 && queue.every((j) => j.status === "done");

  const labelFor = (job: DownloadJob) => {
    const entry = catalog.engines.find((e) => e.model === job.model)
      ?? catalog.smiths.find((e) => e.model === job.model);
    if (entry) {
      if (job.kind !== "engine") return `${entry.label} — the improver`;
      return entry.model === engine
          ? `${entry.label} — the assistant`
          : `${entry.label} — the safety floor, always kept on disk`;
    }
    if (catalog.voice.stt?.model === job.model) return `${catalog.voice.stt.label} — hearing`;
    if (catalog.voice.tts?.model === job.model) return `${catalog.voice.tts.label} — speaking`;
    return job.model.split("/").pop() ?? job.model;
  };

  useEffect(() => {
    if (step !== "hello") return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = setTimeout(onFinished, still ? 900 : 3400);
    return () => clearTimeout(timer);
  }, [step, onFinished]);

  // A resumed wizard with every model on disk has nothing left to ask; it
  // finishes itself instead of trapping the user on the download page.
  const autoCompleted = useRef(false);
  useEffect(() => {
    if (!resumed || autoCompleted.current) return;
    if (step !== "download" || !connected || !allDone) return;
    autoCompleted.current = true;
    onComplete(false);
    setStep("hello");
  }, [resumed, step, connected, allDone, onComplete]);

  const [tokenDraft, setTokenDraft] = useState("");

  // Poll only while waiting for the phone to pair; a blind poll would
  // overwrite a rejected token's error before anyone could read it.
  useEffect(() => {
    if (step !== "phone") return;
    onRequestChannel();
  }, [step, onRequestChannel]);

  useEffect(() => {
    if (step !== "phone" || !channel?.has_token || channel.paired) return;
    const poll = setInterval(onRequestChannel, 4000);
    return () => clearInterval(poll);
  }, [step, channel?.has_token, channel?.paired, onRequestChannel]);

  const pickTheme = (chosen: Theme) => {
    setTheme(chosen);
    applyTheme(chosen);
  };

  // Permissions up front: the macOS microphone prompt belongs here, right
  // after the step that explains why — not sprung on the first mic tap
  // days later. macOS remembers the answer machine-wide.
  const probeMicrophone = () => {
    navigator.mediaDevices?.getUserMedia({ audio: true })
      .then((stream) => stream.getTracks().forEach((track) => track.stop()))
      .catch(() => { /* the toggles report any denial when they are used */ });
  };

  const submit = () => {
    onApply({
      name: name.trim(),
      theme,
      mode,
      improvement,
      engine,
      smith: improvement ? smith : null,
      voice: { enabled: voiceOn, tts: voiceOn && tts, voice: voiceName },
    });
  };

  // The models step is only left once the daemon accepted the selection; a
  // rejected apply keeps the user where the error is shown.
  useEffect(() => {
    if (step === "models" && applyResult?.status === "applied") {
      setStep("download");
    }
  }, [step, applyResult?.status]);

  const flow = STEPS.filter(
    (name) => name !== "voice" || voiceOn || step === "voice"
  );
  const index = flow.indexOf(step);

  return (
    <div className="onboarding">
      {step !== "hello" && (
        <div className="ob-progress-wrap">
          <div className="ob-progress">
            {flow.slice(0, -1).map((s, i) => (
              <span
                key={s}
                className={`ob-dot ${i === index ? "ob-dot--now" : i < index ? "ob-dot--done" : ""}`}
              />
            ))}
          </div>
          <div className="ob-step-label">
            Step {index + 1} of {flow.length - 1} · {STEP_NAMES[step]}
          </div>
        </div>
      )}

      {step === "theme" && (
        <div className="ob-card">
          <h1 className="ob-title">Welcome</h1>
          <p className="ob-lead">First things first — how should Jarvis look?</p>
          <div className="ob-choice-row">
            <button
              className={`ob-theme-card ob-theme-card--dark ${theme === "dark" ? "ob-choice--picked" : ""}`}
              aria-pressed={theme === "dark"}
              onClick={() => pickTheme("dark")}
            >
              <span className="ob-theme-swatch ob-theme-swatch--dark" />
              Dark
            </button>
            <button
              className={`ob-theme-card ob-theme-card--light ${theme === "light" ? "ob-choice--picked" : ""}`}
              aria-pressed={theme === "light"}
              onClick={() => pickTheme("light")}
            >
              <span className="ob-theme-swatch ob-theme-swatch--light" />
              Light
            </button>
            <button
              className={`ob-theme-card ob-theme-card--system ${theme === "system" ? "ob-choice--picked" : ""}`}
              aria-pressed={theme === "system"}
              onClick={() => pickTheme("system")}
            >
              <span className="ob-theme-swatch ob-theme-swatch--system" />
              Match my Mac
            </button>
          </div>
          <p className="ob-hint">You can change this any time in settings.</p>
          <div className="ob-nav">
            <button className="ob-next" onClick={() => setStep("name")}>Continue</button>
          </div>
        </div>
      )}

      {step === "name" && (
        <div className="ob-card">
          <h1 className="ob-title">What should Jarvis call you?</h1>
          <p className="ob-lead">
            {resumed
              ? "Your profile is already on this Mac — check the name and continue."
              : "This creates your profile on this Mac. Nothing is sent anywhere."}
          </p>
          <input
            className="ob-input"
            autoFocus
            placeholder="Your name"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing && name.trim()) setStep("mode");
            }}
          />
          <div className="ob-nav">
            <button className="ob-back" onClick={() => setStep("theme")}>Back</button>
            <button className="ob-next" disabled={!name.trim()} onClick={() => setStep("mode")}>
              Continue
            </button>
          </div>
        </div>
      )}

      {step === "mode" && (
        <div className="ob-card ob-card--wide">
          <h1 className="ob-title">How should your assistant run?</h1>
          <p className="ob-lead">Both live on this Mac and use the same local models. You can switch later from settings.</p>
          <div className="ob-choice-row">
            <button
              className={`ob-mode-card ${mode === "jarvis" ? "ob-choice--picked" : ""}`}
              aria-label="Jarvis — recommended, every action checked and approved"
              aria-pressed={mode === "jarvis"}
              onClick={() => setMode("jarvis")}
            >
              <div className="ob-mode-head">
                <span className="ob-mode-name">Jarvis</span>
                <span className="ob-tag ob-tag--good">Recommended · for beginners</span>
              </div>
              <ul className="ob-pros">
                <li>Every action is checked against what you actually asked for</li>
                <li>Anything that sends, books or deletes stops and asks first</li>
                <li>Learns your routines as skills it can safely repeat</li>
                <li>Full audit of what happened while you were away</li>
              </ul>
              <ul className="ob-cons">
                <li>A younger toolset — it will decline what it can't verify</li>
              </ul>
            </button>
            <button
              className={`ob-mode-card ${mode === "openclaw" ? "ob-choice--picked" : ""}`}
              aria-label="OpenClaw with Jarvis enhancements — intermediate, fewer guardrails"
              aria-pressed={mode === "openclaw"}
              onClick={() => setMode("openclaw")}
            >
              <div className="ob-mode-head">
                <span className="ob-mode-name">OpenClaw with Jarvis enhancements</span>
                <span className="ob-tag">Intermediate</span>
              </div>
              <ul className="ob-pros">
                <li>A mature general agent that attempts almost anything</li>
                <li>Uses Jarvis's checked web browsing and its phone channel</li>
                <li>Large ecosystem of community tooling</li>
              </ul>
              <ul className="ob-cons">
                <li>Acts outside Jarvis's approval gates and verification</li>
                <li>Expects more judgement — and more cleanup — from you</li>
              </ul>
            </button>
          </div>
          <div className="ob-nav">
            <button className="ob-back" onClick={() => setStep("name")}>Back</button>
            <button className="ob-next" onClick={() => setStep("risk")}>Continue</button>
          </div>
        </div>
      )}

      {step === "risk" && (
        <div className="ob-card ob-card--wide">
          <h1 className="ob-title">Before Jarvis touches anything</h1>
          <p className="ob-lead">
            Jarvis is built to be private and careful. It is still an AI assistant
            acting on a real computer — read this once, honestly.
          </p>
          <div className="ob-terms">
            {TERMS.map((t, i) => (
              <p key={i}>{t}</p>
            ))}
          </div>
          <label className="ob-check ob-check--consent">
            <input
              type="checkbox"
              checked={agreed}
              aria-label="I understand the risks and accept these terms"
              onChange={(e) => setAgreed(e.target.checked)}
            />
            I understand the risks and accept these terms.
          </label>
          <div className="ob-nav">
            <button className="ob-back" onClick={() => setStep("mode")}>Back</button>
            <button className="ob-next" disabled={!agreed} onClick={() => setStep("permissions")}>
              Continue
            </button>
          </div>
        </div>
      )}

      {step === "permissions" && (
        <div className="ob-card ob-card--wide">
          <h1 className="ob-title">What Jarvis will ask macOS for</h1>
          <p className="ob-lead">
            macOS grants these later, at the paths below, and the first real
            use also prompts you. The one choice made now is voice — everything
            else on this page is just the map.
          </p>
          <div className="ob-features">
            {FEATURES.map((feature) =>
              feature.id === "voice" ? (
                <div
                  key={feature.id}
                  className={`ob-feature ${voiceOn ? "ob-feature--on" : ""}`}
                >
                  <label className="ob-check ob-check--head">
                    <input
                      type="checkbox"
                      checked={voiceOn}
                      onChange={(e) => setVoiceOn(e.target.checked)}
                    />
                    <span>
                      <span className="ob-feature-title">{feature.title}</span>
                      <span className="ob-feature-what">{feature.what}</span>
                    </span>
                  </label>
                  <div className="ob-grants">
                    {feature.grants.map((grant) => (
                      <div key={grant.name} className="ob-grant">
                        <span className="ob-grant-name">{grant.name}</span>
                        <span className="ob-grant-how">{grant.how}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div key={feature.id} className="ob-feature ob-feature--info">
                  <span className="ob-feature-title">{feature.title}</span>
                  <span className="ob-feature-what">{feature.what}</span>
                  <div className="ob-grants">
                    {feature.grants.map((grant) => (
                      <div key={grant.name} className="ob-grant">
                        <span className="ob-grant-name">{grant.name}</span>
                        <span className="ob-grant-how">{grant.how}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )
            )}
          </div>
          <div className="ob-nav">
            <button className="ob-back" onClick={() => setStep("risk")}>Back</button>
            <button className="ob-next" onClick={() => setStep(voiceOn ? "voice" : "phone")}>
              Continue
            </button>
          </div>
        </div>
      )}

      {step === "voice" && (
        <div className="ob-card">
          <h1 className="ob-title">Voice</h1>
          <p className="ob-lead">
            Voice runs on two small local models. They download with everything else,
            and you can pause them any time.
          </p>
          <label className="ob-check ob-check--head">
            <input
              type="checkbox"
              checked={voiceOn}
              onChange={(e) => setVoiceOn(e.target.checked)}
            />
            <span>
              <span className="ob-feature-title">I want to talk to Jarvis</span>
              <span className="ob-feature-what">
                Hearing you needs {catalog.voice.stt?.label ?? "a speech model"} ·{" "}
                {catalog.voice.stt?.disk_gb.toFixed(1) ?? "?"} GB on disk
              </span>
            </span>
          </label>
          {voiceOn && (
            <label className="ob-check ob-check--head ob-check--sub">
              <input
                type="checkbox"
                checked={tts}
                onChange={(e) => setTts(e.target.checked)}
              />
              <span>
                <span className="ob-feature-title">And Jarvis speaks back</span>
                <span className="ob-feature-what">
                  {catalog.voice.tts?.label ?? "The voice model"} ·{" "}
                  {catalog.voice.tts?.disk_gb.toFixed(1) ?? "?"} GB on disk. Leave this
                  off and Jarvis answers in text only.
                </span>
              </span>
            </label>
          )}
          {voiceOn && (
            <label className="ob-check ob-check--head ob-check--sub">
              <input
                type="checkbox"
                checked={wake}
                onChange={(e) => {
                  setWake(e.target.checked);
                  localStorage.setItem("jarvis-wake", e.target.checked ? "on" : "off");
                }}
              />
              <span>
                <span className="ob-feature-title">Answer to “Hey Jarvis”</span>
                <span className="ob-feature-what">
                  Hands-free summons. Speech is checked on this Mac only and
                  dropped the instant it doesn't start with “Hey Jarvis” —
                  never stored, never sent anywhere. No voice training needed:
                  it recognises the phrase, not a particular voice.
                </span>
              </span>
            </label>
          )}
          {voiceOn && tts && (
            <label className="ob-check ob-check--sub ob-voice-pick">
              <span className="ob-feature-title">Which voice?</span>
              <select
                className="settings-select"
                value={voiceName}
                onChange={(e) => setVoiceName(e.target.value)}
              >
                {VOICE_CHOICES.map((v) => (
                  <option key={v.id} value={v.id}>{v.label}</option>
                ))}
              </select>
            </label>
          )}
          {voiceOn && (
            <p className="ob-hint">
              macOS will ask for microphone access when you continue — that
              one answer covers the mic button and “Hey Jarvis” alike.
            </p>
          )}
          <div className="ob-nav">
            <button className="ob-back" onClick={() => setStep("permissions")}>Back</button>
            <button
              className="ob-next"
              onClick={() => {
                if (voiceOn) probeMicrophone();
                setStep("phone");
              }}
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {step === "phone" && (
        <div className="ob-card">
          <h1 className="ob-title">Reach Jarvis from your phone</h1>
          <p className="ob-lead">
            Optional: message Jarvis over Telegram through a bot that belongs
            only to you. Two minutes sets it up — and you can always do this
            later in Settings.
          </p>
          {channel?.error && (
            <div className="ob-verdict ob-verdict--bad">{channel.error}</div>
          )}
          {!channel?.has_token && <BotSteps />}
          {!channel?.has_token ? (
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
          ) : channel.paired ? (
            <div className="ob-verdict ob-verdict--ok">
              Paired — your phone reaches Jarvis.
            </div>
          ) : channel.running && channel.pairing_code ? (
            <>
              <p className="ob-hint">
                Send this code to your bot from the phone that should be
                allowed to talk to Jarvis:
              </p>
              <div className="channel-code">{channel.pairing_code}</div>
            </>
          ) : (
            <p className="ob-hint">The token is saved; starting the channel…</p>
          )}
          <div className="ob-nav">
            <button className="ob-back" onClick={() => setStep(voiceOn ? "voice" : "permissions")}>
              Back
            </button>
            {!channel?.has_token && (
              <button
                className="ob-next"
                disabled={!tokenDraft.trim()}
                onClick={() => {
                  onSetChannelToken(tokenDraft.trim());
                  setTokenDraft("");
                }}
              >
                Connect
              </button>
            )}
            <button
              className={channel?.paired ? "ob-next" : "ob-skip"}
              onClick={() => setStep("models")}
            >
              {channel?.has_token ? "Continue" : "Skip for now"}
            </button>
          </div>
        </div>
      )}

      {step === "models" && (
        <div className="ob-card ob-card--wide">
          <h1 className="ob-title">Pick your models</h1>
          <p className="ob-lead">
            This Mac: {catalog.machine.total_gb} GB of memory
            {catalog.machine.free_disk_gb !== null
              && ` · ${Math.round(catalog.machine.free_disk_gb)} GB of free disk`}
            . Jarvis budgets {catalog.budget_gb ?? "?"} GB for models and recommends
            a fit for this hardware.
          </p>

          <div className="ob-choice-row">
            <button
              className={`ob-mode-card ${!improvement ? "ob-choice--picked" : ""}`}
              aria-label="Just an assistant — one model, no self-improvement"
              aria-pressed={!improvement}
              onClick={() => setImprovement(false)}
            >
              <div className="ob-mode-head">
                <span className="ob-mode-name">Just an assistant</span>
              </div>
              <p className="ob-feature-what">
                One model answers, plans and acts. Jarvis won't build new skills for
                itself. You can turn improvement on later in settings.
              </p>
            </button>
            <button
              className={`ob-mode-card ${improvement ? "ob-choice--picked" : ""}`}
              aria-label="An assistant that improves — a second model writes new skills"
              aria-pressed={improvement}
              onClick={() => setImprovement(true)}
            >
              <div className="ob-mode-head">
                <span className="ob-mode-name">An assistant that improves</span>
              </div>
              <p className="ob-feature-what">
                A second, coding-focused model writes and tests new skills when
                Jarvis meets something it can't do yet. It only loads while building.
              </p>
            </button>
          </div>

          <div className="ob-select-block">
            <label className="ob-select-label">Main engine — answers, plans and acts</label>
            <select
              className="settings-select ob-select"
              value={engine}
              title={engineEntry ? `${engineEntry.label} — ${engineEntry.ram_gb.toFixed(1)} GB memory · ${engineEntry.disk_gb.toFixed(1)} GB disk` : undefined}
              onChange={(e) => setEngine(e.target.value)}
            >
              {catalog.engines.map((entry) => (
                <option key={entry.model} value={entry.model}>
                  {entry.label}{entry.recommended ? " (Recommended)" : ""} — {entry.ram_gb.toFixed(1)} GB memory · {entry.disk_gb.toFixed(1)} GB disk{entry.downloaded ? " · already on this Mac" : ""}
                </option>
              ))}
            </select>
            {engineEntry?.blurb && <span className="ob-hint">{engineEntry.blurb}</span>}
          </div>

          {improvement && (
            <div className="ob-select-block">
              <label className="ob-select-label">Improvement model — writes new skills</label>
              <select
                className="settings-select ob-select"
                value={smith}
                title={smithEntry ? `${smithEntry.label} — ${smithEntry.ram_gb.toFixed(1)} GB memory · ${smithEntry.disk_gb.toFixed(1)} GB disk` : undefined}
                onChange={(e) => setSmith(e.target.value)}
              >
                {catalog.smiths.map((entry) => (
                  <option key={entry.model} value={entry.model}>
                    {entry.label}{entry.recommended ? " (Recommended)" : ""} — {entry.ram_gb.toFixed(1)} GB memory · {entry.disk_gb.toFixed(1)} GB disk{entry.downloaded ? " · already on this Mac" : ""}
                  </option>
                ))}
              </select>
              {smithEntry?.blurb && <span className="ob-hint">{smithEntry.blurb}</span>}
            </div>
          )}

          <div className={`ob-verdict ${verdict.ok ? "ob-verdict--ok" : "ob-verdict--bad"}`}>
            {verdict.text}
          </div>
          {applyResult?.status === "invalid" && (
            <div className="ob-verdict ob-verdict--bad">{applyResult.error}</div>
          )}

          <div className="ob-nav">
            <button
              className="ob-back"
              onClick={() => setStep("phone")}
            >
              Back
            </button>
            <button
              className="ob-next"
              disabled={!verdict.ok || !engine || applyResult?.status === "applying"}
              onClick={submit}
            >
              {applyResult?.status === "applying"
                ? "Setting up…"
                : (engineEntry?.downloaded ?? false)
                    && (!improvement || (smithEntry?.downloaded ?? false))
                    && (!voiceOn || ((catalog.voice.stt?.downloaded ?? true)
                        && (!tts || (catalog.voice.tts?.downloaded ?? true))))
                  ? "Set up"
                  : "Download and set up"}
            </button>
          </div>
        </div>
      )}

      {step === "download" && (
        <div className="ob-card ob-card--wide">
          <h1 className="ob-title">{allDone ? "Your models are ready" : "Downloading your models"}</h1>
          <p className="ob-lead">
            {!connected
              ? "The assistant's core is restarting with your choices — one moment…"
              : allDone
                ? "Everything is here. Jarvis is ready."
                : baseReady
                  ? "The base model is ready — you can step in now while the rest finishes in the background."
                  : "The base model comes first; everything else follows."}
          </p>
          {resumed && (
            <p className="ob-hint">Picking up where setup left off.</p>
          )}
          {applyResult?.status === "invalid" && (
            <div className="ob-verdict ob-verdict--bad">{applyResult.error}</div>
          )}
          <div className="ob-downloads">
            {queue.length === 0 && (
              <div className="ob-hint">Preparing the download queue…</div>
            )}
            {queue.map((job) => (
              <DownloadRow
                key={job.model}
                job={job}
                label={labelFor(job)}
                onStop={() => onDownloadAction("stop", job.model)}
                onStart={() => onDownloadAction("start", job.model)}
              />
            ))}
          </div>
          <div className="ob-nav">
            <button className="ob-back" onClick={() => setStep("models")}>
              Back
            </button>
            <button
              className="ob-next"
              disabled={!connected || !baseReady}
              onClick={() => {
                onComplete(!resumed);
                setStep("hello");
              }}
            >
              {allDone
                ? "Continue"
                : baseReady
                  ? "Continue with the base model"
                  : "Waiting for the base model…"}
            </button>
          </div>
        </div>
      )}

      {step === "hello" && (
        <div className="ob-hello">
          <div className="ob-hello-text">
            Hi{name.trim() ? `, ${name.trim().split(" ")[0]}` : ""}! I'm Jarvis
          </div>
          <div className="ob-hello-sub">Everything stays on this Mac.</div>
        </div>
      )}
    </div>
  );
}
