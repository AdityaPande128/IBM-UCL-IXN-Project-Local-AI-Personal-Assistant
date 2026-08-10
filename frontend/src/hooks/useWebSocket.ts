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
  const [wakeMode, setWakeModeState] = useState(false);
  const enqueueAudio = useAudioQueue();
  const wsRef = useRef<WebSocket | null>(null);
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
        if (msg.type === "wake_mode_result") {
          setWakeModeState(Boolean(msg.on));
          return;
        }
        if (msg.type === "wake") {
          addMessage("user", msg.command ? `“Hey Jarvis, ${msg.command}”` : "“Hey Jarvis”");
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
  };
}
