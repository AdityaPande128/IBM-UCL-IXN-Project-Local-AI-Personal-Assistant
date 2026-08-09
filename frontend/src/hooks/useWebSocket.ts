import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

type MessageType = "user" | "assistant" | "system" | "error";

interface ChatMessage {
  id: string;
  type: MessageType;
  text: string;
  timestamp: Date;
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

export interface AbilitiesData {
  skills: AbilitySkill[];
  rejected: { skill: string; errors: string[] }[];
  recipes: { name: string; description: string; steps: number | null }[];
  builds: Record<string, any>[];
  tiers: { tier: string; model: string; policy: string }[];
  openclaw: { connected: boolean; dashboard: string };
}

interface UseWebSocketReturn {
  connected: boolean;
  openclawConnected: boolean;
  busy: boolean;
  messages: ChatMessage[];
  activities: ActivityEvent[];
  proposal: Proposal | null;
  abilities: AbilitiesData | null;
  sendBinary: (data: ArrayBuffer) => void;
  sendIntent: (text: string) => void;
  sendDecision: (id: string, decision: "yes" | "no") => void;
  sendAbort: () => void;
  requestAbilities: () => void;
  removeSkill: (name: string) => void;
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
  const enqueueAudio = useAudioQueue();
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const addMessage = useCallback((type: MessageType, text: string) => {
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), type, text, timestamp: new Date() },
    ]);
  }, []);

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
          addMessage(msg.status === "error" ? "error" : "assistant", text);
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

  const removeSkill = useCallback((name: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "skill_remove", name }));
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
    sendBinary,
    sendIntent,
    sendDecision,
    sendAbort,
    requestAbilities,
    removeSkill,
  };
}
