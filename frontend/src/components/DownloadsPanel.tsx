import type { DownloadJob, DownloadsData } from "../hooks/useWebSocket";

function gb(bytes: number | null | undefined): string {
  if (!bytes) return "0.0";
  return (bytes / 1024 ** 3).toFixed(1);
}

export function downloadsPending(downloads: DownloadsData | null): boolean {
  return Boolean(downloads && downloads.queue.length
    && downloads.queue.some((j) => j.status !== "done"));
}

export function downloadsPercent(downloads: DownloadsData | null): number | null {
  if (!downloads) return null;
  const sized = downloads.queue.filter((j) => j.total_bytes);
  if (!sized.length) return null;
  const total = sized.reduce((a, j) => a + (j.total_bytes ?? 0), 0);
  const received = sized.reduce(
    (a, j) => a + (j.status === "done" ? (j.total_bytes ?? 0) : j.received_bytes), 0);
  return Math.min(100, Math.round((received / total) * 100));
}

interface DownloadsPanelProps {
  downloads: DownloadsData;
  onAction: (action: "start" | "stop" | "status", model?: string) => void;
  onChangeModel: () => void;
}

export function DownloadsPanel({ downloads, onAction, onChangeModel }: DownloadsPanelProps) {
  const row = (job: DownloadJob) => {
    const pct = job.status === "done"
      ? 100
      : job.total_bytes
        ? Math.min(99, Math.round((job.received_bytes / job.total_bytes) * 100))
        : 0;
    return (
      <div key={job.model} className="ob-download-row">
        <div className="ob-download-head">
          <span className="ob-download-name">{job.model.split("/").pop()}</span>
          <span className={`ob-download-state ob-download-state--${job.status}`}>
            {job.status === "done" ? "downloaded"
              : job.status === "error" ? `failed: ${job.error ?? "unknown"}`
              : job.status === "stopped" ? "paused"
              : job.status === "downloading"
                ? `${gb(job.received_bytes)} / ${job.total_bytes ? gb(job.total_bytes) : "?"} GB`
              : "waiting…"}
          </span>
          {(job.status === "downloading" || job.status === "queued") && (
            <button className="ob-mini-button" onClick={() => onAction("stop", job.model)}>
              Pause
            </button>
          )}
          {(job.status === "stopped" || job.status === "error") && (
            <button className="ob-mini-button" onClick={() => onAction("start", job.model)}>
              Resume
            </button>
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
  };

  return (
    <div className="downloads-panel">
      <div className="downloads-panel-title">Model downloads</div>
      {downloads.queue.map(row)}
      <button className="ob-mini-button downloads-panel-change" onClick={onChangeModel}>
        Change models in settings
      </button>
    </div>
  );
}
