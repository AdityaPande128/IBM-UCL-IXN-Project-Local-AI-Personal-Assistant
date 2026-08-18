import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  AbilitiesData,
  CatalogModel,
  DiagnosticsResult,
  DownloadsData,
  ProfileData,
  ProfileUpdate,
  SettingsResult,
  SettingsUpdate,
} from "../hooks/useWebSocket";
import { applyTheme } from "../theme";

interface SettingsViewProps {
  abilities: AbilitiesData | null;
  diagnostics: DiagnosticsResult | null;
  settingsResult: SettingsResult | null;
  profile: ProfileData | null;
  downloads: DownloadsData | null;
  incognito: boolean;
  onRefresh: () => void;
  onSaveDiagnostics: () => void;
  onUpdateSettings: (update: SettingsUpdate) => void;
  onUpdateProfile: (update: ProfileUpdate) => void;
  onSetIncognito: (on: boolean) => void;
  onDownloadAction: (action: "start" | "stop" | "status", model?: string) => void;
  onClose: () => void;
}

const POLICIES = ["pinned", "resident", "transient"];
const DOOR_ACK_KEY = "jarvis-openclaw-door-acknowledged";
const AVATAR_SIDE = 96;

const TABS = [
  { id: "profile", label: "Profile" },
  { id: "general", label: "General" },
  { id: "voice", label: "Voice" },
  { id: "models", label: "Models" },
  { id: "connections", label: "Connections" },
  { id: "advanced", label: "Advanced" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function readAvatar(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = AVATAR_SIDE;
      canvas.height = AVATAR_SIDE;
      const side = Math.min(image.width, image.height);
      canvas.getContext("2d")!.drawImage(
        image,
        (image.width - side) / 2, (image.height - side) / 2, side, side,
        0, 0, AVATAR_SIDE, AVATAR_SIDE
      );
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.82));
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("not an image"));
    };
    image.src = url;
  });
}

