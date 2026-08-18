// Thin TS wrapper around the `agents_*` Tauri commands exposed by
// `src-tauri/src/commands/agents.rs`. Rust owns per-session state; the UI
// fetches a snapshot on attach and subscribes to delta events.
//
// No singleton agent here — callers explicitly pick a plugin and spawn.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { AgentId, AgentInfo, AcpSessionId, PermissionDecision } from "@/types/acp";
import type {
  AgentDelta,
  ImageAttachment,
  PluginSpec,
  SessionKey,
  SessionInit,
  SessionMessage,
  SessionSnapshot,
} from "@/types/agents";

/** Mirror of `atlas_acp::AuthMethodWire` — auth methods the ACP adapter
 *  advertised in its `initialize` response. The dialog renders one row
 *  per entry and calls `runAuthMethod(method.id)` on selection. */
export interface AuthMethodWire {
  id: string;
  name: string;
  description: string | null;
  terminalCommand: string | null;
  terminalArgs: string[] | null;
  terminalLabel: string | null;
}

export interface AuthRunDone {
  success: boolean;
  exitCode: number | null;
  message: string | null;
}

export const agents = {
  listPlugins: () => invoke<PluginSpec[]>("agents_list_plugins"),
  listRunning: () => invoke<AgentInfo[]>("agents_list_running"),
  spawn: (pluginId: string) => invoke<AgentInfo>("agents_spawn", { pluginId }),
  kill: (agentId: AgentId) => invoke<void>("agents_kill", { agentId }),

  newSession: (agentId: AgentId, cwd: string) =>
    invoke<SessionInit>("agents_new_session", { agentId, cwd }),
  loadSession: (agentId: AgentId, sessionId: AcpSessionId, cwd: string) =>
    invoke<SessionKey>("agents_load_session", { agentId, sessionId, cwd }),

  /** Read a saved session's transcript straight off disk — no agent spawn, no
   *  `session/load` round-trip. Used to paint a resumed thread immediately
   *  while the real (slow) bind runs concurrently. Resolves to `[]` for agents
   *  with no on-disk transcript (Codex), meaning "no fast path available". */
  replayTranscript: (pluginId: string, sessionId: AcpSessionId, cwd: string) =>
    invoke<SessionMessage[]>("agents_replay_transcript", {
      pluginId,
      sessionId,
      cwd,
    }),

  snapshot: (key: SessionKey) => invoke<SessionSnapshot>("agents_snapshot", { key }),

  /** `snapshot` without the transcript (`messages` arrives empty). The full
   *  snapshot serializes every message across IPC — multi-MB on long sessions —
   *  so every caller that only reads modes/models/commands metadata uses this.
   *  Keep `snapshot` for resume/backfill, which genuinely need messages. */
  snapshotMeta: (key: SessionKey) => invoke<SessionSnapshot>("agents_snapshot_meta", { key }),

  send: (key: SessionKey, text: string, attachments?: ImageAttachment[]) =>
    invoke<void>("agents_send", {
      key,
      text,
      attachments: attachments?.length ? attachments : null,
    }),
  cancel: (key: SessionKey) => invoke<void>("agents_cancel", { key }),
  /** Tear down a session's backend state (actor + driver guard) on tab close
   *  or project switch. Idempotent; fire-and-forget from UI paths. */
  dropSession: (agentId: AgentId, sessionId: AcpSessionId) =>
    invoke<void>("agents_drop_session", { agentId, sessionId }),

  setMode: (key: SessionKey, modeId: string) => invoke<void>("agents_set_mode", { key, modeId }),
  setModel: (key: SessionKey, modelId: string) =>
    invoke<void>("agents_set_model", { key, modelId }),
  setEffort: (key: SessionKey, effort: string) =>
    invoke<void>("agents_set_effort", { key, effort }),
  setCompress: (key: SessionKey, on: boolean) => invoke<void>("agents_set_compress", { key, on }),

  respondPermission: (
    agentId: AgentId,
    sessionId: AcpSessionId,
    requestId: string,
    decision: PermissionDecision,
  ) =>
    invoke<void>("agents_respond_permission", {
      agentId,
      sessionId,
      requestId,
      decision,
    }),

  listAuthMethods: (agentId: AgentId) =>
    invoke<AuthMethodWire[]>("agents_list_auth_methods", { agentId }),
  runAuthMethod: (agentId: AgentId, methodId: string) =>
    invoke<void>("agents_run_auth_method", { agentId, methodId }),
  /** Run an agent's ACP `authenticate` flow (Codex "chatgpt" browser OAuth).
   *  Resolves once sign-in completes. */
  authenticate: (agentId: AgentId, methodId: string) =>
    invoke<void>("agents_authenticate", { agentId, methodId }),
};

