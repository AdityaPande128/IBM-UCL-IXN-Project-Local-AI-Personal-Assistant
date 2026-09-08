import { useEffect, useState } from "react";
import { Pending } from "./Pending";
import { ArmButton } from "./Confirm";
import type {
  BundleResult,
  CheckpointResult,
  PermissionsData,
} from "../hooks/useWebSocket";

interface PermissionsViewProps {
  permissions: PermissionsData | null;
  checkpointResult: CheckpointResult | null;
  bundleResult: BundleResult | null;
  onRefresh: () => void;
  onCreateCheckpoint: () => void;
  onListCheckpoints: () => void;
  onRestoreCheckpoint: (name: string) => void;
  onExportBundle: () => void;
  onImportBundle: (path: string) => void;
  onResolveApproval: (id: number, decision: "yes" | "no") => void;
}

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, {
        day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
      });
}

export function PermissionsView({
  permissions,
  checkpointResult,
  bundleResult,
  onRefresh,
  onCreateCheckpoint,
  onListCheckpoints,
  onRestoreCheckpoint,
  onExportBundle,
  onImportBundle,
  onResolveApproval,
}: PermissionsViewProps) {
  const [importPath, setImportPath] = useState("");

  useEffect(() => {
    onRefresh();
    onListCheckpoints();
  }, [onRefresh, onListCheckpoints]);

  if (!permissions) {
    return (
      <div className="abilities">
        <Pending label="Reading the grants…" onRetry={() => onRefresh()} />
      </div>
    );
  }

  const working =
    checkpointResult?.status === "working" || bundleResult?.status === "working";

  return (
    <div className="abilities">
      <section className="abilities-section">
        <h2>Permissions</h2>
        <div className="diag-note">
          Every line below is read from the store that enforces it. Nothing here
          is a promise — it is what is actually permitted right now.
        </div>
      </section>

      <section className="abilities-section">
        <h2>Skills</h2>
        <div className="diag-note">
          Generated skills run inside a sandbox derived from what they declared
          ({permissions.enforce_mode === "enforce"
            ? "rules are enforced"
            : `${permissions.enforce_mode} mode`}
          {permissions.sandbox_available
            ? ""
            : " — the system sandbox is unavailable on this Mac, so skills run unsandboxed"}),
          and only while their content matches the hash pinned at install.
        </div>
        <div className="build-list">
          {permissions.skills.map((skill) => (
            <div key={skill.name} className="build-row">
              <span className="ability-name">{skill.name}</span>
              <span className="build-meta">
                {skill.author}
                {skill.exec ? " · runs commands" : ""}
                {skill.network ? " · network" : " · no network"}
                {skill.filesystem.length
                  ? ` · writes ${skill.filesystem.join(", ")}`
                  : " · no declared writes"}
                {skill.sandboxed ? " · sandboxed" : ""}
                {skill.pin === "pinned" ? " · pinned" : ""}
                {skill.pin === "unpinned" ? " · pins on first run" : ""}
              </span>
              {skill.pin === "drifted" && (
                <span className="ability-chip ability-chip--bad">drifted — will not run</span>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="abilities-section">
        <h2>Web</h2>
        <div className="build-list">
          {permissions.web.sites.length === 0 ? (
            <div className="abilities-empty">No sites have been granted.</div>
          ) : (
            permissions.web.sites.map((site) => (
              <div key={site.host} className="build-row">
                <span className="ability-name">{site.host}</span>
                <span className="build-meta">
                  {site.label ? `${site.label} · ` : ""}granted {when(site.granted_ts)}
                </span>
              </div>
            ))
          )}
        </div>
        <div className="diag-note">
          Sign-in and payment pages are always refused:{" "}
          {permissions.web.blocked_hosts.join(", ") || "none listed"}. Visible web
          tasks drive {permissions.web.browser}.
        </div>
      </section>

      <section className="abilities-section">
        <h2>Granted folders</h2>
        <div className="build-list">
          {Object.keys(permissions.roots).length === 0 ? (
            <div className="abilities-empty">No folders have been granted.</div>
          ) : (
            Object.entries(permissions.roots).map(([collection, roots]) =>
              roots.map((root) => (
                <div key={`${collection}:${root.path}`} className="build-row">
                  <span className="ability-name">{root.path}</span>
                  <span className="build-meta">
                    {collection} · granted {when(root.granted_ts)}
                  </span>
                </div>
              ))
            )
          )}
        </div>
      </section>

      <section className="abilities-section">
        <h2>Mail and phone</h2>
        <div className="build-list">
          <div className="build-row">
            <span className="ability-name">mail</span>
            <span className="build-meta">
              default: {permissions.mail.default}
              {permissions.mail.accounts.length
                ? ` · accounts: ${permissions.mail.accounts
                    .map((a) => `${a.account} (${a.label})`)
                    .join(", ")}`
                : ""}
            </span>
          </div>
          <div className="build-row">
            <span className="ability-name">telegram</span>
            <span className="build-meta">
              {permissions.channel.telegram.enabled
                ? `bound to chat ${permissions.channel.telegram.bound_chat ?? "(unset)"}`
                : "off"}
              {permissions.channel.telegram.token_present ? " · token on disk" : ""}
            </span>
          </div>
        </div>
      </section>

      <section className="abilities-section">
        <h2>Pending disclosures</h2>
        <div className="diag-note">
          Something the assistant wanted to send outside this Mac and stopped to ask about.
          Approve it and the same request goes through next time; decline and it stays blocked.
        </div>
        {permissions.disclosures.length === 0 ? (
          <div className="diag-note">Nothing is waiting.</div>
        ) : (
          <div className="build-list">
            {permissions.disclosures.map((d) => (
              <div className="build-row" key={d.id}>
                <span className="ability-name">{d.summary}</span>
                <span className="build-meta">
                  {when(d.ts)}{d.destination ? ` · to ${d.destination}` : ""}
                  {d.preview ? ` · ${d.preview.slice(0, 160)}` : ""}
                </span>
                <span className="build-meta">
                  <button className="ob-mini-button" onClick={() => onResolveApproval(d.id, "yes")}>Approve</button>
                  {" "}
                  <button className="ob-mini-button" onClick={() => onResolveApproval(d.id, "no")}>Decline</button>
                </span>
              </div>
            ))}
            {permissions.disclosures_pending > permissions.disclosures.length && (
              <div className="diag-note">
                and {permissions.disclosures_pending - permissions.disclosures.length} more, oldest first; unanswered ones expire after a day
              </div>
            )}
          </div>
        )}
      </section>

      <section className="abilities-section">
        <h2>Snapshots</h2>
        <div className="diag-note">
          A checkpoint is a consistent copy of every store, taken daily and kept
          under a hash manifest. Restoring stages the change and restarts the
          core; the state being replaced is checkpointed first, so a restore can
          always be undone. Secrets — the browser profile, tokens, signing keys —
          are never included.
        </div>
        <div className="diag-row">
          <button className="diag-button" disabled={working} onClick={onCreateCheckpoint}>
            Take a checkpoint now
          </button>
          {checkpointResult?.status === "created" && (
            <span className="diag-path">Checkpoint taken.</span>
          )}
          {checkpointResult?.status === "staged" && (
            <span className="diag-path">
              Restore staged — the core is restarting onto it…
            </span>
          )}
          {checkpointResult?.status === "refused" && (
            <span className="diag-error">{checkpointResult.reason}</span>
          )}
        </div>
        <div className="build-list">
          {(checkpointResult?.checkpoints ?? []).map((entry) => (
            <div key={entry.name} className="build-row">
              <span className="ability-name">{entry.label ?? entry.name}</span>
              <span className="build-meta">
                {when(entry.createdAt)} · {entry.files} {entry.files === 1 ? "file" : "files"}
              </span>
              <ArmButton
                label="Restore"
                confirmLabel="Really restore"
                className="ability-remove"
                disabled={working}
                onConfirm={() => onRestoreCheckpoint(entry.name)}
              />
            </div>
          ))}
        </div>
      </section>

      <section className="abilities-section">
        <h2>Move to another Mac</h2>
        <div className="diag-note">
          Export bundles everything the assistant has learned — memory,
          recipes, generated skills, settings — into one file. Importing on the
          other side verifies every hash before anything is touched.
        </div>
        <div className="diag-row">
          <button className="diag-button" disabled={working} onClick={onExportBundle}>
            Export my state
          </button>
          {bundleResult?.status === "exported" && (
            <span className="diag-path">Saved to {bundleResult.path}</span>
          )}
          {bundleResult?.status === "error" && (
            <span className="diag-error">{bundleResult.reason}</span>
          )}
        </div>
        <div className="diag-row">
          <input
            className="settings-input"
            placeholder="Path to a jarvis-state bundle…"
            value={importPath}
            onChange={(e) => setImportPath(e.target.value)}
          />
          <button
            className="diag-button"
            disabled={working || !importPath.trim()}
            onClick={() => onImportBundle(importPath)}
          >
            Verify and import
          </button>
          {bundleResult?.status === "staged" && (
            <span className="diag-path">
              Verified — the core is restarting onto the imported state…
            </span>
          )}
          {bundleResult?.status === "refused" && (
            <span className="diag-error">{bundleResult.reason}</span>
          )}
        </div>
      </section>
    </div>
  );
}
