import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  AbilitiesData,
  CatalogModel,
  ChannelStatus,
  DiagnosticsResult,
  DownloadsData,
  ProfileData,
  ProfileUpdate,
  SettingsResult,
  SettingsUpdate,
} from "../hooks/useWebSocket";
import { applyTheme, type Theme } from "../theme";
import { VOICE_CHOICES } from "../voices";
import { ArmButton } from "./Confirm";
import { BotSteps } from "./BotSteps";
import { Pending } from "./Pending";

interface SettingsViewProps {
  connected: boolean;
  abilities: AbilitiesData | null;
  channel: ChannelStatus | null;
  onRequestChannel: () => void;
  onSetChannelToken: (token: string) => void;
  onClearChannel: () => void;
  diagnostics: DiagnosticsResult | null;
  settingsResult: SettingsResult | null;
  profileError: string | null;
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
const POLICY_LABELS: Record<string, string> = {
  pinned: "Always loaded (pinned)",
  resident: "Loaded while in use (resident)",
  transient: "Loaded on demand (transient)",
};
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
  connected, abilities, channel, diagnostics, settingsResult, profile, profileError,
  downloads, incognito, onRefresh, onRequestChannel, onSetChannelToken,
  onClearChannel, onSaveDiagnostics, onUpdateSettings, onUpdateProfile,
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
  const [tokenDraft, setTokenDraft] = useState("");
  const [applyStale, setApplyStale] = useState(false);
  const [closeArmed, setCloseArmed] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    onRefresh();
    onRequestChannel();
  }, [onRefresh, onRequestChannel]);

  // The dialog owns focus while it is open, and hands it back on close.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => before?.focus?.();
  }, []);

  // An apply answered by a restart can lose its ack; stop claiming
  // "Applying…" forever.
  useEffect(() => {
    if (settingsResult?.status !== "applying") {
      setApplyStale(false);
      return;
    }
    const timer = setTimeout(() => setApplyStale(true), 25000);
    return () => clearTimeout(timer);
  }, [settingsResult?.status]);

  const commitName = useCallback(() => {
    if (closingRef.current) return;
    const trimmed = (nameEdit ?? "").trim();
    if (nameEdit !== null && profile && trimmed && trimmed !== profile.name) {
      onUpdateProfile({ name: trimmed });
    }
    setNameEdit(null);
  }, [nameEdit, profile, onUpdateProfile]);

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

  // Closing discards the half-typed name; only Enter or blur commits it.
  // The ref outruns the blur the unmount fires, which would otherwise
  // commit the draft close() just discarded.
  const closingRef = useRef(false);
  const close = useCallback(() => {
    closingRef.current = true;
    setNameEdit(null);
    onClose();
  }, [onClose]);

  // Every way out goes through the same door: unapplied edits arm the
  // Discard/Stay choice whether you press Done, Esc, or the backdrop.
  const requestClose = useCallback(() => {
    if (dirty) setCloseArmed(true);
    else close();
  }, [dirty, close]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (closeArmed) setCloseArmed(false);
        else requestClose();
        return;
      }
      if (e.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button, input, select, [tabindex]:not([tabindex="-1"])'
      )).filter((el) =>
        !(el as HTMLButtonElement).disabled && !el.hidden && el.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose, closeArmed]);

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


  const applyRow = (dirty || settingsResult) && (
    <div className="settings-field">
      {dirty && (
        <span className="settings-restart-note">
          These changes take effect after a quick restart of the assistant's core.
        </span>
      )}
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
      {applyStale && (
        <span className="diag-error">
          The reply may have been lost in the restart — your changes are still
          shown above; apply them again if the models look wrong.
        </span>
      )}
      </div>
    </div>
  );

  return (
    <div className="settings-backdrop" onMouseDown={(e) => {
      if (e.target === e.currentTarget) requestClose();
    }}>
      <div
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        ref={dialogRef}
        tabIndex={-1}
      >
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
          {!connected && (
            <div className="settings-restart-note">Reconnecting to the assistant…</div>
          )}
          {closeArmed ? (
            <div className="arm-confirm">
              <button className="arm-confirm-yes" onClick={close}>Discard</button>
              <button className="arm-confirm-no" onClick={() => setCloseArmed(false)}>
                Stay
              </button>
            </div>
          ) : (
            <button className="settings-close" onClick={requestClose}>
              Done
            </button>
          )}
        </div>

        <div className="settings-content">
          {!profile || !abilities ? (
            <Pending label="Loading…" onRetry={() => { onRefresh(); onRequestChannel(); }} />
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
                    <label className="settings-label" htmlFor="settings-name">Name</label>
                    <input
                      id="settings-name"
                      ref={nameRef}
                      className="settings-input"
                      value={nameEdit ?? profile.name}
                      maxLength={80}
                      onChange={(e) => setNameEdit(e.target.value)}
                      onBlur={commitName}
                      onKeyDown={(e) =>
                        e.key === "Enter" && !e.nativeEvent.isComposing && commitName()}
                    />
                    {profileError && <span className="diag-error">{profileError}</span>}
                  </div>
                  <div className="settings-field">
                    <span className="settings-label">Theme</span>
                    <select
                      className="settings-select"
                      value={profile.theme}
                      onChange={(e) => {
                        const theme = e.target.value as Theme;
                        applyTheme(theme);
                        onUpdateProfile({ theme });
                      }}
                    >
                      <option value="dark">Dark</option>
                      <option value="light">Light</option>
                      <option value="system">Match my Mac</option>
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
                  {profile.voice.enabled && profile.voice.tts && (
                    <label className="settings-field settings-field--sub">
                      <span className="settings-label">Voice</span>
                      <select
                        className="settings-select"
                        value={profile.voice.voice ?? "af_heart"}
                        onChange={(e) => onUpdateProfile({ voice: { voice: e.target.value } })}
                      >
                        {VOICE_CHOICES.map((v) => (
                          <option key={v.id} value={v.id}>{v.label}</option>
                        ))}
                      </select>
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
                              {tier.tier === "engine"
                                ? "Engine — answers and safety checks"
                                : "Skill builder"}
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
                                    {entry.recommended ? " (Recommended)" : ""}
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
                                  {POLICY_LABELS[p] ?? p}
                                </option>
                              ))}
                            </select>
                            <span className="settings-subline">
                              {(() => {
                                const chosen = offered?.find((entry) => entry.model === model);
                                if (!chosen) {
                                  return measured !== undefined
                                    ? `${measured.toFixed(1)} GB in memory`
                                    : "unmeasured";
                                }
                                return `${chosen.ram_gb.toFixed(1)} GB memory · `
                                  + `${chosen.disk_gb.toFixed(1)} GB disk`
                                  + (chosen.downloaded ? "" : " · needs download");
                              })()}
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
                      Jarvis drives its own window of this browser on your desktop,
                      visibly, for web tasks that need your signed-in sessions.
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

                  <div className="settings-field">
                    <span className="settings-label">Telegram</span>
                    <span className="diag-note">
                      Message Jarvis from your phone through a Telegram bot
                      that belongs only to you.
                    </span>
                    {channel?.error && <span className="diag-error">{channel.error}</span>}
                    {!channel?.has_token ? (
                      <>
                      <BotSteps />
                      <div className="diag-row">
                        <input
                          className="settings-input"
                          type="password"
                          placeholder="Bot token from @BotFather"
                          value={tokenDraft}
                          onChange={(e) => setTokenDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.nativeEvent.isComposing
                                && tokenDraft.trim()) {
                              onSetChannelToken(tokenDraft.trim());
                              setTokenDraft("");
                            }
                          }}
                        />
                        <button
                          className="diag-button"
                          disabled={!tokenDraft.trim()}
                          onClick={() => {
                            onSetChannelToken(tokenDraft.trim());
                            setTokenDraft("");
                          }}
                        >
                          Connect
                        </button>
                      </div>
                      </>
                    ) : (
                      <>
                        {channel.paired ? (
                          <span className="diag-path">
                            Connected and paired — your phone reaches Jarvis.
                          </span>
                        ) : channel.running && channel.pairing_code ? (
                          <>
                            <span className="diag-note">
                              Send this code to your bot from the phone that
                              should be allowed to talk to Jarvis:
                            </span>
                            <span className="channel-code">{channel.pairing_code}</span>
                          </>
                        ) : (
                          <span className="diag-note">
                            A token is saved but the channel isn't running
                            {channel.enabled ? "" : " — it is disabled in config"}.
                          </span>
                        )}
                        <div className="diag-row">
                          <ArmButton
                            label="Disconnect"
                            confirmLabel="Really disconnect"
                            className="ability-remove"
                            onConfirm={onClearChannel}
                          />
                          <button className="ob-mini-button" onClick={onRequestChannel}>
                            Refresh
                          </button>
                        </div>
                      </>
                    )}
                  </div>
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