/** Whether Codex has stored credentials (`~/.codex/auth.json`). */
export const codexStatus = (): Promise<boolean> => invoke<boolean>("codex_status");

export const listenAuthRunDone = (handler: (p: AuthRunDone) => void): Promise<UnlistenFn> =>
  listen<AuthRunDone>("atlas:auth-run:done", (e) => handler(e.payload));

/**
 * Subscribe to the single multiplexed delta stream. Every delta carries
 * `agent_id` + `session_id` so the consumer can route to the right tab.
 */
export const listenAgents = (handler: (env: AgentDelta) => void): Promise<UnlistenFn> =>
  listen<AgentDelta>("atlas:agents", (e) => handler(e.payload));

// ── Lazy per-agent registry ─────────────────────────────────────────────────
// One shared live process PER pluginId. App.tsx pre-spawns the default so the
// first prompt doesn't pay npx/node cold-start (10–30s); a chat bound to a
// different agent (e.g. Codex) spawns that agent the first time it's used.

/** The coding agents Atlas ships. claude is the default for new chats.
 *  Kept in sync with `PLUGIN_ID_BY_AGENT` in `src/types/agent.ts` — prefer
 *  `pluginIdForAgent(agentType)` over these constants for routing. */
export const DEFAULT_PLUGIN_ID = "claude-code-ts";
export const CODEX_PLUGIN_ID = "codex";
export const OPENCODE_PLUGIN_ID = "opencode";
export const CURSOR_PLUGIN_ID = "cursor";
/** Atlas's native in-process agent (atlas-cersei). */
export const CERSEI_PLUGIN_ID = "cersei";

const agentPromises = new Map<string, Promise<AgentInfo>>();
const cachedAgents = new Map<string, AgentInfo>();

/** Spawn (or reuse) the live agent process for `pluginId`. */
export function ensureAgent(pluginId: string): Promise<AgentInfo> {
  const cached = cachedAgents.get(pluginId);
  if (cached) return Promise.resolve(cached);
  let p = agentPromises.get(pluginId);
  if (!p) {
    p = agents
      .spawn(pluginId)
      .then((info) => {
        cachedAgents.set(pluginId, info);
        return info;
      })
      .catch((e) => {
        // Reset so the next call can retry rather than caching a failure.
        agentPromises.delete(pluginId);
        throw e;
      });
    agentPromises.set(pluginId, p);
  }
  return p;
}

/** Synchronous accessor — `null` until that agent's spawn resolves. Used for
 *  optimistic UI bindings (bind a session id before awaiting the agent). */
export function getAgentSync(pluginId: string): AgentInfo | null {
  return cachedAgents.get(pluginId) ?? null;
}

/** Drop a cached agent (or all) so the next ensure re-spawns. */
/** Reset the spawn cache for whichever plugin owns `agentId` — used when THAT
 *  agent's process dies, so only the dead agent respawns (the old code reset
 *  the default plugin regardless of which agent crashed, leaving a crashed
 *  Codex adapter cached-dead until app restart — H4). */
export function resetAgentByAgentId(agentId: string): void {
  for (const [pluginId, info] of cachedAgents) {
    if (info.agent_id === agentId) {
      cachedAgents.delete(pluginId);
      agentPromises.delete(pluginId);
      return;
    }
  }
}

export function resetAgent(pluginId?: string): void {
  if (pluginId) {
    agentPromises.delete(pluginId);
    cachedAgents.delete(pluginId);
  } else {
    agentPromises.clear();
    cachedAgents.clear();
  }
}

// Back-compat thin wrappers (default = Claude) for existing callers.
export const ensureDefaultAgent = (): Promise<AgentInfo> => ensureAgent(DEFAULT_PLUGIN_ID);
export const getDefaultAgentSync = (): AgentInfo | null => getAgentSync(DEFAULT_PLUGIN_ID);
