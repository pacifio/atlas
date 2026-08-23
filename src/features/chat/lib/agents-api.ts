// Thin TS wrapper around the `agents_*` Tauri commands exposed by
// `src-tauri/src/commands/agents.rs`. Rust owns per-session state; the UI
// fetches a snapshot on attach and subscribes to delta events.
//
// No singleton agent here — callers explicitly pick a plugin and spawn.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { AgentId, AgentInfo, AcpSessionId, PermissionDecision } from "@/types/acp";
import type { AgentCatalog, CatalogChangeReason } from "@/types/agent-catalog";
import type {
  AgentDelta,
  ImageAttachment,
  SessionKey,
  SessionInit,
  SessionMessage,
  SessionSnapshot,
} from "@/types/agents";

/** Mirror of `atlas_acp::AuthMethodWire` — auth methods the ACP adapter
 *  advertised in its `initialize` response. The dialog renders one row
 *  per entry and calls `runAuthMethod(method.id)` on selection. */
/** How the client satisfies one auth method. Mirrors Rust `AuthMethodKind`. */
export type AuthMethodKind = "agent" | "env_var" | "terminal";

export interface AuthEnvVar {
  name: string;
  label: string | null;
  secret: boolean;
  optional: boolean;
}

export interface AuthMethodWire {
  id: string;
  name: string;
  description: string | null;
  /** Absent `type` on the wire means `agent` — Rust already normalised that. */
  kind: AuthMethodKind;
  /** `env_var` methods: variables the user must export. */
  envVars?: AuthEnvVar[];
  /** Where to obtain the credential (`env_var` methods). */
  link: string | null;
  /** Typed `terminal.args` — relative to the agent's own binary, so NOT
   *  runnable on their own; `terminalCommand` is what can actually be exec'd. */
  args?: string[];
  terminalCommand: string | null;
  terminalArgs: string[] | null;
  terminalLabel: string | null;
  /** Codex's proprietary `_meta["api-key"].provider` hint — the only api-key
   *  signal any adapter ships today, so it drives the same env checklist a
   *  typed `env_var` method would. */
  apiKeyProvider: string | null;
}

/** One env var an auth method wants, and whether the system already has it.
 *  Never carries the value. */
export interface AuthEnvStatus {
  methodId: string;
  name: string;
  label: string | null;
  optional: boolean;
  satisfied: boolean;
  source: "process-env" | "shell-env" | null;
}

export interface AuthRunDone {
  success: boolean;
  exitCode: number | null;
  message: string | null;
  /** Which run this belongs to. Two agents signing in at once previously
   *  cross-talked, because every listener resolved on ANY `:done`. */
  agentId: string;
  runId: string;
}

export interface AuthRunProgress {
  agentId: string;
  runId: string;
  stream: "stdout" | "stderr";
  line: string;
  /** First `https://` URL on the line, when the CLI printed one. */
  url: string | null;
}

export const agents = {
  /** The unified agent catalog — identity, availability and login for every
   *  agent, from one backend answer. Instant (served from memory); supersedes
   *  assembling identity from a plugin list + the registry listing + static
   *  tables. Subscribe to `atlas:agent-catalog:changed` to know when to
   *  re-invoke. */
  catalog: () => invoke<AgentCatalog>("agents_catalog"),
  /** Re-fetch the manifest and re-probe the system, then answer fresh. The
   *  escape hatch after installing a CLI by hand mid-session. */
  refreshCatalog: (force = true) => invoke<AgentCatalog>("agents_catalog_refresh", { force }),
  listRunning: () => invoke<AgentInfo[]>("agents_list_running"),
  spawn: (pluginId: string) => invoke<AgentInfo>("agents_spawn", { pluginId }),
  kill: (agentId: AgentId) => invoke<void>("agents_kill", { agentId }),

  /** `additionalDirectories` are extra workspace roots (P3.2). Fixed for the
   *  session's life, so they must be passed here rather than inferred later;
   *  only reach agents that advertised the capability. */
  newSession: (agentId: AgentId, cwd: string, additionalDirectories?: string[]) =>
    invoke<SessionInit>("agents_new_session", {
      agentId,
      cwd,
      additionalDirectories: additionalDirectories?.length ? additionalDirectories : null,
    }),
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

  send: (
    key: SessionKey,
    text: string,
    attachments?: ImageAttachment[],
    /** `@`-mentioned files, sent as ACP `ResourceLink` blocks (P2.1). */
    resourceLinks?: { uri: string; name: string }[],
  ) =>
    invoke<void>("agents_send", {
      key,
      text,
      attachments: attachments?.length ? attachments : null,
      resourceLinks: resourceLinks?.length ? resourceLinks : null,
    }),
  cancel: (key: SessionKey) => invoke<void>("agents_cancel", { key }),
  /** Answer an elicitation the agent raised (P3.3). */
  respondElicitation: (
    agentId: AgentId,
    requestId: string,
    action: "accept" | "decline" | "cancel",
    content?: Record<string, unknown>,
  ) => invoke<void>("agents_respond_elicitation", { agentId, requestId, action, content }),
  /** Branch a session from its current state (P3.4). Null when unsupported. */
  forkSession: (key: SessionKey) => invoke<string | null>("agents_fork_session", { key }),
  /** Set any agent-advertised config option (P2.2). `value` is a bool for
   *  boolean options, or the option-value id for select options. */
  setConfigOption: (key: SessionKey, configId: string, value: boolean | string) =>
    invoke<void>("agents_set_config_option", { key, configId, value }),
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
  /** Spawns the login subprocess and resolves with its `runId` — completion
   *  arrives later on `atlas:auth-run:done` carrying the same id. */
  runAuthMethod: (agentId: AgentId, methodId: string) =>
    invoke<string>("agents_run_auth_method", { agentId, methodId }),
  /** Which env vars this agent's auth methods need, and which are already
   *  satisfied by the system environment. Values are never returned. */
  authEnvStatus: (agentId: AgentId) =>
    invoke<AuthEnvStatus[]>("agents_auth_env_status", { agentId }),
  /** Run an agent's ACP `authenticate` flow (Codex "chatgpt" browser OAuth).
   *  Resolves once sign-in completes. */
  authenticate: (agentId: AgentId, methodId: string) =>
    invoke<void>("agents_authenticate", { agentId, methodId }),
  /** ACP `logout` — the agent drops its OWN credentials. Only offered when it
   *  advertised `auth.logout`; Atlas stores nothing to clear itself. */
  logout: (agentId: AgentId) => invoke<void>("agents_logout", { agentId }),
};

