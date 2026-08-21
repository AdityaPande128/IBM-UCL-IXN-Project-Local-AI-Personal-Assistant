import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

type MessageType = "user" | "assistant" | "system" | "error";

export interface MessageArtifacts {
  files?: { path: string; name: string; bytes: number; id?: string }[];
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
  catalog?: CatalogData;
  profile?: ProfileData;
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
  preview?: string | null;
}

export interface BriefData {
  at: number;
  text: string;
  notices: BriefNotice[];
  proposals: BriefDraft[];
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

export interface ProfileData {
  name: string;
  mode: "jarvis" | "openclaw";
  theme: "dark" | "light" | "system";
  improvement: boolean;
  voice: { enabled: boolean; tts: boolean; voice?: string };
  avatar: string;
  onboarded: boolean;
}

export interface CatalogModel {
  model: string;
  label: string;
  ram_gb: number;
  disk_gb: number;
  blurb?: string;
  downloaded: boolean;
  recommended: boolean;
}

export interface VoiceModel {
  model: string;
  label: string;
  disk_gb: number;
  downloaded: boolean;
}

export interface CatalogData {
  machine: { total_gb: number; class: number | null; free_disk_gb: number | null };
  budget_gb: number | null;
  voice_reserve_gb: number | null;
  engines: CatalogModel[];
  smiths: CatalogModel[];
  voice: { stt: VoiceModel | null; tts: VoiceModel | null };
}

export interface DownloadJob {
  model: string;
  kind: string;
  status: "queued" | "downloading" | "done" | "stopped" | "error";
  received_bytes: number;
  total_bytes: number | null;
  error: string | null;
}

export interface DownloadsData {
  active: string | null;
  queue: DownloadJob[];
}

export interface OnboardingData {
  profile: ProfileData;
  catalog: CatalogData;
  downloads: DownloadsData;
  voice_ready: boolean;
}

export interface OnboardingApplyPayload {
  name: string;
  theme: "dark" | "light" | "system";
  mode: "jarvis" | "openclaw";
  improvement: boolean;
  engine: string;
  smith?: string | null;
  voice: { enabled: boolean; tts: boolean; voice?: string };
}

export interface OnboardingApplyResult {
  status: string;
  error?: string;
  restarting?: boolean;
}

export interface ProfileUpdate {
  name?: string;
  mode?: "jarvis" | "openclaw";
  theme?: "dark" | "light" | "system";
  improvement?: boolean;
  voice?: { enabled?: boolean; tts?: boolean; voice?: string };
  avatar?: string;
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

export interface ChannelStatus {
  enabled: boolean;
  running: boolean;
  paired: boolean;
  has_token: boolean;
  pairing_code: string | null;
  error?: string;
}

export interface ConversationSummary {
  id: number;
  title: string;
  updated_at: string;
  messages: number;
}

interface UseWebSocketReturn {
  connected: boolean;
  channel: ChannelStatus | null;
  requestChannel: () => void;
  setChannelToken: (token: string) => void;
  clearChannel: () => void;
  conversations: ConversationSummary[];
  activeConversation: number | null;
  profileError: string | null;
  selectConversation: (id: number | null) => void;
  deleteConversation: (id: number) => void;
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
  resolveApproval: (id: number, decision: "yes" | "no") => void;
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
  wakeHeardAt: number | null;
  reportClientError: (text: string, quiet?: boolean) => void;
  setWakeMode: (on: boolean) => void;
  sendBinary: (data: ArrayBuffer) => void;
  sendIntent: (text: string) => void;
  sendDecision: (id: string, decision: "yes" | "no") => void;
  saveFile: (id: string, name: string, to: "downloads" | "ask") => void;
  savedFile: { path: string; at: number } | null;
  saveError: { text: string; at: number } | null;
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
  onboarding: OnboardingData | null;
  downloads: DownloadsData | null;
  voiceReady: boolean;
  onboardingApply: OnboardingApplyResult | null;
  requestOnboarding: () => void;
  applyOnboarding: (payload: OnboardingApplyPayload) => void;
  completeOnboarding: (fresh?: boolean) => void;
  updateProfile: (update: ProfileUpdate) => void;
  downloadAction: (action: "start" | "stop" | "status", model?: string) => void;
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
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [channel, setChannel] = useState<ChannelStatus | null>(null);
  const [activeConversation, setActiveConversation] = useState<number | null>(null);
  const activeConversationRef = useRef<number | null>(null);
  useEffect(() => {
    activeConversationRef.current = activeConversation;
  }, [activeConversation]);
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
  const [onboarding, setOnboarding] = useState<OnboardingData | null>(null);
  const [downloads, setDownloads] = useState<DownloadsData | null>(null);
  const [voiceReady, setVoiceReady] = useState(false);
  const [onboardingApply, setOnboardingApply] = useState<OnboardingApplyResult | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [savedFile, setSavedFile] = useState<{ path: string; at: number } | null>(null);
  const [saveError, setSaveError] = useState<{ text: string; at: number } | null>(null);
  const [wakeMode, setWakeModeState] = useState(false);
  const [wakeHeardAt, setWakeHeardAt] = useState<number | null>(null);
  const [remoteBusy, setRemoteBusy] = useState(false);
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
        // Outside the Tauri shell (dev preview) the token file is unreachable;
        // the dev server reads it fresh so daemon restarts do not strand us.
        token = import.meta.env.DEV
          ? await fetch("/__socket-token").then((r) => (r.ok ? r.text() : null)).catch(() => null)
          : null;
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
          // The profile decides whether the app opens into onboarding, so it
          // is fetched on every (re)connect rather than on demand.
          ws.send(JSON.stringify({ type: "onboarding" }));
          ws.send(JSON.stringify({ type: "conversations_list" }));
          ws.send(JSON.stringify({ type: "brief" }));
          // The daemon's side of "which conversation is open" died with the
          // old socket; re-select or the next message starts a new one.
          if (activeConversationRef.current !== null) {
            ws.send(JSON.stringify({ type: "conversation_select", id: activeConversationRef.current }));
          }
          return;
        }
        if (msg.type === "onboarding_result") {
          const { type: _ignored, ...data } = msg;
          setOnboarding(data as OnboardingData);
          setDownloads((data as OnboardingData).downloads);
          setVoiceReady(Boolean(msg.voice_ready));
          return;
        }
        if (msg.type === "onboarding_apply_result") {
          setOnboardingApply({
            status: msg.status,
            error: msg.error,
            restarting: msg.restarting,
          });
          return;
        }
        if (msg.type === "onboarding_complete_result" || msg.type === "profile_update_result") {
          if (msg.status === "applied" && msg.profile) {
            setProfileError(null);
            setOnboarding((prev) =>
              prev ? { ...prev, profile: msg.profile as ProfileData } : prev
            );
          } else if (msg.status === "invalid") {
            setProfileError(msg.error ?? "That change was not accepted.");
          }
          return;
        }
        if (msg.type === "file_save_result") {
          if (msg.status === "saved" && msg.path) {
            setSavedFile({ path: msg.path as string, at: Date.now() });
          } else if (msg.status === "error") {
            // A failed save must say so; a button that does nothing reads
            // as a dead button.
            setSaveError({
              text: msg.error ?? "The file could not be saved.",
              at: Date.now(),
            });
          }
          return;
        }
        if (msg.type === "profile_changed" && msg.profile) {
          // Another surface (the phone) changed the shared profile; the
          // settings radios here must follow, not sit on the stale choice.
          setOnboarding((prev) =>
            prev
              ? { ...prev, profile: { ...prev.profile, ...msg.profile } }
              : prev
          );
          return;
        }
        if (msg.type === "download_status") {
          setDownloads({ active: msg.active ?? null, queue: msg.queue ?? [] });
          setVoiceReady(Boolean(msg.voice_ready));
          return;
        }
        if (msg.type === "download_progress" && msg.job) {
          const job = msg.job as DownloadJob;
          setDownloads((prev) => {
            const queue = prev?.queue ?? [];
            const known = queue.some((j) => j.model === job.model);
            return {
              active: job.status === "downloading" ? job.model
                : prev?.active === job.model ? null : prev?.active ?? null,
              queue: known
                ? queue.map((j) => (j.model === job.model ? job : j))
                : [...queue, job],
            };
          });
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
        if (msg.type === "channel_status_result") {
          setChannel({
            enabled: msg.enabled, running: msg.running, paired: msg.paired,
            has_token: msg.has_token, pairing_code: msg.pairing_code ?? null,
            ...(msg.error ? { error: msg.error } : {}),
          });
          return;
        }
        if (msg.type === "conversations_result") {
          setConversations(msg.conversations ?? []);
          return;
        }
        if (msg.type === "conversation_started") {
          setActiveConversation(msg.id);
          setConversations((prev) => [
            { id: msg.id, title: msg.title, updated_at: new Date().toISOString(), messages: 1 },
            ...prev.filter((c) => c.id !== msg.id),
          ]);
          return;
        }
        if (msg.type === "conversation_event") {
          // Another surface is talking; this window keeps up without ever
          // hearing its own words back (the daemon excludes the origin).
          if (msg.kind === "started") {
            setConversations((prev) => [
              {
                id: msg.conversation.id,
                title: msg.conversation.title ?? "New chat",
                updated_at: new Date().toISOString(),
                messages: 1,
              },
              ...prev.filter((c) => c.id !== msg.conversation.id),
            ]);
          }
          if (msg.kind === "message") {
            setConversations((prev) => {
              const hit = prev.find((c) => c.id === msg.conversation.id);
              if (!hit) return prev;
              return [
                { ...hit, updated_at: new Date().toISOString() },
                ...prev.filter((c) => c.id !== msg.conversation.id),
              ];
            });
          }
          if (
            (msg.kind === "started" || msg.kind === "message") &&
            msg.message &&
            activeConversationRef.current === msg.conversation.id
          ) {
            addMessage(msg.message.role, msg.message.text, msg.message.artifacts);
          }
          if (msg.kind === "proposal" && msg.proposal) {
            setProposal(msg.proposal);
          }
          if (msg.kind === "busy" && activeConversationRef.current === msg.conversation.id) {
            setRemoteBusy(!!msg.busy);
          }
          return;
        }
        if (msg.type === "conversation_messages") {
          setActiveConversation(msg.id ?? null);
          setRemoteBusy(false);
          setMessages(
            (msg.messages ?? []).map(
              (row: { ts: string; role: string; text: string; artifacts?: MessageArtifacts }, i: number) => ({
                id: `hist-${msg.id}-${i}`,
                type: row.role as ChatMessage["type"],
                text: row.text,
                timestamp: new Date(row.ts),
                artifacts: row.artifacts,
              })
            )
          );
          return;
        }
        if (msg.type === "conversation_delete_result") {
          setConversations(msg.conversations ?? []);
          setActiveConversation((prev) => {
            if (prev === msg.id) {
              setMessages([]);
              return null;
            }
            return prev;
          });
          return;
        }
        if (msg.type === "stt_result") {
          addMessage("user", msg.text);
          return;
        }
        if (msg.type === "pipeline_complete") {
          return;
        }
        if (msg.type === "pipeline_error") {
          addMessage("error", msg.error);
          return;
        }
        if (msg.type === "error") {
          addMessage("error", msg.error);
          return;
        }
        if (msg.type === "speech_unavailable") {
          addMessage("system", msg.message);
          return;
        }
        if (msg.type === "egress_resolve_result") {
          addMessage(
            "system",
            msg.allowed
              ? "Approved — ask for it again and it will go through."
              : `Declined — ${msg.reason ?? "that disclosure stays blocked"}.`
          );
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: "brief" }));
          }
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
        if (msg.type === "proposal_taken") {
          setProposal((prev) => (prev && prev.id === msg.id ? null : prev));
          return;
        }
        if (msg.type === "system_note") {
          addMessage("system", String(msg.text ?? ""));
          return;
        }
        if (msg.type === "wake") {
          setWakeHeardAt(Date.now());
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
          setActiveIntents((prev) => (msg.id ? prev.filter((id) => id !== msg.id) : []));
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

  const sendDecision = useCallback((id: string, decision: "yes" | "no") => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "approval", id, decision }));
      setProposal(null);
    }
  }, []);

  const saveFile = useCallback(
    (id: string, name: string, to: "downloads" | "ask") => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "file_save", id, name, to }));
      }
    },
    []
  );

  const requestChannel = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "channel_status" }));
    }
  }, []);

  const setChannelToken = useCallback((token: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "channel_set_token", token }));
    }
  }, []);

  const clearChannel = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "channel_clear" }));
    }
  }, []);

  const selectConversation = useCallback((id: number | null) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "conversation_select", id }));
    }
  }, []);

  const deleteConversation = useCallback((id: number) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "conversation_delete", id }));
    }
  }, []);

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

  const resolveApproval = useCallback((id: number, decision: "yes" | "no") => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "egress_resolve", id, decision }));
    }
  }, []);

  const requestBrief = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "brief" }));
    }
  }, []);

  const reportClientError = useCallback((text: string, quiet = false) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "client_log", text, quiet }));
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

  const requestOnboarding = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "onboarding" }));
    }
  }, []);

  const applyOnboarding = useCallback((payload: OnboardingApplyPayload) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      setOnboardingApply({ status: "applying" });
      wsRef.current.send(JSON.stringify({ type: "onboarding_apply", ...payload }));
    }
  }, []);

  const completeOnboarding = useCallback((fresh: boolean = true) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "onboarding_complete", fresh }));
    }
  }, []);

  const updateProfile = useCallback((update: ProfileUpdate) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "profile_update", ...update }));
    }
  }, []);

  const downloadAction = useCallback(
    (action: "start" | "stop" | "status", model?: string) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({ type: "download", action, ...(model ? { model } : {}) })
        );
      }
    },
    []
  );

  return {
    connected,
    channel,
    requestChannel,
    setChannelToken,
    clearChannel,
    conversations,
    activeConversation,
    profileError,
    selectConversation,
    deleteConversation,
    openclawConnected,
    busy: activeIntents.length > 0 || remoteBusy,
    messages,
    activities,
    proposal,
    abilities,
    diagnostics,
    settingsResult,
    brief,
    requestBrief,
    resolveApproval,
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
    wakeHeardAt,
    reportClientError,
    setWakeMode,
    sendBinary,
    sendIntent,
    sendDecision,
    saveFile,
    savedFile,
    saveError,
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
    onboarding,
    downloads,
    voiceReady,
    onboardingApply,
    requestOnboarding,
    applyOnboarding,
    completeOnboarding,
    updateProfile,
    downloadAction,
  };
}
