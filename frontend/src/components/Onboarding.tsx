import { useEffect, useMemo, useState } from "react";
import type {
  DownloadJob,
  DownloadsData,
  OnboardingApplyPayload,
  OnboardingApplyResult,
  OnboardingData,
} from "../hooks/useWebSocket";
import { applyTheme, storedTheme, type Theme } from "../theme";

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
    + "stop and ask you first. Skills Jarvis writes for itself run sandboxed and "
    + "are checked against a fingerprint before every run.",
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
  onComplete: () => void;
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
  const resumed = Boolean(profile.name) && (data.downloads.queue.length > 0);
  const [step, setStep] = useState<Step>(resumed ? "download" : "theme");

  const [theme, setTheme] = useState<Theme>(storedTheme());
  const [name, setName] = useState(profile.name);
  const [mode, setMode] = useState<"jarvis" | "openclaw">(profile.mode);
  const [agreed, setAgreed] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);
  const [tts, setTts] = useState(true);
  const [improvement, setImprovement] = useState(true);

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
      return `${entry.label}${job.kind === "engine" ? " — the assistant" : " — the improver"}`;
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

  const [tokenDraft, setTokenDraft] = useState("");

  useEffect(() => {
    if (step !== "phone") return;
    onRequestChannel();
    const poll = setInterval(onRequestChannel, 4000);
    return () => clearInterval(poll);
  }, [step, onRequestChannel]);

  const pickTheme = (chosen: Theme) => {
    setTheme(chosen);
    applyTheme(chosen);
  };

  const submit = () => {
    onApply({
      name: name.trim(),
      theme,
      mode,
      improvement,
      engine,
      smith: improvement ? smith : null,
      voice: { enabled: voiceOn, tts: voiceOn && tts },
    });
  };

  // The models step is only left once the daemon accepted the selection; a
  // rejected apply keeps the user where the error is shown.
  useEffect(() => {
    if (step === "models" && applyResult?.status === "applied") {
      setStep("download");
    }
  }, [step, applyResult?.status]);

  const index = STEPS.indexOf(step);

  return (
    <div className="onboarding">
      {step !== "hello" && (
        <div className="ob-progress">
          {STEPS.slice(0, -1).map((s, i) => (
            <span
              key={s}
              className={`ob-dot ${i === index ? "ob-dot--now" : i < index ? "ob-dot--done" : ""}`}
            />
          ))}
        </div>
      )}

      {step === "theme" && (
        <div className="ob-card">
          <h1 className="ob-title">Welcome</h1>
          <p className="ob-lead">First things first — how should Jarvis look?</p>
          <div className="ob-choice-row">
            <button
              className={`ob-theme-card ob-theme-card--dark ${theme === "dark" ? "ob-choice--picked" : ""}`}
              onClick={() => pickTheme("dark")}
            >
              <span className="ob-theme-swatch ob-theme-swatch--dark" />
              Dark
            </button>
            <button
              className={`ob-theme-card ob-theme-card--light ${theme === "light" ? "ob-choice--picked" : ""}`}
              onClick={() => pickTheme("light")}
            >
              <span className="ob-theme-swatch ob-theme-swatch--light" />
              Light
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
          <p className="ob-lead">This creates your profile on this Mac. Nothing is sent anywhere.</p>
          <input
            className="ob-input"
            autoFocus
            placeholder="Your name"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim()) setStep("mode");
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
          <h1 className="ob-title">How do you want to run it?</h1>
          <p className="ob-lead">Both live on this Mac and use the same local models. You can switch later from settings.</p>
          <div className="ob-choice-row">
            <button
              className={`ob-mode-card ${mode === "jarvis" ? "ob-choice--picked" : ""}`}
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
              onClick={() => setMode("openclaw")}
            >
              <div className="ob-mode-head">
                <span className="ob-mode-name">OpenClaw with Jarvis enhancements</span>
                <span className="ob-tag">Intermediate</span>
              </div>
              <ul className="ob-pros">
                <li>A mature general agent that attempts almost anything</li>
                <li>Borrows Jarvis's safer browser lane and phone channel</li>
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
          <label className="ob-check">
            <input
              type="checkbox"
              checked={agreed}
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
            Nothing is switched on here — this is the map of what each feature
            needs and exactly where macOS grants it. The first real use will
            also prompt you.
          </p>
          <div className="ob-features">
            {FEATURES.map((feature) => {
              const toggle = feature.id === "voice";
              return (
                <div key={feature.id} className="ob-feature ob-feature--on">
                  {toggle ? (
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
                  ) : (
                    <div className="ob-check ob-check--head">
                      <span>
                        <span className="ob-feature-title">{feature.title}</span>
                        <span className="ob-feature-what">{feature.what}</span>
                      </span>
                    </div>
                  )}
                  <div className="ob-grants">
                    {feature.grants.map((grant) => (
                      <div key={grant.name} className="ob-grant">
                        <span className="ob-grant-name">{grant.name}</span>
                        <span className="ob-grant-how">{grant.how}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="ob-nav">
            <button className="ob-back" onClick={() => setStep("risk")}>Back</button>
            <button className="ob-next" onClick={() => setStep(voiceOn ? "voice" : "models")}>
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
          <div className="ob-nav">
            <button className="ob-back" onClick={() => setStep("permissions")}>Back</button>
            <button className="ob-next" onClick={() => setStep("phone")}>Continue</button>
          </div>
        </div>
      )}

      {step === "phone" && (
        <div className="ob-card">
          <h1 className="ob-title">Reach Jarvis from your phone</h1>
          <p className="ob-lead">
            Optional: message Jarvis over Telegram through a bot that belongs
            to you. Create one with @BotFather, paste its token, and pair
            this Mac from your phone. You can also do this later in Settings.
          </p>
          {channel?.error && (
            <div className="ob-verdict ob-verdict--bad">{channel.error}</div>
          )}
          {!channel?.has_token ? (
            <input
              className="ob-input"
              type="password"
              placeholder="Bot token from @BotFather"
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && tokenDraft.trim()) {
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
              {applyResult?.status === "applying" ? "Setting up…" : "Download and set up"}
            </button>
          </div>
        </div>
      )}

      {step === "download" && (
        <div className="ob-card ob-card--wide">
          <h1 className="ob-title">Downloading your models</h1>
          <p className="ob-lead">
            {!connected
              ? "The assistant's core is restarting with your choices — one moment…"
              : allDone
                ? "Everything is here. Jarvis is ready."
                : baseReady
                  ? "The base model is ready — you can step in now while the rest finishes in the background."
                  : "The base model comes first; everything else follows."}
          </p>
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
                onComplete();
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
