import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { config } from "../config";

export interface ServiceStatus {
  name: string;
  status: string;
  restarts: number;
}

const LABELS: Record<string, string> = {
  backend: "the assistant's core",
  inference: "the local models",
};

export function serviceBanner(services: Record<string, ServiceStatus>): string | null {
  const bad = Object.values(services).filter(
    (s) => s.status !== "running" && s.status !== "external"
  );
  if (bad.length === 0) return null;

  const worst = bad[0];
  const label = LABELS[worst.name] ?? worst.name;
  let text;
  if (worst.status === "starting") {
    text = `Starting ${label}…`;
  } else if (worst.status === "restarting") {
    text = `${label} stopped — restarting${worst.restarts > 1 ? ` (attempt ${worst.restarts})` : ""}…`;
  } else {
    text = `${label} could not be started. Check that its runtime is installed.`;
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function useServices(): Record<string, ServiceStatus> {
  const [services, setServices] = useState<Record<string, ServiceStatus>>({});

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      try {
        unlisten = await listen<ServiceStatus>("service-status", (event) => {
          const s = event.payload;
          setServices((prev) => ({ ...prev, [s.name]: s }));
        });
        if (cancelled) return;

        const ports = config.ports as Record<string, number>;
        const specs = Object.entries(config.services ?? {})
          .map(([name, spec]) => ({ name, argv: spec.argv, cwd: spec.cwd, port: ports[name] }))
          .filter((spec) => typeof spec.port === "number");
        if (specs.length) await invoke("start_services", { specs });
      } catch {
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return services;
}
