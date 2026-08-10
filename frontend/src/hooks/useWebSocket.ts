import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

type MessageType = "user" | "assistant" | "system" | "error";

export interface MessageArtifacts {
  files?: { path: string; name: string; bytes: number }[];
  table?: { columns: string[]; rows: string[][]; total: number };
}

interface ChatMessage {
  id: string;
  type: MessageType;
  text: string;
  timestamp: Date;
  artifacts?: MessageArtifacts;
}

export interface Proposal {
  id: string;
  kind: string;
  request?: string;
  why?: string;
  missing?: string;
  will?: string;
  estimate?: string;
}

export interface ActivityEvent {
  id: string;
  source: string;
  event: string;
  at: number;
  detail: string;
}

export interface AbilitySkill {
  name: string;
  version: string;
  description: string;
  author: string;
  capabilities: { exec?: boolean; network?: boolean; filesystem?: string[] };
}

export interface DiagnosticsResult {
  status: "saving" | "saved" | "error";
  path?: string;
  error?: string;
}

export interface AbilitiesData {
  skills: AbilitySkill[];
  rejected: { skill: string; errors: string[] }[];
  recipes: { name: string; description: string; steps: number | null }[];
  builds: Record<string, any>[];
  tiers: { tier: string; model: string; policy: string }[];
  openclaw: { connected: boolean; dashboard: string };
  browser: { current: string; installed: string[] };
  mail: { current: string; available: { name: string; label: string }[] };
  budget: {
    budget_gb: number | null;
    voice_reserve_gb: number | null;
    measured_gb: Record<string, number>;
  };
}

export interface SettingsUpdate {
  tiers?: Record<string, { model?: string; policy?: string }>;
  desktop_browser?: string;
  mail_provider?: string;
}

export interface SettingsResult {
  status: "applying" | "applied" | "invalid";
  error?: string;
}

export interface BriefNotice {
  id: number;
  watcher_id: string;
  at: number;
  title: string;
  body: string;
  seen: number;
}

export interface BriefDraft {
  id: string;
  kind: string;
  summary?: string;
  who?: string;
  subject?: string;
  goal?: string;
}

export interface BriefApproval {
  id: number;
  ts: string;
  channel: string;
  action: string;
  summary: string;
}

export interface BriefData {
  at: number;
  text: string;
  notices: BriefNotice[];
  proposals: BriefDraft[];
  drafts: BriefDraft[];
  approvals: BriefApproval[];
}

export interface MemoryFact {
  id: string;
  text: string;
  status: string;
  pinned: boolean;
  source: string;
  created_at: number;
  last_recalled_at: number | null;
}

export interface MemoryData {
  facts: MemoryFact[];
  incognito: boolean;
  active: number;
  archived: number;
  superseded: number;
  secure_delete: boolean;
}

export interface WipePreview {
  term: string;
  candidates: MemoryFact[];
}

export interface AuditData {
  since: string;
  generatedAt: string;
  summary: {
    plans: number;
    succeeded: number;
    failed: number;
    decisions: number;
    denied: number;
    approvals: number;
    builds: number;
    notices: number;
  };
  plans: {
    at: string; request: string; goal: string | null; status: string;
    steps: number; surface: string | null; error: string | null;
  }[];
  decisions: {
    at: string; channel: string; action: string; decision: string;
    summary: string | null; destination: string | null;
  }[];
  approvals: {
    at: string; action: string; summary: string; status: string;
    resolvedAt: string | null;
  }[];
  builds: {
    at: string; request: string; outcome: string;
    skill: string | null; failure: string | null;
  }[];
  notices: { at: string; title: string; body: string; seen: boolean }[];
}