/** `runId` scopes the subscription; omit it only for diagnostics. */
export const listenAuthRunDone = (
  handler: (p: AuthRunDone) => void,
  runId?: string,
): Promise<UnlistenFn> =>
  listen<AuthRunDone>("atlas:auth-run:done", (e) => {
    if (runId && e.payload.runId !== runId) return;
    handler(e.payload);
  });

/** Live output from a login CLI. The URL it prints is the fallback when the
 *  automatic browser hand-off silently fails — without it, that is
 *  indistinguishable from the flow simply hanging. */
export const listenAuthRunProgress = (
  handler: (p: AuthRunProgress) => void,
  runId?: string,
): Promise<UnlistenFn> =>
  listen<AuthRunProgress>("atlas:auth-run:progress", (e) => {
    if (runId && e.payload.runId !== runId) return;
    handler(e.payload);
  });

/**
 * Subscribe to the single multiplexed delta stream. Every delta carries
 * `agent_id` + `session_id` so the consumer can route to the right tab.
 */
export const listenAgents = (handler: (env: AgentDelta) => void): Promise<UnlistenFn> =>
  listen<AgentDelta>("atlas:agents", (e) => handler(e.payload));

/** Fires whenever how-an-agent-launches changes: discovery finished, the
 *  manifest refreshed, an install/uninstall, a settings toggle, or a
 *  spawn-time acquisition. Handlers re-invoke `agents.catalog()`. */
export const listenCatalogChanged = (
  handler: (reason: CatalogChangeReason) => void,
): Promise<UnlistenFn> =>
  listen<{ reason: CatalogChangeReason }>("atlas:agent-catalog:changed", (e) =>
    handler(e.payload.reason),
  );

/** An elicitation raised by a CONNECTION rather than a session.
 *
 *  Same payload as the session-scoped `elicitation_requested` delta, and
 *  answered by the same `agents.respondElicitation`. It arrives on its own
 *  channel because it has no session to be routed by — these are the questions
 *  asked during sign-in, before the agent has a session at all. */
export interface RequestElicitation {
  agentId: string;
  requestId: string;
  mode: "form" | "url";
  message: string;
  requestedSchema?: unknown;
  url?: string | null;
}

/** Fires when an agent asks the user something outside any session. */
export const listenAgentElicitation = (
  handler: (elicitation: RequestElicitation) => void,
): Promise<UnlistenFn> =>
  listen<RequestElicitation>("atlas:agent-elicitation", (e) => handler(e.payload));

/** Fires when such a question no longer needs answering — the agent ended it
 *  itself, which is what happens when the user finishes a device-code login in
 *  their browser. The dialog has to come down, or it asks for something that
 *  already happened. */
export const listenAgentElicitationResolved = (
  handler: (requestId: string) => void,
): Promise<UnlistenFn> =>
  listen<{ requestId: string }>("atlas:agent-elicitation-resolved", (e) =>
    handler(e.payload.requestId),
  );

// ── Lazy per-agent registry ─────────────────────────────────────────────────
// One shared live process PER pluginId. App.tsx pre-spawns the default so the
// first prompt doesn't pay npx/node cold-start (10–30s); a chat bound to a
// different agent (e.g. Codex) spawns that agent the first time it's used.

/** The coding agents Atlas ships. claude is the default for new chats.
 *  Kept in sync with `PLUGIN_ID_BY_AGENT` in `src/types/agent.ts` — prefer
 *  `pluginIdForAgent(agentType)` over these constants for routing. */
export const DEFAULT_PLUGIN_ID = "claude-code-ts";
export const CODEX_PLUGIN_ID = "codex";
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