export function SettingsView({
  abilities, diagnostics, settingsResult, profile, downloads, incognito,
  onRefresh, onSaveDiagnostics, onUpdateSettings, onUpdateProfile,
  onSetIncognito, onDownloadAction, onClose,
}: SettingsViewProps) {
  const [tab, setTab] = useState<TabId>("profile");
  const [nameEdit, setNameEdit] = useState<string | null>(null);
  const [tierEdits, setTierEdits] = useState<
    Record<string, { model?: string; policy?: string }>
  >({});
  const [browserEdit, setBrowserEdit] = useState<string | null>(null);
  const [mailEdit, setMailEdit] = useState<string | null>(null);
  const [doorOpen, setDoorOpen] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    onRefresh();
  }, [onRefresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const openDashboard = async () => {
    if (!abilities) return;
    try {
      await openUrl(abilities.openclaw.dashboard);
    } catch {
      window.open(abilities.openclaw.dashboard, "_blank");
    }
  };

  const pickAvatar = async (file: File | undefined) => {
    if (!file) return;
    try {
      setAvatarError(null);
      onUpdateProfile({ avatar: await readAvatar(file) });
    } catch {
      setAvatarError("That file could not be read as an image.");
    }
  };

  const smithModel = abilities?.tiers.find((t) => t.tier === "smith")?.model;
  const smithDownloaded = downloads?.queue.some(
    (j) => j.model === smithModel && j.status === "done")
    || abilities?.catalog?.smiths.find((e) => e.model === smithModel)?.downloaded;

  const changedTiers: SettingsUpdate["tiers"] = {};
  if (abilities) {
    for (const tier of abilities.tiers) {
      const edit = tierEdits[tier.tier];
      if (!edit) continue;
      const changed: { model?: string; policy?: string } = {};
      if (edit.model !== undefined && edit.model !== tier.model) changed.model = edit.model;
      if (edit.policy !== undefined && edit.policy !== tier.policy) changed.policy = edit.policy;
      if (Object.keys(changed).length) changedTiers[tier.tier] = changed;
    }
  }
  const browserChanged =
    browserEdit !== null && browserEdit !== abilities?.browser.current;
  const mailChanged = mailEdit !== null && mailEdit !== abilities?.mail.current;
  const dirty =
    Object.keys(changedTiers).length > 0 || browserChanged || mailChanged;

  const applyRow = (dirty || settingsResult) && (
    <div className="diag-row">
      {dirty && (
        <button
          className="diag-button"
          disabled={settingsResult?.status === "applying"}
          onClick={() =>
            onUpdateSettings({
              ...(Object.keys(changedTiers).length ? { tiers: changedTiers } : {}),
              ...(browserChanged ? { desktop_browser: browserEdit! } : {}),
              ...(mailChanged ? { mail_provider: mailEdit! } : {}),
            })
          }
        >
          {settingsResult?.status === "applying"
            ? "Applying…"
            : "Apply and restart the core"}
        </button>
      )}
      {settingsResult?.status === "applied" && (
        <span className="diag-path">Applied — the core is restarting…</span>
      )}
      {settingsResult?.status === "invalid" && (
        <span className="diag-error">{settingsResult.error}</span>
      )}
    </div>
  );

  return (
    <div className="settings-backdrop" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="settings-modal" role="dialog" aria-label="Settings">
        <div className="settings-rail">
          <div className="settings-rail-title">Settings</div>
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`settings-tab ${tab === t.id ? "settings-tab--active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
          <button className="settings-close" onClick={onClose}>Done</button>
        </div>

        <div className="settings-content">
          {!profile || !abilities ? (
            <div className="abilities-empty">Loading…</div>
          ) : (
            <>
              {tab === "profile" && (
                <>
                  <div className="settings-field settings-field--avatar">
                    <span className="settings-label">Photo</span>
                    <div className="settings-avatar-row">
                      {profile.avatar ? (
                        <img className="settings-avatar" src={profile.avatar} alt="Your photo" />
                      ) : (
                        <span className="settings-avatar settings-avatar--empty" aria-hidden="true" />
                      )}
                      <input
                        ref={fileRef}
                        type="file"
                        accept="image/*"
                        hidden
                        onChange={(e) => pickAvatar(e.target.files?.[0])}
                      />
                      <button className="ob-mini-button" onClick={() => fileRef.current?.click()}>
                        {profile.avatar ? "Change photo" : "Add a photo"}
                      </button>
                      {profile.avatar && (
                        <button className="ob-mini-button" onClick={() => onUpdateProfile({ avatar: "" })}>
                          Remove
                        </button>
                      )}
                    </div>
                    {avatarError && <span className="diag-error">{avatarError}</span>}
                  </div>
                  <div className="settings-field">
                    <span className="settings-label">Name</span>
                    <input
                      className="settings-input"
                      value={nameEdit ?? profile.name}
                      maxLength={80}
                      onChange={(e) => setNameEdit(e.target.value)}
                      onBlur={() => {
                        const trimmed = (nameEdit ?? "").trim();
                        if (nameEdit !== null && trimmed && trimmed !== profile.name) {
                          onUpdateProfile({ name: trimmed });
                        }
                        setNameEdit(null);
                      }}
                    />
                  </div>
                  <div className="settings-field">
                    <span className="settings-label">Theme</span>
                    <select
                      className="settings-select"
                      value={profile.theme}
                      onChange={(e) => {
                        const theme = e.target.value as "dark" | "light";
                        applyTheme(theme);
                        onUpdateProfile({ theme });
                      }}
                    >
                      <option value="dark">Dark</option>
                      <option value="light">Light</option>
                    </select>
                  </div>
                </>
              )}

              {tab === "general" && (
                <>
                  <div className="settings-field">
                    <span className="settings-label">Executor</span>
                    <select
                      className="settings-select"
                      value={profile.mode}
                      onChange={(e) =>
                        onUpdateProfile({ mode: e.target.value as "jarvis" | "openclaw" })
                      }
                    >
                      <option value="jarvis">Jarvis — checked and verified</option>
                      <option value="openclaw">OpenClaw with Jarvis enhancements</option>
                    </select>
                  </div>
                  <div className="settings-field">
                    <span className="settings-label">Private mode</span>
                    <label className="ob-check">
                      <input
                        type="checkbox"
                        checked={incognito}
                        onChange={(e) => onSetIncognito(e.target.checked)}
                      />
                      Nothing from this session is remembered
                    </label>
                  </div>
                  <div className="settings-field">
                    <span className="settings-label">Improvement</span>
                    <label className="ob-check">
                      <input
                        type="checkbox"
                        checked={profile.improvement}
                        onChange={(e) => onUpdateProfile({ improvement: e.target.checked })}
                      />
                      Jarvis may build and test new skills for itself
                    </label>
                    {profile.improvement && smithModel && !smithDownloaded && (
                      <button
                        className="ob-mini-button"
                        onClick={() => onDownloadAction("start", smithModel)}
                      >
                        Download the improver
                      </button>
                    )}
                  </div>
                  <div className="settings-field">
                    <span className="settings-label">OpenClaw</span>
                    {!abilities.openclaw.connected ? (
                      <span className="diag-note">
                        OpenClaw is not installed on this machine, so there is no
                        dashboard to open.
                      </span>
                    ) : doorOpen ? (
                      <div className="door-card">
                        <div className="door-title">You are leaving Jarvis's guarantees</div>
                        <div className="door-text">
                          The OpenClaw dashboard controls a general executor that runs
                          outside this app: its actions are not mandate-checked and its
                          outcomes are not verified by Jarvis. The dashboard opens in
                          your own browser, never in the assistant's automation profile.
                        </div>
                        <div className="ability-actions">
                          <button
                            className="approval-button approval-button--approve"
                            onClick={() => {
                              localStorage.setItem(DOOR_ACK_KEY, "yes");
                              setDoorOpen(false);
                              openDashboard();
                            }}
                          >
                            Open the dashboard
                          </button>
                          <button
                            className="approval-button approval-button--decline"
                            onClick={() => setDoorOpen(false)}
                          >
                            Stay here
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        className="door-button"
                        onClick={() => {
                          if (localStorage.getItem(DOOR_ACK_KEY)) openDashboard();
                          else setDoorOpen(true);
                        }}
                      >
                        Open OpenClaw dashboard
                      </button>
                    )}
                  </div>
                </>
              )}

              {tab === "voice" && (
                <div className="settings-field">
                  <span className="settings-label">Voice</span>
                  <label className="ob-check">
                    <input
                      type="checkbox"
                      checked={profile.voice.enabled}
                      onChange={(e) => onUpdateProfile({ voice: { enabled: e.target.checked } })}
                    />
                    Voice on
                  </label>
                  {profile.voice.enabled && (
                    <label className="ob-check">
                      <input
                        type="checkbox"
                        checked={profile.voice.tts}
                        onChange={(e) => onUpdateProfile({ voice: { tts: e.target.checked } })}
                      />
                      Jarvis speaks back
                    </label>
                  )}
                </div>
              )}

              {tab === "models" && (
                <>
                  {abilities.budget.budget_gb !== null && (
                    <div className="diag-note">
                      {abilities.budget.budget_gb} GB is budgeted for models
                      {abilities.budget.voice_reserve_gb !== null &&
                        `, with ${abilities.budget.voice_reserve_gb} GB reserved for voice`}
                      . Changes apply after a quick restart of the assistant's core.
                    </div>
                  )}
                  <div className="build-list">
                    {abilities.tiers
                      .filter((tier) => tier.tier !== "guard")
                      .map((tier) => {
                        const edit = tierEdits[tier.tier] ?? {};
                        const model = edit.model ?? tier.model;
                        const measured = abilities.budget.measured_gb[model];
                        const offered: CatalogModel[] | undefined =
                          tier.tier === "engine" ? abilities.catalog?.engines
                          : tier.tier === "smith" ? abilities.catalog?.smiths
                          : undefined;
                        return (
                          <div key={tier.tier} className="build-row">
                            <span className="settings-label">
                              {tier.tier === "engine" ? "Engine (and guard)" : "Builder"}
                            </span>
                            {offered && offered.length ? (
                              <select
                                className="settings-select"
                                value={model}
                                onChange={(e) =>
                                  setTierEdits((prev) => ({
                                    ...prev,
                                    [tier.tier]: { ...prev[tier.tier], model: e.target.value },
                                  }))
                                }
                              >
                                {!offered.some((entry) => entry.model === model) && (
                                  <option value={model}>{model}</option>
                                )}
                                {offered.map((entry) => (
                                  <option key={entry.model} value={entry.model}>
                                    {entry.label}
                                    {entry.recommended ? " (Recommended)" : ""} — {entry.ram_gb.toFixed(1)} GB memory · {entry.disk_gb.toFixed(1)} GB disk
                                    {entry.downloaded ? "" : " · needs download"}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <input
                                className="settings-input"
                                value={model}
                                onChange={(e) =>
                                  setTierEdits((prev) => ({
                                    ...prev,
                                    [tier.tier]: { ...prev[tier.tier], model: e.target.value },
                                  }))
                                }
                              />
                            )}
                            <select
                              className="settings-select"
                              value={edit.policy ?? tier.policy}
                              onChange={(e) =>
                                setTierEdits((prev) => ({
                                  ...prev,
                                  [tier.tier]: { ...prev[tier.tier], policy: e.target.value },
                                }))
                              }
                            >
                              {POLICIES.map((p) => (
                                <option key={p} value={p}>
                                  {p}
                                </option>
                              ))}
                            </select>
                            <span className="build-meta">
                              {measured !== undefined ? `${measured.toFixed(1)} GB` : "unmeasured"}
                            </span>
                          </div>
                        );
                      })}
                  </div>
                  {applyRow}
                </>
              )}

              {tab === "connections" && (
                <>
                  <div className="settings-field">
                    <span className="settings-label">Linked browser</span>
                    <span className="diag-note">
                      Web tasks that need your signed-in sessions drive this browser on
                      your desktop, visibly.
                    </span>
                    <select
                      className="settings-select"
                      value={browserEdit ?? abilities.browser.current}
                      onChange={(e) => setBrowserEdit(e.target.value)}
                    >
                      {abilities.browser.installed.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="settings-field">
                    <span className="settings-label">Mail provider</span>
                    <span className="diag-note">
                      Mail tasks start at this mailbox. The linked browser must be
                      signed in to it.
                    </span>
                    <select
                      className="settings-select"
                      value={mailEdit ?? abilities.mail.current}
                      onChange={(e) => setMailEdit(e.target.value)}
                    >
                      {abilities.mail.available.map((p) => (
                        <option key={p.name} value={p.name}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  {applyRow}
                </>
              )}

              {tab === "advanced" && (
                <div className="settings-field">
                  <span className="settings-label">Diagnostics</span>
                  <span className="diag-note">
                    Saves a zip of service logs, configuration and recent runs for
                    debugging. Nothing leaves this Mac unless you share it.
                  </span>
                  <div className="diag-row">
                    <button
                      className="diag-button"
                      disabled={diagnostics?.status === "saving"}
                      onClick={onSaveDiagnostics}
                    >
                      {diagnostics?.status === "saving" ? "Saving…" : "Save a diagnostics bundle"}
                    </button>
                    {diagnostics?.status === "saved" && (
                      <span className="diag-path">Saved to {diagnostics.path}</span>
                    )}
                    {diagnostics?.status === "error" && (
                      <span className="diag-error">Could not save: {diagnostics.error}</span>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