export interface PermissionsData {
  generatedAt: string;
  enforce_mode: string;
  sandbox_available: boolean;
  skills: {
    name: string; author: string; exec: boolean; network: boolean;
    filesystem: string[]; sandboxed: boolean;
    pin: "pinned" | "unpinned" | "drifted" | null;
  }[];
  web: {
    sites: { host: string; label: string | null; granted_ts: string }[];
    blocked_hosts: string[];
    browser: string;
    headless: boolean;
  };
  roots: Record<string, { path: string; granted_ts: string }[]>;
  mail: {
    default: string;
    accounts: { account: string; provider: string; label: string }[];
  };
  channel: {
    telegram: { enabled: boolean; bound_chat: string | null; token_present: boolean };
  };
  memory: { incognito: boolean; secure_delete?: boolean };
  sandbox_root: string;
}

export interface CheckpointEntry {
  name: string;
  createdAt: string;
  label: string | null;
  files: number;
}

export interface CheckpointResult {
  status: string;
  name?: string;
  reason?: string;
  restarting?: boolean;
  checkpoints?: CheckpointEntry[];
}

export interface BundleResult {
  status: string;
  path?: string;
  files?: number;
  reason?: string;
  restarting?: boolean;
}

interface UseWebSocketReturn {
  connected: boolean;
  openclawConnected: boolean;
  busy: boolean;
  messages: ChatMessage[];
  activities: ActivityEvent[];
  proposal: Proposal | null;
  abilities: AbilitiesData | null;
  diagnostics: DiagnosticsResult | null;
  settingsResult: SettingsResult | null;
  brief: BriefData | null;
  requestBrief: () => void;
  markNoticesSeen: (ids: number[]) => void;
  memory: MemoryData | null;
  wipePreview: WipePreview | null;
  requestMemory: (status?: string) => void;
  addMemory: (text: string) => void;
  removeMemories: (ids: string[]) => void;
  pinMemory: (id: string, pinned: boolean) => void;
  previewWipe: (term: string) => void;
  clearWipePreview: () => void;
  wipeAllMemory: () => void;
  setIncognito: (on: boolean) => void;
  wakeMode: boolean;
  setWakeMode: (on: boolean) => void;
  sendBinary: (data: ArrayBuffer) => void;
  sendIntent: (text: string) => void;
  sendDecision: (id: string, decision: "yes" | "no") => void;
  sendAbort: () => void;
  requestAbilities: () => void;
  removeSkill: (name: string) => void;
  saveDiagnostics: () => void;
  updateSettings: (update: SettingsUpdate) => void;
  audit: AuditData | null;
  requestAudit: (since?: number) => void;
  permissions: PermissionsData | null;
  requestPermissions: () => void;
  checkpointResult: CheckpointResult | null;
  createCheckpoint: () => void;
  listCheckpoints: () => void;
  restoreCheckpoint: (name: string) => void;
  bundleResult: BundleResult | null;
  exportBundle: () => void;
  importBundle: (path: string) => void;
}

import { config } from "../config";

const WS_URL = `ws://localhost:${config.ports.backend}`;

const ACTIVITY_META = new Set(["type", "source", "event", "at"]);
const MAX_ACTIVITIES = 250;

function summarize(msg: Record<string, unknown>): string {
  return Object.entries(msg)
    .filter(
      ([key, value]) =>
        !ACTIVITY_META.has(key) &&
        (typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean")
    )
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join("  ")
    .slice(0, 200);
}

function useAudioQueue() {
  const contextRef = useRef<AudioContext | null>(null);
  const playheadRef = useRef(0);

  return useCallback(async (data: ArrayBuffer) => {
    if (!contextRef.current) contextRef.current = new AudioContext();
    const ctx = contextRef.current;

    if (ctx.state === "suspended") await ctx.resume().catch(() => {});

    try {
      const buffer = await ctx.decodeAudioData(data);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);

      const startAt = Math.max(ctx.currentTime, playheadRef.current);
      source.start(startAt);
      playheadRef.current = startAt + buffer.duration;
    } catch {
    }
  }, []);
}

