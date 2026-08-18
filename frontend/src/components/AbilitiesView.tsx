import { useEffect } from "react";
import { ArmButton } from "./Confirm";
import type { AbilitiesData } from "../hooks/useWebSocket";

interface AbilitiesViewProps {
  abilities: AbilitiesData | null;
  onRefresh: () => void;
  onRemoveSkill: (name: string) => void;
}

export function AbilitiesView({ abilities, onRefresh, onRemoveSkill }: AbilitiesViewProps) {
  useEffect(() => {
    onRefresh();
  }, [onRefresh]);

  if (!abilities) {
    return (
      <div className="abilities">
        <div className="abilities-empty">Loading skills…</div>
      </div>
    );
  }

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
                  <ArmButton
                    label="Remove"
                    confirmLabel="Really remove"
                    className="ability-remove"
                    onConfirm={() => onRemoveSkill(skill.name)}
                  />
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
    </div>
  );
}
