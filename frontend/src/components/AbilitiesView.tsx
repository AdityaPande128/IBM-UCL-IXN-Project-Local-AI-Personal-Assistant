import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  AbilitiesData,
  DiagnosticsResult,
  SettingsResult,
  SettingsUpdate,
} from "../hooks/useWebSocket";

interface AbilitiesViewProps {
  abilities: AbilitiesData | null;
  diagnostics: DiagnosticsResult | null;
  settingsResult: SettingsResult | null;
  onRefresh: () => void;
  onRemoveSkill: (name: string) => void;
  onSaveDiagnostics: () => void;
  onUpdateSettings: (update: SettingsUpdate) => void;
}

const POLICIES = ["pinned", "resident", "transient"];

const DOOR_ACK_KEY = "jarvis-openclaw-door-acknowledged";

export function AbilitiesView({
  abilities,
  diagnostics,
  settingsResult,
  onRefresh,
  onRemoveSkill,
  onSaveDiagnostics,
  onUpdateSettings,
}: AbilitiesViewProps) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [doorOpen, setDoorOpen] = useState(false);
  const [tierEdits, setTierEdits] = useState<
    Record<string, { model?: string; policy?: string }>
  >({});
  const [browserEdit, setBrowserEdit] = useState<string | null>(null);

  useEffect(() => {
    onRefresh();
  }, [onRefresh]);

  if (!abilities) {
    return (
      <div className="abilities">
        <div className="abilities-empty">Loading abilities…</div>
      </div>
    );
  }

  const openDashboard = async () => {
    try {
      await openUrl(abilities.openclaw.dashboard);
    } catch {
      window.open(abilities.openclaw.dashboard, "_blank");
    }
  };

  const handleDoor = () => {
    if (localStorage.getItem(DOOR_ACK_KEY)) {
      openDashboard();
      return;
    }
    setDoorOpen(true);
  };

  const acknowledgeDoor = () => {
    localStorage.setItem(DOOR_ACK_KEY, "yes");
    setDoorOpen(false);
    openDashboard();
  };

  return (
    <div className="abilities">
      <section className="abilities-section">
        <h2>Skills</h2>
        <div className="ability-grid">
          {abilities.skills.map((skill) => (
            <div key={skill.name} className="ability-card">
              <div className="ability-card-head">
                <span className="ability-name">{skill.name}</span>
                <span className={`ability-chip ability-chip--${skill.author}`}>
                  {skill.author}
                </span>
              </div>
              <div className="ability-desc">{skill.description}</div>
              <div className="ability-caps">
                {skill.capabilities?.exec && <span className="ability-cap">runs commands</span>}
                {skill.capabilities?.network && (
                  <span className="ability-cap ability-cap--net">network</span>
                )}
                {(skill.capabilities?.filesystem?.length ?? 0) > 0 && (
                  <span className="ability-cap">
                    files: {skill.capabilities.filesystem!.join(", ")}
                  </span>
                )}
              </div>
              {skill.author === "generated" && (
                <div className="ability-actions">
                  {confirming === skill.name ? (
                    <>
                      <button
                        className="ability-remove ability-remove--armed"
                        onClick={() => {
                          onRemoveSkill(skill.name);
                          setConfirming(null);
                        }}
                      >
                        Really remove
                      </button>
                      <button className="ability-cancel" onClick={() => setConfirming(null)}>
                        Keep
                      </button>
                    </>
                  ) : (
                    <button className="ability-remove" onClick={() => setConfirming(skill.name)}>
                      Remove
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
        {abilities.rejected.length > 0 && (
          <div className="ability-rejected">
            {abilities.rejected.map((r) => (
              <div key={r.skill} className="ability-rejected-row">
                <span className="ability-chip ability-chip--bad">unavailable</span>
                <span>{r.skill}: {r.errors.join("; ")}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {abilities.recipes.length > 0 && (
        <section className="abilities-section">
          <h2>Recipes</h2>
          <div className="build-list">
            {abilities.recipes.map((recipe) => (
              <div key={recipe.name} className="build-row">
                <span className="ability-name">{recipe.name}</span>
                <span className="build-meta">
                  {recipe.description}
                  {recipe.steps ? ` · ${recipe.steps} step(s)` : ""}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="abilities-section">
        <h2>Build history</h2>
        {abilities.builds.length === 0 ? (
          <div className="abilities-empty">No skills have been built yet.</div>
        ) : (
          <div className="build-list">
            {abilities.builds.map((build, index) => (
              <div key={index} className="build-row">
                <span
                  className={`ability-chip ability-chip--${
                    build.outcome === "registered" ? "ok" : "bad"
                  }`}
                >
                  {String(build.outcome ?? "unknown")}
                </span>
                <span className="build-request">{String(build.request ?? "")}</span>
                <span className="build-meta">
                  {String(build.skill ?? build.candidate_name ?? "")}
                  {build.failure ? ` · ${build.failure}` : ""}
                  {build.attempts ? ` · ${build.attempts} attempt(s)` : ""}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="abilities-section">
        <h2>Models</h2>
        {abilities.budget.budget_gb !== null && (
          <div className="diag-note">
            {abilities.budget.budget_gb} GB is budgeted for models
            {abilities.budget.voice_reserve_gb !== null &&
              `, with ${abilities.budget.voice_reserve_gb} GB reserved for voice`}
            . Changes apply after a quick restart of the assistant's core.
          </div>
        )}
        <div className="build-list">
          {abilities.tiers.map((tier) => {
            const edit = tierEdits[tier.tier] ?? {};
            const model = edit.model ?? tier.model;
            const measured = abilities.budget.measured_gb[model];
            return (
              <div key={tier.tier} className="build-row">
                <span className="tier-name">{tier.tier}</span>
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
      </section>

      <section className="abilities-section">
        <h2>Linked browser</h2>
        <div className="diag-note">
          Web tasks that need your signed-in sessions drive this browser on your
          desktop, visibly.
        </div>
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
      </section>

      {(() => {
        const changedTiers: SettingsUpdate["tiers"] = {};
        for (const tier of abilities.tiers) {
          const edit = tierEdits[tier.tier];
          if (!edit) continue;
          const changed: { model?: string; policy?: string } = {};
          if (edit.model !== undefined && edit.model !== tier.model) changed.model = edit.model;
          if (edit.policy !== undefined && edit.policy !== tier.policy) changed.policy = edit.policy;
          if (Object.keys(changed).length) changedTiers[tier.tier] = changed;
        }
        const browserChanged =
          browserEdit !== null && browserEdit !== abilities.browser.current;
        const dirty = Object.keys(changedTiers).length > 0 || browserChanged;
        if (!dirty && !settingsResult) return null;
        return (
          <section className="abilities-section">
            <div className="diag-row">
              {dirty && (
                <button
                  className="diag-button"
                  disabled={settingsResult?.status === "applying"}
                  onClick={() =>
                    onUpdateSettings({
                      ...(Object.keys(changedTiers).length ? { tiers: changedTiers } : {}),
                      ...(browserChanged ? { desktop_browser: browserEdit! } : {}),
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
          </section>
        );
      })()}

      <section className="abilities-section">
        <h2>Diagnostics</h2>
        <div className="diag-note">
          Saves a zip of service logs, configuration and recent runs for
          debugging. Nothing leaves this Mac unless you share it.
        </div>
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
      </section>

      <section className="abilities-section">
        <h2>OpenClaw</h2>
        {!abilities.openclaw.connected ? (
          <div className="abilities-empty">
            OpenClaw is not installed on this machine, so there is no dashboard to open.
          </div>
        ) : doorOpen ? (
          <div className="door-card">
            <div className="door-title">You are leaving Jarvis's guarantees</div>
            <div className="door-text">
              The OpenClaw dashboard controls a general executor that runs outside this
              app: its actions are not mandate-checked and its outcomes are not verified
              by Jarvis. The dashboard opens in your own browser, never in the
              assistant's automation profile.
            </div>
            <div className="ability-actions">
              <button className="approval-button approval-button--approve" onClick={acknowledgeDoor}>
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
          <button className="door-button" onClick={handleDoor}>
            Open OpenClaw dashboard
          </button>
        )}
      </section>
    </div>
  );
}