export function useWebSocket(): UseWebSocketReturn {
  const [connected, setConnected] = useState(false);
  const [openclawConnected, setOpenclawConnected] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activities, setActivities] = useState<ActivityEvent[]>([]);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [activeIntents, setActiveIntents] = useState<string[]>([]);
  const [abilities, setAbilities] = useState<AbilitiesData | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsResult | null>(null);
  const [settingsResult, setSettingsResult] = useState<SettingsResult | null>(null);
  const [brief, setBrief] = useState<BriefData | null>(null);
  const [memory, setMemory] = useState<MemoryData | null>(null);
  const [wipePreview, setWipePreview] = useState<WipePreview | null>(null);
  const [audit, setAudit] = useState<AuditData | null>(null);
  const [permissions, setPermissions] = useState<PermissionsData | null>(null);
  const [checkpointResult, setCheckpointResult] = useState<CheckpointResult | null>(null);
  const [bundleResult, setBundleResult] = useState<BundleResult | null>(null);
  const [wakeMode, setWakeModeState] = useState(false);
  const enqueueAudio = useAudioQueue();
  const wsRef = useRef<WebSocket | null>(null);
  const memoryStatusRef = useRef<string | undefined>(undefined);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const addMessage = useCallback(
    (type: MessageType, text: string, artifacts?: MessageArtifacts) => {
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), type, text, timestamp: new Date(), artifacts },
      ]);
    },
    []
  );

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(WS_URL);
    ws.binaryType = "arraybuffer";

    ws.onopen = async () => {
      let token: string | null = null;
      try {
        token = await invoke<string>("socket_token", {
          path: config.security?.socket_token_path ?? "",
        });
      } catch {
        token = null;
      }
      if (token && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "auth", token }));
      }
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        enqueueAudio(event.data.slice(0));
        return;
      }

      try {
        const msg = JSON.parse(event.data);

        if (msg.type === "connected") {
          setConnected(true);
          setOpenclawConnected(msg.openclaw || false);
          setSettingsResult(null);
          addMessage("system", msg.message);
          return;
        }
        if (msg.type === "activity") {
          setActivities((prev) => [
            ...prev.slice(-(MAX_ACTIVITIES - 1)),
            {
              id: crypto.randomUUID(),
              source: msg.source ?? "unknown",
              event: msg.event ?? "unknown",
              at: msg.at ?? Date.now(),
              detail: summarize(msg),
            },
          ]);
          if (msg.event === "proposal_approved" || msg.event === "proposal_declined") {
            setProposal((prev) => (prev && prev.id === msg.id ? null : prev));
          }
          return;
        }
        if (msg.type === "stt_result") {
          addMessage("user", msg.text);
          return;
        }
        if (msg.type === "llm_result") {
          addMessage("assistant", msg.text);
          return;
        }
        if (msg.type === "pipeline_complete") {
          return;
        }
        if (msg.type === "pipeline_error") {
          addMessage("error", msg.error);
          return;
        }
        if (msg.type === "state_sync") {
          return;
        }
        if (msg.type === "intent_accepted") {
          setActiveIntents((prev) => [...prev, msg.id]);
          return;
        }
        if (msg.type === "abilities_result") {
          const { type: _ignored, ...data } = msg;
          setAbilities(data as AbilitiesData);
          return;
        }
        if (msg.type === "brief_result") {
          const { type: _ignored, ...data } = msg;
          setBrief(data as BriefData);
          return;
        }
        if (msg.type === "notices_seen_result") {
          return;
        }
        if (msg.type === "memory_result") {
          const { type: _ignored, ...data } = msg;
          setMemory(data as MemoryData);
          return;
        }
        if (msg.type === "memory_add_result") {
          if (msg.status === "refused" && msg.response) {
            addMessage("system", msg.response);
          }
          wsRef.current?.send(
            JSON.stringify({ type: "memory", status: memoryStatusRef.current })
          );
          return;
        }
        if (msg.type === "memory_remove_result" || msg.type === "memory_wipe_all_result") {
          setWipePreview(null);
          wsRef.current?.send(
            JSON.stringify({ type: "memory", status: memoryStatusRef.current })
          );
          return;
        }
        if (msg.type === "memory_pin_result") {
          const fact = msg.fact as MemoryFact | null;
          if (fact) {
            setMemory((prev) =>
              prev
                ? { ...prev, facts: prev.facts.map((f) => (f.id === fact.id ? fact : f)) }
                : prev
            );
          }
          return;
        }
        if (msg.type === "memory_wipe_result") {
          setWipePreview({ term: msg.term, candidates: msg.candidates ?? [] });
          return;
        }
        if (msg.type === "incognito_result") {
          const { type: _ignored, ...counts } = msg;
          setMemory((prev) => (prev ? { ...prev, ...counts } : prev));
          return;
        }
        if (msg.type === "wake_mode_result") {
          setWakeModeState(Boolean(msg.on));
          return;
        }
        if (msg.type === "wake") {
          addMessage("user", msg.command ? `“Hey Jarvis, ${msg.command}”` : "“Hey Jarvis”");
          return;
        }
        if (msg.type === "audit_result") {
          const { type: _ignored, ...data } = msg;
          setAudit(data as AuditData);
          return;
        }
        if (msg.type === "permissions_result") {
          const { type: _ignored, ...data } = msg;
          setPermissions(data as PermissionsData);
          return;
        }
        if (msg.type === "checkpoint_result") {
          const { type: _ignored, ...data } = msg;
          setCheckpointResult(data as CheckpointResult);
          return;
        }
        if (msg.type === "bundle_export_result" || msg.type === "bundle_import_result") {
          const { type: _ignored, ...data } = msg;
          setBundleResult(data as BundleResult);
          return;
        }
        if (msg.type === "diagnostics_result") {
          setDiagnostics({ status: msg.status, path: msg.path, error: msg.error });
          return;
        }
        if (msg.type === "settings_update_result") {
          setSettingsResult({ status: msg.status, error: msg.error });
          return;
        }
        if (msg.type === "skill_remove_result") {
          if (msg.status !== "removed" && msg.response) {
            addMessage("system", msg.response);
          }
          wsRef.current?.send(JSON.stringify({ type: "abilities" }));
          return;
        }
        if (msg.type === "abort_result") {
          return;
        }
        if (msg.type === "intent_result") {
          if (msg.id) setActiveIntents((prev) => prev.filter((id) => id !== msg.id));
          if (msg.status === "needs_approval" && msg.proposal) {
            setProposal(msg.proposal);
          }
          const text = msg.response ?? msg.error ?? "No response.";
          addMessage(msg.status === "error" ? "error" : "assistant", text, msg.artifacts);
          return;
        }
      } catch {
        addMessage("system", event.data);
      }
    };

    ws.onclose = () => {
      setConnected(false);
      setOpenclawConnected(false);
      setProposal(null);
      setActiveIntents([]);
      reconnectTimer.current = setTimeout(connect, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };

    wsRef.current = ws;
  }, [addMessage, enqueueAudio]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const sendBinary = useCallback((data: ArrayBuffer) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data);
    }
  }, []);

  const sendIntent = useCallback(
    (text: string) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "intent", text }));
        addMessage("user", text);
      }
    },
    [addMessage]
  );

  const sendDecision = useCallback(
    (id: string, decision: "yes" | "no") => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "approval", id, decision }));
        setProposal(null);
        addMessage("user", decision === "yes" ? "Approved." : "Declined.");
      }
    },
    [addMessage]
  );

  const sendAbort = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "abort" }));
    }
  }, []);

  const requestAbilities = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "abilities" }));
    }
  }, []);

  const requestBrief = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "brief" }));
    }
  }, []);

  const setWakeMode = useCallback((on: boolean) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "wake_mode", on }));
    }
  }, []);

  const requestMemory = useCallback((status?: string) => {
    memoryStatusRef.current = status;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "memory", ...(status ? { status } : {}) }));
    }
  }, []);

  const addMemory = useCallback((text: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN && text.trim()) {
      wsRef.current.send(JSON.stringify({ type: "memory_add", text: text.trim() }));
    }
  }, []);

  const removeMemories = useCallback((ids: string[]) => {
    if (wsRef.current?.readyState === WebSocket.OPEN && ids.length) {
      wsRef.current.send(JSON.stringify({ type: "memory_remove", ids }));
    }
  }, []);

  const pinMemory = useCallback((id: string, pinned: boolean) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "memory_pin", id, pinned }));
    }
  }, []);

  const previewWipe = useCallback((term: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN && term.trim()) {
      wsRef.current.send(JSON.stringify({ type: "memory_wipe", term: term.trim() }));
    }
  }, []);

  const clearWipePreview = useCallback(() => {
    setWipePreview(null);
  }, []);

  const wipeAllMemory = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "memory_wipe_all", confirm: true }));
    }
  }, []);

  const setIncognito = useCallback((on: boolean) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "incognito", on }));
    }
  }, []);

  const markNoticesSeen = useCallback((ids: number[]) => {
    if (wsRef.current?.readyState === WebSocket.OPEN && ids.length) {
      wsRef.current.send(JSON.stringify({ type: "notices_seen", ids }));
      setBrief((prev) =>
        prev
          ? { ...prev, notices: prev.notices.filter((n) => !ids.includes(n.id)) }
          : prev
      );
    }
  }, []);

  const removeSkill = useCallback((name: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "skill_remove", name }));
    }
  }, []);

  const saveDiagnostics = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      setDiagnostics({ status: "saving" });
      wsRef.current.send(JSON.stringify({ type: "diagnostics" }));
    }
  }, []);

  const updateSettings = useCallback((update: SettingsUpdate) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      setSettingsResult({ status: "applying" });
      wsRef.current.send(JSON.stringify({ type: "settings_update", ...update }));
    }
  }, []);

  const requestAudit = useCallback((since?: number) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "audit", ...(since ? { since } : {}) }));
    }
  }, []);

  const requestPermissions = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "permissions" }));
    }
  }, []);

  const createCheckpoint = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      setCheckpointResult({ status: "working" });
      wsRef.current.send(JSON.stringify({ type: "checkpoint", action: "create" }));
    }
  }, []);

  const listCheckpoints = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "checkpoint", action: "list" }));
    }
  }, []);

  const restoreCheckpoint = useCallback((name: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      setCheckpointResult({ status: "working" });
      wsRef.current.send(JSON.stringify({ type: "checkpoint", action: "restore", name }));
    }
  }, []);

  const exportBundle = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      setBundleResult({ status: "working" });
      wsRef.current.send(JSON.stringify({ type: "bundle_export" }));
    }
  }, []);

  const importBundle = useCallback((path: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN && path.trim()) {
      setBundleResult({ status: "working" });
      wsRef.current.send(JSON.stringify({ type: "bundle_import", path: path.trim() }));
    }
  }, []);

  return {
    connected,
    openclawConnected,
    busy: activeIntents.length > 0,
    messages,
    activities,
    proposal,
    abilities,
    diagnostics,
    settingsResult,
    brief,
    requestBrief,
    markNoticesSeen,
    memory,
    wipePreview,
    requestMemory,
    addMemory,
    removeMemories,
    pinMemory,
    previewWipe,
    clearWipePreview,
    wipeAllMemory,
    setIncognito,
    wakeMode,
    setWakeMode,
    sendBinary,
    sendIntent,
    sendDecision,
    sendAbort,
    requestAbilities,
    removeSkill,
    saveDiagnostics,
    updateSettings,
    audit,
    requestAudit,
    permissions,
    requestPermissions,
    checkpointResult,
    createCheckpoint,
    listCheckpoints,
    restoreCheckpoint,
    bundleResult,
    exportBundle,
    importBundle,
  };
}
