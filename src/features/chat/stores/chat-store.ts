import { create } from "zustand";
import { agents } from "../lib/agents-api";
import { immer } from "zustand/middleware/immer";
import { createSelectors } from "@/lib/create-selectors";
import type {
  ChatSession,
  ChatMessage,
  AgentStatus,
  MessageRole,
  ClaudePermissionMode,
  SwitchableAgent,
  AgentType,
} from "@/types/agent";
import { CLAUDE_PERMISSION_MODES } from "@/types/agent";
import type { PendingPermission } from "@/types/acp";
import type {
  AgentDelta,
  ToolCall as AgentToolCall,
  ImageAttachment,
  SessionModeInfo,
} from "@/types/agents";
import { splitAtlasContext } from "../lib/atlas-context";
import { loadCachedAcpModes, saveCachedAcpModes } from "../lib/acp-modes-cache";
import { loadLastModePref, saveLastModePref } from "../lib/last-mode-pref";
import { loadCachedAcpModels, saveCachedAcpModels } from "../lib/acp-models-cache";
import { resolveModelLabel } from "../lib/model-label";
import { defaultAgentForNewSession } from "../lib/default-agent";
import { loadCachedContextUsage, saveCachedContextUsage } from "../lib/context-usage-cache";
import {
  saveCerseiModelPref,
  saveCerseiEffort,
  saveCerseiCompress,
} from "../lib/cersei-model-pref";
import { invoke } from "@tauri-apps/api/core";
import { extractPlanMarkdown, type PlanRecord } from "../lib/plans";
import { extractNextSteps } from "../lib/next-steps";
import {
  getFilePathFromInput,
  classifyToolFileKind,
  countEditLines,
  isFileCreated,
} from "../lib/tool-files";
import type { TurnFile } from "@/types/agent";

/** Rebuild the adaptive per-turn `turnSummary` (files read/modified) from a
 *  loaded transcript's tool calls. `turnSummary` is computed live at
 *  turn_finished and NOT persisted, so a resumed/switched session (the chat is a
 *  singleton tab, so navigating reloads from disk) would otherwise show no
 *  adaptive card. Walk each turn (a run of assistant messages after a user
 *  message) and freeze the accumulated files onto its trailing assistant
 *  message — the same slot the live path uses. Mutates in place. */
function reconstructTurnSummaries(messages: ChatMessage[]): void {
  const flushTurn = (start: number, end: number) => {
    const byPath = new Map<string, TurnFile>();
    let lastAsst = -1;
    for (let i = start; i < end; i++) {
      const m = messages[i];
      if (m.role !== "assistant") continue;
      lastAsst = i;
      for (const tc of m.toolCalls) {
        const args = (tc.arguments ?? {}) as Record<string, unknown>;
        const path = getFilePathFromInput(args);
        const kind = classifyToolFileKind(tc.kind, tc.toolName);
        if (!path || !kind) continue;
        const counts =
          kind === "edit" ? countEditLines(tc.toolName, args) : { added: 0, removed: 0 };
        const created = kind === "edit" ? isFileCreated(tc.toolName, args) : undefined;
        const ex = byPath.get(path);
        if (!ex) byPath.set(path, { path, kind, ...counts, created });
        else {
          ex.added += counts.added;
          ex.removed += counts.removed;
          if (kind === "edit") ex.kind = "edit";
          if (created === false) ex.created = false;
        }
      }
    }
    if (lastAsst >= 0) {
      if (byPath.size > 0) {
        messages[lastAsst].turnSummary = {
          turnSeq: 0, // reconstructed — not tied to a live turn
          files: Array.from(byPath.values()),
          repoAtTurn: false,
        };
      }
      // Restore agent-generated chips from the reply's <next_steps> block.
      const chips = extractNextSteps(messages[lastAsst].content);
      if (chips.length > 0) {
        messages[lastAsst].suggestions = { turnSeq: 0, status: "ready", chips };
      }
    }
  };
  let turnStart = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user" && i > turnStart) {
      flushTurn(turnStart, i);
      turnStart = i;
    }
  }
  flushTurn(turnStart, messages.length);
}

/** Collapse the per-turn tool-id map into one entry per file path, summing
 *  edit counts; `edit` wins over `read` when a file was both read and edited. */
function aggregateTurnFiles(tools: Record<string, TurnFile>): TurnFile[] {
  const byPath = new Map<string, TurnFile>();
  for (const t of Object.values(tools)) {
    const ex = byPath.get(t.path);
    if (!ex) {
      byPath.set(t.path, { ...t });
      continue;
    }
    ex.added += t.added;
    ex.removed += t.removed;
    if (t.kind === "edit") ex.kind = "edit";
    if (t.created === false) ex.created = false; // any real modify → "M"
  }
  return Array.from(byPath.values());
}

/**
 * Push a session's permission mode to its bound ACP agent. The mode chip
 * and the ⇧⇥ shortcut both mutate `claudePermissionMode` in the store, but
 * that's only the UI label — without this IPC the agent keeps running in
 * whatever mode it was started in, so "Bypass Permissions" still prompted.
 * No-op until the session is bound (the create-time setMode in chat-panel
 * covers the not-yet-bound case).
 */
function pushPermissionModeToAgent(state: ChatState, sessionId: string): void {
  const session = state.sessions[sessionId];
  if (!session?.acpAgentId || !session.acpSessionId) return;
  if (session.agentType !== "claude-code") return;
  void invoke("agents_set_mode", {
    key: { agent_id: session.acpAgentId, session_id: session.acpSessionId },
    modeId: session.claudePermissionMode ?? "default",
  }).catch((err) => console.warn("agents_set_mode failed:", err));
}

/** Push a generic ACP session mode (Codex's read-only / auto / full-access)
 *  to its bound agent. Agent-agnostic sibling of `pushPermissionModeToAgent`.
 *  No-op until the session is bound. */
function pushAcpModeToAgent(state: ChatState, sessionId: string): void {
  const session = state.sessions[sessionId];
  if (!session?.acpAgentId || !session.acpSessionId || !session.acpCurrentMode) return;
  // Only push ids this session's agent actually advertised. A mode carried over
  // from another agent is rejected (`invalidParams`), and the actor rolls its
  // optimistic flip back — which reads as a picker that silently does nothing.
  const modes = session.acpAvailableModes ?? [];
  if (modes.length > 0 && !modes.some((m) => m.id === session.acpCurrentMode)) return;
  void invoke("agents_set_mode", {
    key: { agent_id: session.acpAgentId, session_id: session.acpSessionId },
    modeId: session.acpCurrentMode,
  }).catch((err) => console.warn("agents_set_mode failed:", err));
}

/** Hydrate the per-agent persisted mode preference (last explicit pick) into
 *  a freshly-created / freshly-switched tab. A restored pick is marked
 *  explicit so the chat panel pushes it to the agent at session create (after
 *  revalidating against the advertised modes); no pick means "defer to the
 *  agent's own configured default" — never an Atlas-side override. */
function applyPersistedModePref(sess: ChatSession, agentType: AgentType): void {
  const pref = loadLastModePref(agentType);
  if (agentType === "claude-code") {
    const valid = !!pref && (CLAUDE_PERMISSION_MODES as readonly string[]).includes(pref);
    sess.claudePermissionMode = valid ? (pref as ClaudePermissionMode) : "default";
    sess.claudePermissionModeExplicit = valid;
    return;
  }
  // Generic ACP agents: only trust the pick against the optimistic cached
  // mode list (or when nothing is cached yet) — an id the live agent turns
  // out not to advertise would stick the picker on its "Mode" fallback.
  // Session-create revalidates against the real advertised list either way.
  const cached = loadCachedAcpModes(agentType);
  const valid =
    !!pref &&
    (!cached ||
      cached.availableModes.length === 0 ||
      cached.availableModes.some((m) => m.id === pref));
  sess.acpModeExplicit = valid;
  if (valid && pref) sess.acpCurrentMode = pref;
}

/** Push an ACP agent's model selection (Claude Code / Codex) to its bound
 *  agent via `agents_set_model` (ACP `session/set_model`). Plain model id (no
 *  `provider/` prefix — that's the native Cersei form). No-op until bound. */
function pushAcpModelToAgent(state: ChatState, sessionId: string): void {
  const session = state.sessions[sessionId];
  if (!session?.acpAgentId || !session.acpSessionId || !session.acpCurrentModel) return;
  void invoke("agents_set_model", {
    key: { agent_id: session.acpAgentId, session_id: session.acpSessionId },
    modelId: session.acpCurrentModel,
  }).catch((err) => console.warn("agents_set_model failed:", err));
}

/** Push the native Cersei agent's `provider/model` selection to its bound
 *  agent via `agents_set_model`. The backend's `set_model` parses the
 *  `provider/model` form (see `atlas_cersei::CerseiRuntime::set_model`).
 *  No-op until the session is bound and both provider + model are chosen. */
function pushCerseiModelToAgent(state: ChatState, sessionId: string): void {
  const session = state.sessions[sessionId];
  if (!session?.acpAgentId || !session.acpSessionId) return;
  if (session.agentType !== "cersei") return;
  const provider = session.cerseiProvider;
  const model = session.acpCurrentModel;
  if (!provider || !model) return;
  void invoke("agents_set_model", {
    key: { agent_id: session.acpAgentId, session_id: session.acpSessionId },
    modelId: `${provider}/${model}`,
  }).catch((err) => console.warn("agents_set_model failed:", err));
}

/** Push the native agent's reasoning-effort level to its bound agent via
 *  `agents_set_effort`. No-op until bound / for non-cersei sessions. */
function pushCerseiEffortToAgent(state: ChatState, sessionId: string): void {
  const session = state.sessions[sessionId];
  if (!session?.acpAgentId || !session.acpSessionId) return;
  if (session.agentType !== "cersei") return;
  void invoke("agents_set_effort", {
    key: { agent_id: session.acpAgentId, session_id: session.acpSessionId },
    effort: session.cerseiEffort ?? "",
  }).catch((err) => console.warn("agents_set_effort failed:", err));
}

/** Push the native agent's RTK compression toggle via `agents_set_compress`. */
function pushCerseiCompressToAgent(state: ChatState, sessionId: string): void {
  const session = state.sessions[sessionId];
  if (!session?.acpAgentId || !session.acpSessionId) return;
  if (session.agentType !== "cersei") return;
  void invoke("agents_set_compress", {
    key: { agent_id: session.acpAgentId, session_id: session.acpSessionId },
    on: session.cerseiCompress ?? true,
  }).catch((err) => console.warn("agents_set_compress failed:", err));
}

/** Convert an atlas-agents wire ToolCall into the in-store ChatMessage shape. */
function toChatToolCall(tc: AgentToolCall): ChatMessage["toolCalls"][number] {
  return {
    id: tc.id,
    toolName: tc.tool_name,
    // Preserve the ACP `kind` so bash/execute calls can be recognised
    // reliably (the bash-history panel + bash-styled cards key off it).
    kind: tc.kind ?? null,
    arguments: (tc.arguments ?? {}) as Record<string, unknown>,
    result: tc.result,
    status:
      tc.status === "pending"
        ? "pending"
        : tc.status === "running"
          ? "running"
          : tc.status === "failed"
            ? "failed"
            : "completed",
    duration: null,
  };
}

interface ChatState {
  sessions: Record<string, ChatSession>;
  /**
   * Pending ACP permission requests, keyed by acpSessionId. Each list is
   * FIFO — the modal renders the head. Cleared on respond / agent_disconnect.
   */
  pendingPermissions: Record<string, PendingPermission[]>;
  /**
   * Per-tab queue of pending user messages. Filled when the user types while
   * the agent is still streaming; auto-drained when the stream finishes.
   */
  queues: Record<string, string[]>;
  /**
   * Per-tab composer draft. Mirrors the CodeMirror text body so a tab
   * switch (which unmounts MessageInput) doesn't drop what the user was
   * typing. Cleared on submit. Plain text only — mentions live in the
   * editor's document and rebind to fresh chip nodes when the draft
   * reloads on remount.
   */
  drafts: Record<string, string>;
  activeSessionId: string | null;
}

interface ChatActions {
  actions: {
    createSession: (tabId: string, agentType?: SwitchableAgent) => void;
    /** Re-bind a fresh (message-less) chat to a different agent. Clears the ACP
     *  binding so the chat panel re-creates a session with the new agent. */
    switchChatAgent: (tabId: string, agentType: SwitchableAgent) => void;
    /** Sync the composer's agent label to an ALREADY-bound session's real
     *  agent (e.g. resuming a history session whose agent differs from the
     *  tab's current selection). Unlike `switchChatAgent` this does NOT clear
     *  the ACP binding — the session stays attached to its live agent process,
     *  so it never spawns a fresh chat. */
    setSessionAgentType: (tabId: string, agentType: SwitchableAgent) => void;
    setActiveSession: (id: string | null) => void;
    addMessage: (
      sessionId: string,
      role: MessageRole,
      content: string,
      attachments?: ImageAttachment[],
    ) => void;
    appendToolCall: (sessionId: string, toolName: string, input: Record<string, unknown>) => void;
    updateLastAssistantMessage: (sessionId: string, content: string) => void;
    updateSessionStatus: (sessionId: string, status: AgentStatus) => void;
    /** Mark a session as stop-requested (Stop clicked, terminal not yet in). */
    setStopping: (sessionId: string, on: boolean) => void;
    /** Flag/clear "the backing agent process died" (drives Restart + rebind). */
    setDisconnected: (sessionId: string, on: boolean) => void;
    setSessionTitle: (sessionId: string, title: string) => void;
    setTranscriptLoading: (sessionId: string, loading: boolean) => void;
    /** Mark a resumed session as bound-but-not-yet-loaded. See
     *  `ChatSession.resumePending` — gates sending, not reading. */
    setResumePending: (sessionId: string, pending: boolean) => void;
    clearSession: (sessionId: string) => void;
    removeSession: (sessionId: string) => void;
    /** Drop several sessions at once (used when a workspace is DISCARDED from
     *  the hot set — frees its chat history from RAM; reloaded cold on revisit). */
    removeSessions: (sessionIds: string[]) => void;
    /** Drop all chat sessions, queues, and pending permissions. Used when
     *  the user switches projects so dead acpSessionIds from the old
     *  project's `.atlas/` don't linger and cause ghost-bound tabs. */
    resetSessions: () => void;
    cycleClaudePermissionMode: (sessionId: string) => void;
    /** Reflect the mode the agent chose during session creation without
     *  treating it as an Atlas user override or sending a second RPC. */
    hydrateClaudePermissionMode: (sessionId: string, mode: ClaudePermissionMode) => void;
    setClaudePermissionMode: (sessionId: string, mode: ClaudePermissionMode) => void;
    /** Seed the generic ACP mode state (current + available list) from a
     *  session snapshot. Used for non-Claude agents (e.g. Codex). */
    setAcpModes: (
      sessionId: string,
      currentMode: string | null,
      availableModes: SessionModeInfo[],
      /** Agent the snapshot came from (`agentTypeFromPluginId(snap.plugin_id)`).
       *  When it disagrees with the tab's current agent the seed is stale and is
       *  dropped — see the action for the cross-agent bug that motivated it. */
      sourceAgentType?: AgentType,
    ) => void;
    /** Pick a generic ACP session mode and push it to the bound agent.
     *  The Codex equivalent of `setClaudePermissionMode`. */
    setAcpMode: (sessionId: string, modeId: string) => void;
    /** Toggle the non-Claude mode-picker loading state. Set false once the
     *  session boot resolves (modes confirmed, or bind failed) so the composer's
     *  picker never hangs on its loading spinner. */
    setAcpModesPending: (sessionId: string, pending: boolean) => void;
    /** Seed the ACP model list (Claude Code / Codex) + current model from a
     *  session snapshot's `available_models`. Caches per agentType. */
    setAcpModels: (
      sessionId: string,
      currentModel: string | null,
      availableModels: SessionModeInfo[],
    ) => void;
    /** Pick an ACP model and push it to the bound agent (`session/set_model`). */
    setAcpModel: (sessionId: string, modelId: string) => void;
    /** Seed the ACP slash-command list from a session snapshot's
     *  `available_commands` — the recovery path for `available_commands_update`
     *  deltas that raced ahead of the binding (or a resume) and were dropped
     *  by the session router. Never clobbers a non-empty live list with an
     *  empty snapshot. */
    setAcpAvailableCommands: (sessionId: string, commands: unknown[]) => void;
    /** Native Cersei agent: pick the BYOK provider. Clears the model so the
     *  composer re-selects a default for the new provider before pushing. */
    setCerseiProvider: (sessionId: string, provider: string) => void;
    /** Native Cersei agent: pick the model and push `provider/model` to the
     *  bound agent via `agents_set_model`. No-op until the session is bound. */
    setCerseiModel: (sessionId: string, model: string) => void;
    /** Native Cersei agent: set the reasoning-effort level and push it. */
    setCerseiEffort: (sessionId: string, effort: string) => void;
    /** Native Cersei agent: toggle RTK tool-output compression and push it. */
    setCerseiCompress: (sessionId: string, on: boolean) => void;
    replaceMessages: (
      sessionId: string,
      messages: Array<{
        role: MessageRole;
        content: string;
        timestamp?: string;
        /** Producing model recovered from the snapshot/transcript, so the
         *  per-message badge survives session reloads. */
        model?: string | null;
        toolCalls?: Array<{
          toolName: string;
          kind?: string | null;
          arguments: Record<string, unknown>;
          result?: string | null;
        }>;
      }>,
    ) => void;
    /** Restore live (non-transcript) session state from a `session/load`
     *  snapshot: the backend's current status and the current turn's live plan.
     *  `replaceMessages` only restores the persisted thread; without this a
     *  session switched-away-from and back shows idle + no plan even while its
     *  backend turn is still running a plan. */
    hydrateSessionSnapshot: (
      tabId: string,
      status: AgentStatus,
      plan: Array<{ content: string; status: string }>,
    ) => void;
    /** Mirror the composer's plain text into the per-tab draft slot. */
    setDraft: (tabId: string, text: string) => void;
    /** Set/patch the adaptive next-step suggestions on a turn's trailing
     *  message. `turnSeq` is the stale guard — a late async result for a
     *  superseded turn is dropped. */
    setTurnSuggestions: (
      tabId: string,
      messageId: string,
      turnSeq: number,
      patch: {
        status: "idle" | "loading" | "ready" | "error";
        chips?: string[];
      },
    ) => void;
    /** Drop a draft (on submit, or when its tab closes). */
    clearDraft: (tabId: string) => void;
    enqueueMessage: (sessionId: string, text: string) => void;
    removeQueueItem: (sessionId: string, index: number) => void;
    editQueueItem: (sessionId: string, index: number, text: string) => void;
    shiftQueue: (sessionId: string) => string | null;
    clearQueue: (sessionId: string) => void;
    // ── ACP bindings ────────────────────────────────────────────────────
    setAcpBinding: (
      tabId: string,
      agentId: string,
      acpSessionId: string,
      /** Project root the session was created with — stamps `workingDirectory`. */
      cwd?: string,
    ) => void;
    /**
     * Apply one `atlas:acp` event to whichever chat tab owns its acpSessionId.
     * Phase-1 handles `agent_message_chunk` (text) and `tool_call`; everything
     * else is silently ignored until phase-2 widgets land.
     */
    /**
     * Apply an `atlas:agents` SessionDelta from the Rust-side manager. This
     * is the single bridge between the Rust SessionState and the chat-store —
     * status/turn lifecycle, text/thinking chunks, tool-call upserts, plan
     * updates, mode/model changes, available_commands. Permission requests
     * flow through `pushPermission` from the App.tsx listener.
     */
    applyAgentDelta: (env: AgentDelta) => void;
    /**
     * RAF-coalesced fast path for streaming text. Called by the global ACP
     * listener once per animation frame instead of per chunk.
     */
    appendAssistantText: (acpSessionId: string, text: string) => void;
    /** RAF-coalesced fast path for `agent_thought_chunk`. */
    appendAssistantThought: (acpSessionId: string, text: string) => void;
    /**
     * Apply a frame's worth of buffered events in a SINGLE immer pass.
     * On a "read 30 files" turn the adapter emits ~60 `tool_call` /
     * `tool_call_update` events plus a stream of text chunks. Calling
     * `applyAgentDelta` (which is its own `set(...)`) per event paid an
     * immer snapshot + subscriber notification per event — at 60 events
     * that's 60 full structural-share passes over `s.sessions[tid]`
     * and 60 `MessagesList` re-renders with `measureElement` work.
     * Batching collapses that to 1 immer pass + 1 re-render per frame.
     *
     * The caller (App.tsx::listenAgents) is expected to:
     *  - Dedupe `tool_call_upserted` by `(session, tool_call.id)` so
     *    only the latest state for each tool call lands.
     *  - Pass text/thought as merged-per-session strings (same as the
     *    old per-event RAF flush did).
     *  - Pass other deltas in wire order — they're applied verbatim.
     */
    applyAgentBatch: (batch: {
      texts: Array<{ sessionId: string; text: string }>;
      thoughts: Array<{ sessionId: string; text: string }>;
      deltas: AgentDelta[];
    }) => void;
    pushPermission: (req: PendingPermission) => void;
    popPermission: (acpSessionId: string, requestId: string) => void;
    clearPermissionsForAgent: (agentId: string) => void;
    /** Drop every pending permission for a specific ACP session.
     *  Called on Stop so a modal left over from the cancelled turn
     *  doesn't linger and trick the user into clicking Allow on a
     *  request the agent already abandoned. */
    clearPermissionsForSession: (acpSessionId: string) => void;
  };
}

function findTabByAcpSession(
  sessions: Record<string, ChatSession>,
  acpSessionId: string,
): string | null {
  for (const [tid, s] of Object.entries(sessions)) {
    if (s.acpSessionId === acpSessionId) return tid;
  }
  return null;
}

/**
 * When a permission request carries a plan (Claude Code ExitPlanMode), persist
 * it to the per-project plans store together with the user message that
 * triggered it and a timestamp. Fire-and-forget; never blocks the permission
 * UI. Rust dedups by (session, plan) so a re-delivered permission is a no-op.
 */
async function capturePlanIfPresent(
  req: PendingPermission,
  sessions: Record<string, ChatSession>,
): Promise<void> {
  const plan = extractPlanMarkdown(req.toolCall);
  if (!plan) return;

  const tabId = findTabByAcpSession(sessions, req.acpSessionId);
  const session = tabId ? sessions[tabId] : undefined;

  // Original user message = the most recent user message in the session.
  // Prefer the clean prose (atlas-context wrapper stripped) for display.
  let userMessage = "";
  if (session) {
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const m = session.messages[i];
      if (m.role === "user") {
        userMessage = m.atlasProse ?? m.content;
        break;
      }
    }
  }

  const { useProjectStore } = await import("@/features/project/stores/project-store");
  const projectPath = useProjectStore.getState().currentProject?.path;
  if (!projectPath) return;

  const record: PlanRecord = {
    id: `plan-${req.requestId}`,
    sessionId: req.acpSessionId ?? null,
    sessionTitle: session?.title ?? null,
    userMessage,
    plan,
    timestamp: new Date().toISOString(),
  };

  try {
    await invoke("plans_append", { projectPath, record });
    // Let an open Plans panel refresh without re-opening.
    window.dispatchEvent(new CustomEvent("atlas:plan-saved"));
  } catch {
    /* non-fatal — persistence failure shouldn't affect the permission flow */
  }
}

let messageCounter = 0;
function nextMessageId(): string {
  messageCounter += 1;
  return `msg-${Date.now()}-${messageCounter.toString(36)}`;
}

function makeAssistantTextMessage(content: string): ChatMessage {
  return {
    id: nextMessageId(),
    role: "assistant",
    content,
    toolCalls: [],
    fileChanges: [],
    plan: null,
    timestamp: new Date().toISOString(),
    mode: "text",
  };
}

function makeAssistantThinkingMessage(thinking: string): ChatMessage {
  return {
    id: nextMessageId(),
    role: "assistant",
    content: "",
    toolCalls: [],
    fileChanges: [],
    plan: null,
    timestamp: new Date().toISOString(),
    mode: "thinking",
    thinking,
  };
}

function makeAssistantToolMessage(toolCall: ChatMessage["toolCalls"][number]): ChatMessage {
  return {
    id: nextMessageId(),
    role: "assistant",
    content: "",
    toolCalls: [toolCall],
    fileChanges: [],
    plan: null,
    timestamp: new Date().toISOString(),
    mode: "tool",
  };
}

/** Find the message + tool call entry across all messages by toolCallId. */
function findToolCall(
  session: ChatSession,
  toolCallId: string,
): { msg: ChatMessage; tc: ChatMessage["toolCalls"][number] } | null {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    const tc = m.toolCalls.find((t) => t.id === toolCallId);
    if (tc) return { msg: m, tc };
  }
  return null;
}

export const useChatStore = createSelectors(
  create<ChatState & ChatActions>()(
    immer((set, get) => ({
      sessions: {},
      pendingPermissions: {},
      queues: {},
      drafts: {},
      activeSessionId: null,
      actions: {
        // No explicit agent → resolve the priority default (Claude Code when
        // it's installed + authed, otherwise the native Atlas agent). Never
        // hard-code "claude-code" here: on a fresh install that produces a
        // permanently disabled composer with no way to reach another agent.
        createSession: (tabId, agentType = defaultAgentForNewSession()) =>
          set((s) => {
            if (s.sessions[tabId]) return;
            s.sessions[tabId] = {
              id: tabId,
              title: "New Chat",
              messages: [],
              agentType,
              model: "",
              status: "idle",
              workingDirectory: "",
              tasks: [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              // Permission mode is a Claude Code feature; Codex drives its
              // modes generically via ACP (acpCurrentMode).
              claudePermissionMode: agentType === "claude-code" ? "default" : undefined,
              claudePermissionModeExplicit: false,
              acpModeExplicit: false,
              // Optimistically pre-fill a non-Claude agent's mode picker from the
              // persisted cache so switching feels instant; mark pending until the
              // real session confirms (the picker shows a loading state).
              ...(agentType !== "claude-code"
                ? (() => {
                    const cached = loadCachedAcpModes(agentType);
                    return {
                      acpAvailableModes: cached?.availableModes ?? [],
                      acpCurrentMode: cached?.currentMode ?? undefined,
                      acpModesPending: true,
                    };
                  })()
                : {}),
              // Models apply to BOTH Claude Code and Codex (ACP `session/new`
              // model picking). Pre-fill from cache; empty for the native agent.
              ...(() => {
                const m = loadCachedAcpModels(agentType);
                return m
                  ? {
                      acpAvailableModels: m.availableModels,
                      acpCurrentModel: m.currentModel ?? undefined,
                    }
                  : {};
              })(),
            };
            s.activeSessionId = tabId;
            // Restore the user's last explicit mode pick for this agent so it
            // survives restarts (marks it explicit; create pushes it after
            // validating against the agent's advertised modes).
            applyPersistedModePref(s.sessions[tabId], agentType);
          }),
        switchChatAgent: (tabId, agentType) =>
          set((s) => {
            // Store-boundary guard: agentType feeds plugin resolution,
            // localStorage cache keys, and Tauri invoke args — a non-string
            // (a leaked DOM event, once) poisons all three. Mirrors the
            // total-by-construction rule on agentMeta().
            if (typeof agentType !== "string") return;
            const sess = s.sessions[tabId];
            if (!sess) return;
            // Drop any pending permissions that belonged to the old binding so a
            // stale request from the previous agent can't render under the new
            // one (agents are pooled per plugin, so the process keeps running —
            // we only clear THIS session's queue, not the agent).
            if (sess.acpSessionId) delete s.pendingPermissions[sess.acpSessionId];
            sess.agentType = agentType;
            sess.claudePermissionMode = agentType === "claude-code" ? "default" : undefined;
            sess.claudePermissionModeExplicit = false;
            sess.acpModeExplicit = false;
            // Drop the old ACP binding so the chat panel's mount effect re-binds
            // to the newly chosen agent (deps watch acpSessionId + agentType).
            sess.acpAgentId = undefined;
            sess.acpSessionId = undefined;
            sess.acpCurrentMode = undefined;
            sess.acpCurrentModel = undefined;
            // The provider only applies to the native agent; clear it so the
            // composer re-defaults from BYOK keys if cersei is chosen.
            sess.cerseiProvider = undefined;
            // Slash commands are per-agent (ACP `available_commands_update`);
            // the old agent's list must not survive the switch or it renders
            // under the new agent until its own update lands.
            sess.availableCommands = undefined;
            if (agentType === "claude-code") {
              // Claude has no ACP modes — clear the old agent's so no stale pill.
              sess.acpAvailableModes = [];
              sess.acpModesPending = false;
            } else {
              // Optimistically seed from cache so the pill appears instantly with
              // the right modes; keep pending until the new binding confirms. A
              // cache miss (first-ever use) shows a pure loading state.
              const cached = loadCachedAcpModes(agentType);
              sess.acpAvailableModes = cached?.availableModes ?? [];
              sess.acpCurrentMode = cached?.currentMode ?? undefined;
              sess.acpModesPending = true;
            }
            // Same restore as createSession: the agent's last explicit pick
            // wins over the optimistic cache seed above.
            applyPersistedModePref(sess, agentType);
            // Models apply to both agents — seed from cache (empty for cersei).
            const cachedModels = loadCachedAcpModels(agentType);
            sess.acpAvailableModels = cachedModels?.availableModels ?? [];
            sess.acpCurrentModel = cachedModels?.currentModel ?? undefined;
          }),
        setSessionAgentType: (tabId, agentType) =>
          set((s) => {
            const sess = s.sessions[tabId];
            if (!sess) return;
            if (sess.agentType !== agentType) {
              sess.agentType = agentType;
              // Per-agent ACP command list — stale across an agent change.
              sess.availableCommands = undefined;
              sess.claudePermissionMode =
                agentType === "claude-code" ? (sess.claudePermissionMode ?? "default") : undefined;
              sess.claudePermissionModeExplicit = false;
              sess.acpModeExplicit = false;
              if (agentType === "claude-code") {
                // Claude has no ACP modes — clear any stale picker state left
                // by the previously-selected agent so no ghost mode pill shows.
                sess.acpAvailableModes = [];
                sess.acpModesPending = false;
                sess.acpCurrentMode = undefined;
              }
              // For codex/cersei the resume flow calls `setAcpModes`
              // immediately after with the session's real advertised modes, so
              // no cache seeding is needed here. Crucially the ACP binding
              // (acpAgentId/acpSessionId) is left intact — this only relabels.
            }
            // Reseed model state even when the agent type is UNCHANGED. This
            // action only runs from the resume flow, where the tab is being
            // rebound to a different conversation — the previous conversation's
            // `acpCurrentModel` would render raw on the picker and get stamped
            // onto the resumed session's new messages (the wrong-label bug,
            // same-agent variant). The resume snapshot's real models/current
            // land right after via `setAcpModels` (which only seeds current
            // when unset, so clearing here is what lets it take effect).
            sess.cerseiProvider = undefined;
            const cachedModels = loadCachedAcpModels(agentType);
            sess.acpAvailableModels = cachedModels?.availableModels ?? [];
            sess.acpCurrentModel = cachedModels?.currentModel ?? undefined;
          }),
        setActiveSession: (id) =>
          set((s) => {
            s.activeSessionId = id;
          }),
        addMessage: (sessionId, role, content, attachments) =>
          set((s) => {
            const session = s.sessions[sessionId];
            if (!session) return;
            // Pre-split for user-composed messages so MessageItem
            // doesn't run regex on every render. No-op for assistant /
            // system messages (they don't carry the Atlas-context
            // suffix).
            const split = role === "user" ? splitAtlasContext(content) : null;
            const msg: ChatMessage = {
              id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              role,
              content,
              ...(attachments?.length ? { attachments } : {}),
              toolCalls: [],
              fileChanges: [],
              plan: null,
              timestamp: new Date().toISOString(),
              ...(split && split.context !== null
                ? {
                    atlasProse: split.prose,
                    atlasContext: split.context,
                    atlasContextBlockCount: split.blockCount,
                  }
                : {}),
            };
            session.messages.push(msg);
            session.updatedAt = new Date().toISOString();
            if (role === "user") {
              if (!session.firstUserContent) session.firstUserContent = content;
              session.userMessageCount = (session.userMessageCount ?? 0) + 1;
              // The ONE row allowed to play the bubble entrance. Resume /
              // replay paths stamp messages "now", so a timestamp heuristic
              // animated whole restored threads (and every row mounted during
              // an early scroll) — id-scoping keeps it to the actual send.
              session.justSentMessageId = msg.id;
            }
          }),
        appendToolCall: (sessionId, toolName, input) =>
          set((s) => {
            const session = s.sessions[sessionId];
            if (!session) return;
            for (let i = session.messages.length - 1; i >= 0; i--) {
              if (session.messages[i].role === "assistant") {
                session.messages[i].toolCalls.push({
                  id: `tc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                  toolName,
                  kind: null,
                  arguments: input,
                  result: null,
                  status: "completed",
                  duration: null,
                });
                break;
              }
            }
          }),
        updateLastAssistantMessage: (sessionId, content) =>
          set((s) => {
            const session = s.sessions[sessionId];
            if (!session) return;
            for (let i = session.messages.length - 1; i >= 0; i--) {
              if (session.messages[i].role === "assistant") {
                session.messages[i].content = content;
                break;
              }
            }
          }),
        updateSessionStatus: (sessionId, status) =>
          set((s) => {
            const session = s.sessions[sessionId];
            if (session) session.status = status;
          }),
        setDisconnected: (sessionId, on) =>
          set((s) => {
            const session = s.sessions[sessionId];
            if (session) session.disconnected = on || undefined;
          }),
        setStopping: (sessionId, on) =>
          set((s) => {
            const session = s.sessions[sessionId];
            if (session) session.stopping = on || undefined;
          }),
        setSessionTitle: (sessionId, title) =>
          set((s) => {
            const session = s.sessions[sessionId];
            if (session) session.title = title;
          }),
        setTranscriptLoading: (sessionId, loading) =>
          set((s) => {
            const session = s.sessions[sessionId];
            if (session) session.transcriptLoading = loading;
          }),
        setResumePending: (sessionId, pending) =>
          set((s) => {
            const session = s.sessions[sessionId];
            if (session) session.resumePending = pending;
          }),
        clearSession: (sessionId) =>
          set((s) => {
            const session = s.sessions[sessionId];
            if (session) {
              session.messages = [];
              session.tasks = [];
              session.status = "idle";
              session.acpAgentId = undefined;
              session.acpSessionId = undefined;
              session.title = "New Chat";
              session.firstUserContent = undefined;
              session.userMessageCount = 0;
              // Reset the turn-identity high-water mark + live per-turn scratch
              // so the next bound session's fresh turn_seq (which restarts at 1)
              // isn't rejected as stale by `isStaleTurn` (see `setAcpBinding`).
              session.currentTurnSeq = 0;
              session.livePlan = undefined;
              session.turnScratch = undefined;
              // Commands belong to the ACP session being dropped; the next
              // binding re-advertises its own list.
              session.availableCommands = undefined;
              // The tab no longer points at the session being resumed, so the
              // send gate must drop with it. A resume that gets superseded
              // (New chat / another sidebar click) bails WITHOUT clearing its own
              // flag — deliberately, so it can't un-gate the resume that replaced
              // it — which makes this the single place the flag is guaranteed to
              // reset. Leaving it set would silently queue every future send in
              // this tab forever.
              session.resumePending = false;
            }
            delete s.queues[sessionId];
          }),
        cycleClaudePermissionMode: (sessionId) => {
          let next: ClaudePermissionMode | undefined;
          set((s) => {
            const session = s.sessions[sessionId];
            if (!session) return;
            const cur = session.claudePermissionMode ?? "default";
            const i = CLAUDE_PERMISSION_MODES.indexOf(cur);
            next = CLAUDE_PERMISSION_MODES[(i + 1) % CLAUDE_PERMISSION_MODES.length];
            session.claudePermissionMode = next;
            session.claudePermissionModeExplicit = true;
          });
          // "default" means "defer to the CLI's own configured default" —
          // cycling back to it DROPS the persisted pick rather than storing it.
          if (next) saveLastModePref("claude-code", next === "default" ? null : next);
          pushPermissionModeToAgent(get(), sessionId);
        },
        hydrateClaudePermissionMode: (sessionId, mode) =>
          set((s) => {
            const session = s.sessions[sessionId];
            if (!session) return;
            session.claudePermissionMode = mode;
            session.claudePermissionModeExplicit = false;
          }),
        setClaudePermissionMode: (sessionId, mode) => {
          set((s) => {
            const session = s.sessions[sessionId];
            if (session) {
              session.claudePermissionMode = mode;
              session.claudePermissionModeExplicit = true;
            }
          });
          saveLastModePref("claude-code", mode === "default" ? null : mode);
          pushPermissionModeToAgent(get(), sessionId);
        },
        setAcpModes: (sessionId, currentMode, availableModes, sourceAgentType) => {
          const at = get().sessions[sessionId]?.agentType;
          // Modes are per-agent, and a snapshot can outlive the binding it came
          // from: `setSessionAgentType` relabels a tab WITHOUT clearing its ACP
          // binding, so a snapshot fetched off the previous agent's still-bound
          // session can land after the tab already says "codex". Applying it
          // wrote Claude's modes into the Codex picker AND its cache, leaving
          // Codex on a mode id it doesn't have — the pill fell back to "Mode"
          // and every pick was rejected by the agent. Callers pass the agent the
          // snapshot actually came from (its `plugin_id`); a mismatch is stale
          // by definition, so drop it rather than reconcile it.
          if (sourceAgentType && at && sourceAgentType !== at) return;
          set((s) => {
            const session = s.sessions[sessionId];
            if (!session) return;
            session.acpAvailableModes = availableModes;
            // Don't clobber a user-driven mode the store already reflects when
            // the snapshot carries no current (null) — only seed when present.
            if (currentMode) session.acpCurrentMode = currentMode;
            // Whatever we end up with must be one of THIS list's modes. An
            // optimistically-seeded (cached) current that the live agent doesn't
            // advertise is exactly how the picker got stuck showing "Mode":
            // `find` misses, the label falls back, and nothing ever clears it.
            if (
              availableModes.length > 0 &&
              !availableModes.some((m) => m.id === session.acpCurrentMode)
            ) {
              session.acpCurrentMode = currentMode ?? availableModes[0].id;
            }
            // The real session has now confirmed its modes — drop the loading
            // state regardless of whether they matched the optimistic cache.
            if (availableModes.length > 0) session.acpModesPending = false;
          });
          // Persist the confirmed modes so the next switch to this agent is
          // instant. Done outside the immer pass (side effect, not state).
          if (availableModes.length > 0 && at && at !== "claude-code") {
            saveCachedAcpModes(at, {
              currentMode: currentMode ?? null,
              availableModes,
            });
          }
        },
        setAcpModesPending: (sessionId, pending) =>
          set((s) => {
            const session = s.sessions[sessionId];
            if (session) session.acpModesPending = pending;
          }),
        setAcpMode: (sessionId, modeId) => {
          set((s) => {
            const session = s.sessions[sessionId];
            if (session) {
              session.acpCurrentMode = modeId;
              session.acpModeExplicit = true;
            }
          });
          // Persist the explicit pick per agent. agentType IS the plugin id
          // for registry-installed externals, so every ACP agent — first-party
          // or installed — keeps its own record.
          const at = get().sessions[sessionId]?.agentType;
          if (at && at !== "claude-code") saveLastModePref(at, modeId);
          pushAcpModeToAgent(get(), sessionId);
        },
        setAcpAvailableCommands: (sessionId, commands) => {
          set((s) => {
            const session = s.sessions[sessionId];
            if (!session) return;
            // An empty snapshot must not erase a list the live delta already
            // delivered; it MAY end the picker's loading state (undefined→[])
            // for agents that genuinely advertise nothing.
            if (commands.length === 0 && (session.availableCommands?.length ?? 0) > 0) {
              return;
            }
            session.availableCommands = commands;
          });
        },
        setAcpModels: (sessionId, currentModel, availableModels) => {
          set((s) => {
            const session = s.sessions[sessionId];
            if (!session) return;
            // Never clobber a good list with an empty snapshot. ACP
            // `session/load` doesn't re-advertise models, so a resume/re-bind
            // snapshot can carry [] while the session already has the real
            // list — and the picker hides itself whenever the list is empty.
            if (availableModels.length === 0 && (session.acpAvailableModels?.length ?? 0) > 0) {
              return;
            }
            session.acpAvailableModels = availableModels;
            // Only seed the current model from the snapshot when it carries one;
            // never clobber a user-driven selection the store already reflects.
            if (currentModel && !session.acpCurrentModel) {
              session.acpCurrentModel = currentModel;
            }
          });
          // Persist for instant pre-fill on the next switch/resume (ACP
          // `session/load` doesn't re-advertise models).
          const at = get().sessions[sessionId]?.agentType;
          if (availableModels.length > 0 && at) {
            saveCachedAcpModels(at, {
              currentModel: currentModel ?? null,
              availableModels,
            });
          }
        },
        setAcpModel: (sessionId, modelId) => {
          set((s) => {
            const session = s.sessions[sessionId];
            if (session) session.acpCurrentModel = modelId;
          });
          pushAcpModelToAgent(get(), sessionId);
        },
        setCerseiProvider: (sessionId, provider) =>
          set((s) => {
            const session = s.sessions[sessionId];
            if (!session || session.cerseiProvider === provider) return;
            session.cerseiProvider = provider;
            // New provider → the prior model id is meaningless; let the composer
            // pick this provider's default before anything is pushed.
            session.acpCurrentModel = undefined;
          }),
        setCerseiModel: (sessionId, model) => {
          set((s) => {
            const session = s.sessions[sessionId];
            if (session) session.acpCurrentModel = model;
          });
          // Remember the full selection so the next new chat seeds from it.
          const sess = get().sessions[sessionId];
          if (sess?.cerseiProvider && model) {
            saveCerseiModelPref({ provider: sess.cerseiProvider, model });
          }
          pushCerseiModelToAgent(get(), sessionId);
        },
        setCerseiEffort: (sessionId, effort) => {
          set((s) => {
            const session = s.sessions[sessionId];
            if (session) session.cerseiEffort = effort;
          });
          saveCerseiEffort(effort);
          pushCerseiEffortToAgent(get(), sessionId);
        },
        setCerseiCompress: (sessionId, on) => {
          set((s) => {
            const session = s.sessions[sessionId];
            if (session) session.cerseiCompress = on;
          });
          saveCerseiCompress(on);
          pushCerseiCompressToAgent(get(), sessionId);
        },
        replaceMessages: (sessionId, messages) =>
          set((s) => {
            const session = s.sessions[sessionId];
            if (!session) return;
            session.messages = messages.map((m, i) => {
              const split = m.role === "user" ? splitAtlasContext(m.content) : null;
              return {
                id: `msg-${Date.now()}-${i}`,
                role: m.role,
                content: m.content,
                toolCalls: (m.toolCalls ?? []).map((tc, j) => ({
                  id: `tc-${Date.now()}-${i}-${j}`,
                  toolName: tc.toolName,
                  kind: tc.kind ?? null,
                  arguments: tc.arguments,
                  result: tc.result ?? null,
                  status: "completed" as const,
                  duration: null,
                })),
                fileChanges: [],
                plan: null,
                timestamp: m.timestamp ?? new Date().toISOString(),
                ...(m.role === "assistant" && m.model ? { model: m.model } : {}),
                ...(split && split.context !== null
                  ? {
                      atlasProse: split.prose,
                      atlasContext: split.context,
                      atlasContextBlockCount: split.blockCount,
                    }
                  : {}),
              };
            });
            // Rebuild the adaptive per-turn cards (files read/modified) from the
            // loaded tool calls — turnSummary is runtime-only, so without this a
            // resumed/switched session shows no adaptive card.
            reconstructTurnSummaries(session.messages);
            // Restore the ACP context gauge (not in the on-disk transcript) and
            // re-attach it to the trailing assistant message so its turn card
            // shows the last-known context usage after a switch / restart.
            if (session.acpSessionId) {
              const cachedCtx = loadCachedContextUsage(session.acpSessionId);
              if (cachedCtx) {
                session.contextUsage = cachedCtx;
                for (let i = session.messages.length - 1; i >= 0; i--) {
                  if (session.messages[i].role === "assistant") {
                    session.messages[i].contextUsage = { ...cachedCtx };
                    break;
                  }
                }
              }
            }
            // Recompute the cached preview/count from the loaded transcript
            // so the sidebar doesn't have to scan messages on every chunk.
            session.firstUserContent = messages.find((m) => m.role === "user")?.content;
            session.userMessageCount = messages.reduce(
              (n, m) => n + (m.role === "user" ? 1 : 0),
              0,
            );
            // Intentionally NOT touching `updatedAt`. This action is called
            // when loading a historical transcript from disk into a tab —
            // viewing isn't activity, so it shouldn't bump the sort order
            // in the sidebar. Real activity (addMessage, applyAcpEvent's
            // streaming chunks, etc.) bumps it elsewhere.
          }),
        hydrateSessionSnapshot: (tabId, status, plan) =>
          set((s) => {
            const session = s.sessions[tabId];
            if (!session) return;
            // Adopt the backend's live status (a still-running session switched
            // back to must show as running, not idle). Live deltas from the
            // still-attached backend take over from here.
            session.status = status;
            // Re-derive the docked live plan from the snapshot (same shape as
            // the `plan_updated` delta). Cleared on the switch-away rebind, so
            // this is what makes an active plan REAPPEAR when switching back.
            session.livePlan =
              plan.length > 0
                ? plan.map((e, idx) => ({
                    id: `plan-${idx}`,
                    description: e.content,
                    status: (e.status as "pending" | "in_progress" | "completed") ?? "pending",
                  }))
                : undefined;
          }),
        removeSession: (sessionId) => {
          dropBackendSession(get().sessions[sessionId]);
          set((s) => {
            delete s.sessions[sessionId];
            delete s.drafts[sessionId];
            if (s.activeSessionId === sessionId) {
              const keys = Object.keys(s.sessions);
              s.activeSessionId = keys.length > 0 ? keys[0] : null;
            }
          });
        },
        removeSessions: (sessionIds) => {
          for (const id of sessionIds) dropBackendSession(get().sessions[id]);
          set((s) => {
            for (const id of sessionIds) {
              delete s.sessions[id];
              delete s.drafts[id];
              delete s.queues[id];
              delete s.pendingPermissions[id];
              if (s.activeSessionId === id) s.activeSessionId = null;
            }
          });
        },
        resetSessions: () =>
          set((s) => {
            s.sessions = {};
            s.queues = {};
            s.drafts = {};
            s.pendingPermissions = {};
            s.activeSessionId = null;
          }),
        setDraft: (tabId, text) =>
          set((s) => {
            if (text.length === 0) delete s.drafts[tabId];
            else s.drafts[tabId] = text;
          }),
        clearDraft: (tabId) =>
          set((s) => {
            delete s.drafts[tabId];
          }),
        setTurnSuggestions: (tabId, messageId, turnSeq, patch) =>
          set((s) => {
            const session = s.sessions[tabId];
            if (!session) return;
            // Drop a result belonging to a turn already superseded by a newer
            // send (turnSeq 0 = native/legacy, always current).
            if (turnSeq !== 0 && turnSeq < (session.currentTurnSeq ?? 0)) return;
            const msg = session.messages.find((m) => m.id === messageId);
            if (!msg) return;
            msg.suggestions = {
              turnSeq,
              status: patch.status,
              chips: patch.chips ?? msg.suggestions?.chips ?? [],
            };
          }),
        enqueueMessage: (sessionId, text) =>
          set((s) => {
            const cur = s.queues[sessionId] ?? [];
            s.queues[sessionId] = [...cur, text];
          }),
        removeQueueItem: (sessionId, index) =>
          set((s) => {
            const cur = s.queues[sessionId];
            if (!cur) return;
            const next = cur.filter((_, i) => i !== index);
            if (next.length === 0) delete s.queues[sessionId];
            else s.queues[sessionId] = next;
          }),
        editQueueItem: (sessionId, index, text) =>
          set((s) => {
            const cur = s.queues[sessionId];
            if (!cur || index < 0 || index >= cur.length) return;
            const next = [...cur];
            next[index] = text;
            s.queues[sessionId] = next;
          }),
        shiftQueue: (sessionId) => {
          let head: string | null = null;
          set((s) => {
            const cur = s.queues[sessionId];
            if (!cur || cur.length === 0) return;
            head = cur[0];
            const rest = cur.slice(1);
            if (rest.length === 0) delete s.queues[sessionId];
            else s.queues[sessionId] = rest;
          });
          return head;
        },
        clearQueue: (sessionId) =>
          set((s) => {
            delete s.queues[sessionId];
          }),

        appendAssistantText: (acpSessionId, text) =>
          set((s) => {
            appendTextToDraft(s, acpSessionId, text);
          }),
        appendAssistantThought: (acpSessionId, text) =>
          set((s) => {
            appendThoughtToDraft(s, acpSessionId, text);
          }),
        applyAgentBatch: ({ texts, thoughts, deltas }) =>
          set((s) => {
            // Single immer pass for everything buffered in this frame.
            // Order is: text → thoughts → deltas. Within deltas, wire
            // order is preserved by the caller (App.tsx's RAF flush);
            // `tool_call_upserted` events are deduped there before
            // arriving so we never apply the same tool-call id twice.
            for (const { sessionId, text } of texts) {
              appendTextToDraft(s, sessionId, text);
            }
            for (const { sessionId, text } of thoughts) {
              appendThoughtToDraft(s, sessionId, text);
            }
            for (const env of deltas) {
              applyDeltaToDraft(s, env);
            }
          }),
        setAcpBinding: (tabId, agentId, acpSessionId, cwd) =>
          set((s) => {
            const session = s.sessions[tabId];
            if (!session) return;
            // A (re)bind points the tab at a DIFFERENT backend session — a
            // freshly spawned SessionActor whose `turn_seq` counter restarts at
            // 1 (turn_seq is not persisted; new / resumed / workspace-switched
            // sessions all reconstruct it from 0). The frontend `currentTurnSeq`
            // is a monotonic high-water mark that only ratchets UP (see the
            // status handler), so a value retained from the PREVIOUS session —
            // e.g. after ⌥N launches a new session in a new workspace, or "New
            // Chat" resets the singleton tab in place — would make every
            // terminal of the new session (idle / turn_finished at turn_seq 1)
            // look stale via `isStaleTurn` and get dropped, stranding the
            // composer 'running' forever. Reset the high-water mark (and the
            // previous session's live per-turn scratch) whenever the bound
            // session identity changes.
            if (session.acpSessionId !== acpSessionId) {
              session.currentTurnSeq = 0;
              session.livePlan = undefined;
              session.turnScratch = undefined;
            }
            session.acpAgentId = agentId;
            session.acpSessionId = acpSessionId;
            // Stamp the session's project root the moment it's bound (the agent
            // was created with this cwd). Without it `workingDirectory` stays ""
            // and the chat never lands in the workspace "Chats" list / running
            // counts. Callers pass the project path they used for the session.
            if (cwd) session.workingDirectory = cwd;
          }),
        pushPermission: (req) => {
          set((s) => {
            const list = s.pendingPermissions[req.acpSessionId] ?? [];
            s.pendingPermissions[req.acpSessionId] = [...list, req];
          });
          // Persist the plan (if this permission carries one) for the Plans
          // panel — captures every plan made, even if later rejected.
          void capturePlanIfPresent(req, get().sessions);
        },
        popPermission: (acpSessionId, requestId) =>
          set((s) => {
            const list = s.pendingPermissions[acpSessionId];
            if (!list) return;
            const next = list.filter((r) => r.requestId !== requestId);
            if (next.length === 0) delete s.pendingPermissions[acpSessionId];
            else s.pendingPermissions[acpSessionId] = next;
          }),
        clearPermissionsForAgent: (agentId) =>
          set((s) => {
            for (const sid of Object.keys(s.pendingPermissions)) {
              const list = s.pendingPermissions[sid].filter((r) => r.agentId !== agentId);
              if (list.length === 0) delete s.pendingPermissions[sid];
              else s.pendingPermissions[sid] = list;
            }
          }),
        clearPermissionsForSession: (acpSessionId) =>
          set((s) => {
            delete s.pendingPermissions[acpSessionId];
          }),
        applyAgentDelta: (env) =>
          set((s) => {
            applyDeltaToDraft(s, env);
          }),
      },
    })),
  ),
);

// ── Draft-mutating helpers ────────────────────────────────────────────────
//
// The chat-store hot path applies AgentDeltas inside an immer draft. To
// support both the single-event `applyAgentDelta` and the RAF-coalesced
// `applyAgentBatch` (which runs many events in ONE immer pass for a
// large perf win on tool-heavy turns), the per-event logic lives in
// these standalone functions instead of being inlined into `set(...)`.
// They take the writable draft directly and mutate in place — no
// `set(...)` inside, no return value.

type ChatDraft = ChatState & ChatActions;

/** Stamp the session's current model onto a freshly created assistant message
 *  so the badge records the producing model as a historical fact. Deriving it
 *  at render time from live session state is what leaked labels across agents
 *  (a later model/agent switch relabeled the whole thread). */
function stampProducingModel(
  session: {
    acpCurrentModel?: string;
    acpAvailableModels?: SessionModeInfo[];
    agentType?: string;
  },
  msg: ChatMessage,
): ChatMessage {
  // `session.model` is intentionally NOT a fallback — it's set to "" at
  // creation and never written after, so `acpCurrentModel` is the only real
  // source of the producing model.
  //
  // Stamped as the DISPLAY NAME, resolved here rather than in the row: rows
  // can't read session state without relabelling history on a later switch,
  // and the raw id is a wire token ("default") that means nothing to a reader.
  const m = resolveModelLabel(
    session.acpCurrentModel,
    session.agentType,
    session.acpAvailableModels,
  );
  if (m) msg.model = m;
  return msg;
}

function appendTextToDraft(s: ChatDraft, acpSessionId: string, text: string): void {
  if (!text) return;
  const tid = findTabByAcpSession(s.sessions, acpSessionId);
  if (!tid) return;
  const session = s.sessions[tid];
  // Find the last message that actually renders something, skipping the
  // empty `thinking` markers claude-agent-acp emits between text chunks.
  // Without this, one continuous narration split by such a marker becomes
  // two text messages and the markdown between them (a bold span, a
  // sentence, even mid-word) parses as two broken fragments.
  let last: (typeof session.messages)[number] | undefined;
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    const rendersNothing =
      !m.content?.trim() &&
      !m.thinking?.trim() &&
      m.toolCalls.length === 0 &&
      m.fileChanges.length === 0 &&
      !(m.plan && m.plan.length > 0);
    if (!rendersNothing) {
      last = m;
      break;
    }
  }
  // Append into the trailing text-mode message; otherwise start a new
  // one so a preceding tool/thinking block isn't merged with unrelated
  // narration.
  //
  // NOTE: deliberately not bumping `updatedAt` here. Streaming chunks
  // fire dozens of times per second; touching `updatedAt` each time
  // used to invalidate the sidebar's `hasRunning`/sort memos and
  // re-render every top-level chat consumer per chunk. The sidebar
  // sort still updates correctly via `addMessage` (user send) and the
  // turn-end status flip.
  if (
    last &&
    last.role === "assistant" &&
    (last.mode === "text" || last.mode === undefined) &&
    last.toolCalls.length === 0
  ) {
    last.content += text;
    return;
  }
  session.messages.push(stampProducingModel(session, makeAssistantTextMessage(text)));
}

function appendThoughtToDraft(s: ChatDraft, acpSessionId: string, text: string): void {
  if (!text) return;
  const tid = findTabByAcpSession(s.sessions, acpSessionId);
  if (!tid) return;
  const session = s.sessions[tid];
  const last = session.messages[session.messages.length - 1];
  if (last && last.role === "assistant" && last.mode === "thinking") {
    last.thinking = (last.thinking ?? "") + text;
    return;
  }
  session.messages.push(stampProducingModel(session, makeAssistantThinkingMessage(text)));
}

/** A terminal (idle/error) delta carries the `turn_seq` of the turn it ends.
 *  Reject one whose turn is older than the session's current turn — a newer
 *  send already superseded it (the parallel / queued / wake premature-"done"
 *  class). A missing or 0 `turn_seq` (native cersei agent) is treated as
 *  current, so nothing regresses there. */
/** Fire-and-forget backend teardown for a closed tab's session: the manager
 *  drops the actor + the driver-side guard (M6 — these used to leak for the
 *  whole process lifetime). UI state removal proceeds regardless. */
function dropBackendSession(session: ChatSession | undefined): void {
  if (!session?.acpAgentId || !session.acpSessionId || session.disconnected) return;
  void agents.dropSession(session.acpAgentId, session.acpSessionId).catch(() => {});
}

function isStaleTurn(session: ChatSession, turnSeq: number | undefined): boolean {
  if (!turnSeq) return false;
  return turnSeq < (session.currentTurnSeq ?? 0);
}

function applyDeltaToDraft(s: ChatDraft, env: AgentDelta): void {
  const tid = findTabByAcpSession(s.sessions, env.session_id);
  if (!tid) return;
  const session = s.sessions[tid];
  switch (env.kind) {
    case "status": {
      const seq = env.turn_seq;
      if (env.status === "running" || env.status === "waiting") {
        // Turn start / paused-for-user (plan / permission): adopt the turn
        // identity and stay in an active (busy) state.
        if (seq && seq > (session.currentTurnSeq ?? 0)) {
          session.currentTurnSeq = seq;
          // New turn — clear the previous turn's live plan so the docked panel
          // doesn't show a stale one before this turn emits its own.
          session.livePlan = undefined;
          // Start a fresh per-turn files-touched scratch for the adaptive card.
          session.turnScratch = { seq, tools: {} };
        }
        session.status = env.status;
        return;
      }
      // idle / error are terminal — drop one for an already-superseded turn.
      if (isStaleTurn(session, seq)) return;
      const terminal = env.status === "idle" ? "idle" : "error";
      // Sweep any tool call still pending/running to a terminal state — a bare
      // `status: idle` (one that arrives without an accompanying turn_finished)
      // must not leave a phantom spinner. Mirrors the turn_finished sweep
      // below. Rust also sweeps authoritatively before emitting the terminal;
      // this is the view-side guard against any residual race.
      for (const msg of session.messages) {
        for (const tc of msg.toolCalls) {
          if (tc.status === "pending" || tc.status === "running") {
            tc.status = terminal === "error" ? "failed" : "completed";
          }
        }
      }
      session.status = terminal;
      session.stopping = undefined;
      session.retryStatus = undefined;
      // No permission modal survives its turn: the Rust finalize sweep emits
      // permission_resolved for each, but a lost/raced delta must not leave a
      // clickable modal on an idle turn (its click would strand the session).
      delete s.pendingPermissions[env.session_id];
      return;
    }
    case "turn_finished": {
      // Reject a terminal for a turn already superseded by a newer send —
      // don't flip to idle or inject an empty-turn placeholder for stale turns.
      if (isStaleTurn(session, env.turn_seq)) return;
      // Empty-turn detection: if no assistant content arrived
      // between the last user message and turn-end, insert a
      // placeholder so the UI doesn't show a vanishing spinner.
      let lastUserIdx = -1;
      for (let i = session.messages.length - 1; i >= 0; i--) {
        if (session.messages[i].role === "user") {
          lastUserIdx = i;
          break;
        }
      }
      const responded = session.messages
        .slice(lastUserIdx + 1)
        .some(
          (m) =>
            m.role === "assistant" &&
            ((m.content && m.content.length > 0) ||
              m.toolCalls.length > 0 ||
              (m.thinking && m.thinking.length > 0)),
        );
      if (!responded && env.stop_reason !== "cancelled") {
        const label =
          env.stop_reason === "end_turn"
            ? "(no response — the agent ended its turn without output)"
            : `(no response — stop_reason: ${env.stop_reason})`;
        session.messages.push(makeAssistantTextMessage(label));
      }
      // Resolve any tool calls still in pending/running state on EVERY
      // terminal, not just cancel. After Stop the driver gate drops further
      // updates; on a normal end a dropped/raced final `tool_call_update`
      // leaves the same phantom loader. The turn is over either way — sweep
      // to a terminal state so no card can spin forever.
      for (const msg of session.messages) {
        for (const tc of msg.toolCalls) {
          if (tc.status === "pending" || tc.status === "running") {
            tc.status = env.stop_reason === "cancelled" ? "failed" : "completed";
          }
        }
      }
      // Stamp the producing model onto this turn's assistant messages. The
      // badge must be a historical fact per message — deriving it from live
      // session state relabels the whole thread when the session's model or
      // agent changes later (the "Claude messages labeled Gemini" leak).
      const producingModel = resolveModelLabel(
        session.acpCurrentModel,
        session.agentType,
        session.acpAvailableModels,
      );
      if (producingModel) {
        for (let i = lastUserIdx + 1; i < session.messages.length; i++) {
          const m = session.messages[i];
          if (m.role === "assistant" && !m.model) m.model = producingModel;
        }
      }
      session.status =
        env.stop_reason === "end_turn" || env.stop_reason === "cancelled" ? "idle" : "error";
      session.stopping = undefined;
      session.retryStatus = undefined;
      delete s.pendingPermissions[env.session_id];
      // Per-turn usage footer (native agent): derive this turn's tokens/cost as
      // the delta from the previous turn's cumulative snapshot, and attach it to
      // the trailing assistant message so it renders at the end of the turn.
      if (session.usage && session.agentType === "cersei") {
        const cum = {
          input: session.usage.input_tokens ?? 0,
          output: session.usage.output_tokens ?? 0,
          cost: session.usage.cost ?? 0,
        };
        const prev = session.lastUsageSnapshot ?? {
          input: 0,
          output: 0,
          cost: 0,
        };
        const turn = {
          input: Math.max(0, cum.input - prev.input),
          output: Math.max(0, cum.output - prev.output),
          cost: Math.max(0, cum.cost - prev.cost),
          saved: session.pendingSavedTokens ?? 0,
        };
        session.lastUsageSnapshot = cum;
        session.pendingSavedTokens = undefined;
        if (turn.input + turn.output > 0) {
          for (let i = session.messages.length - 1; i >= 0; i--) {
            if (session.messages[i].role === "assistant") {
              session.messages[i].usage = turn;
              break;
            }
          }
        }
      }
      // ACP agents (Claude Code / Codex) can't report a per-turn input/output
      // split, but they stream a cumulative context-window gauge. Snapshot the
      // latest onto the trailing assistant message so its turn card renders a
      // context gauge in the same slot the native agent uses for per-turn usage.
      if (session.contextUsage && session.agentType !== "cersei") {
        for (let i = session.messages.length - 1; i >= 0; i--) {
          if (session.messages[i].role === "assistant") {
            session.messages[i].contextUsage = { ...session.contextUsage };
            break;
          }
        }
      }
      // Freeze the per-turn files-touched scratch onto the trailing assistant
      // message as `turnSummary` (mirrors the usage attach above). Only here at
      // turn end, so the adaptive card never appears mid-stream. `repoAtTurn` is
      // set by the card component (the store stays free of git/app deps).
      if (session.turnScratch) {
        const files = aggregateTurnFiles(session.turnScratch.tools);
        if (files.length > 0) {
          for (let i = session.messages.length - 1; i >= 0; i--) {
            if (session.messages[i].role === "assistant") {
              session.messages[i].turnSummary = {
                turnSeq: session.turnScratch.seq,
                files,
                repoAtTurn: false,
              };
              break;
            }
          }
        }
        session.turnScratch = undefined;
      }
      // Agent-generated next-step chips: extract the trailing assistant reply's
      // hidden `<next_steps>` block into click-to-send suggestions. The raw
      // content (with the block) stays in the store; the display path strips it.
      for (let i = session.messages.length - 1; i >= 0; i--) {
        const m = session.messages[i];
        if (m.role !== "assistant") continue;
        const chips = extractNextSteps(m.content);
        if (chips.length > 0) {
          m.suggestions = {
            turnSeq: env.turn_seq ?? 0,
            status: "ready",
            chips,
          };
        }
        break;
      }
      return;
    }
    case "turn_failed": {
      if (isStaleTurn(session, env.turn_seq)) return;
      // Sweep live tool calls to failed — turn_finished and the bare terminal
      // status both have this guard (no spinner outlives its turn), and this was
      // the one terminal without it. Rust usually pairs TurnFailed with a
      // Status(error) whose sweep covers it, but the view-side guard exists
      // precisely because a paired delta can be lost or raced.
      for (const msg of session.messages) {
        for (const tc of msg.toolCalls) {
          if (tc.status === "pending" || tc.status === "running") tc.status = "failed";
        }
      }
      // Don't hardcode "ACP error" — the native Atlas (cersei) agent is
      // in-process and shares this error delta, so its provider errors (e.g. a
      // Gemini HTTP 400) were being mislabeled as ACP failures. Use a neutral
      // prefix.
      session.messages.push(makeAssistantTextMessage(`Error: ${env.error}`));
      session.status = "error";
      session.stopping = undefined;
      session.retryStatus = undefined;
      // Auth failures route to the agent's sign-in flow (P15) instead of
      // dying as a generic banner. The composer components listen for this
      // (Claude → login dialog, Codex → sign-in pill); native/BYOK keys are
      // covered by the error text pointing at Settings → API Keys.
      if (env.error_kind === "auth") {
        window.dispatchEvent(
          new CustomEvent("atlas:auth-required", {
            detail: { sessionId: env.session_id, agentType: session.agentType },
          }),
        );
      }
      delete s.pendingPermissions[env.session_id];
      return;
    }
    case "agent_disconnected": {
      // The backing process died. Rust already emitted TurnFailed + Status
      // (error) for busy sessions; here we flag the session so the composer
      // offers Restart and the next send rebinds (respawn + resume). Binding
      // fields stay — acpSessionId IS the on-disk id resume needs (P14).
      session.disconnected = true;
      session.stopping = undefined;
      session.retryStatus = undefined;
      return;
    }
    case "retry_status": {
      session.retryStatus = {
        attempt: env.attempt,
        maxAttempts: env.max_attempts,
        delayMs: env.delay_ms,
        lastError: env.last_error,
        receivedAt: Date.now(),
      };
      return;
    }
    case "text_chunk": {
      // Delegate to the shared helper so text chunks routed through the
      // delta stream get the SAME "find last renderable message" logic the
      // narration bucket used — skipping empty placeholder/thinking markers
      // so one continuous narration never splits into broken fragments.
      session.retryStatus = undefined; // content resumed — the retry succeeded
      appendTextToDraft(s, env.session_id, env.delta);
      return;
    }
    case "thinking_chunk": {
      session.retryStatus = undefined;
      appendThoughtToDraft(s, env.session_id, env.delta);
      return;
    }
    case "message_appended": {
      // Convert the Rust-shaped message into a ChatMessage and push.
      // Rust already decided this is a new message; the frontend
      // mirrors without re-deciding.
      const m = env.message;
      const appended: ChatMessage = {
        id: m.id,
        role: m.role,
        content: m.content,
        thinking: m.thinking ?? "",
        toolCalls: m.tool_calls.map(toChatToolCall),
        fileChanges: [],
        plan: m.plan
          ? m.plan.map((e, idx) => ({
              id: `plan-${idx}`,
              description: e.content,
              status: (e.status as "pending" | "in_progress" | "completed") ?? "pending",
            }))
          : null,
        timestamp: m.timestamp,
        mode: m.mode,
      };
      if (appended.role === "assistant") stampProducingModel(session, appended);
      session.messages.push(appended);
      return;
    }
    case "tool_call_upserted": {
      // Accumulate per-turn files-touched for the adaptive turn card, keyed by
      // tool id so repeated pending→completed upserts are idempotent (O(1), no
      // message rescan). Frozen into the trailing message at turn_finished.
      if (session.turnScratch) {
        const tc = env.tool_call;
        const args = (tc.arguments ?? {}) as Record<string, unknown>;
        const path = getFilePathFromInput(args);
        const kind = classifyToolFileKind(tc.kind, tc.tool_name);
        if (path && kind) {
          const { added, removed } =
            kind === "edit" ? countEditLines(tc.tool_name, args) : { added: 0, removed: 0 };
          const created = kind === "edit" ? isFileCreated(tc.tool_name, args) : undefined;
          session.turnScratch.tools[tc.id] = {
            path,
            kind,
            added,
            removed,
            created,
          };
        }
      }
      const found = findToolCall(session, env.tool_call.id);
      if (found) {
        Object.assign(found.tc, toChatToolCall(env.tool_call));
        return;
      }
      // Collapse consecutive tool calls into ONE assistant message
      // so the thread doesn't render N separate message-item boxes
      // (each with its own padding) for every Find/Read/Bash the
      // agent emits in a single turn. If the trailing message is
      // already an assistant tool-mode message, just append the new
      // tool call to its `toolCalls` array; the MessageItem renders
      // all cards in one stacked group with tight internal
      // `space-y-1.5`. Only when the trailing message ISN'T a tool
      // message (text/thinking intervened) do we start a fresh tool
      // message.
      const last = session.messages[session.messages.length - 1];
      if (last && last.role === "assistant" && last.mode === "tool") {
        last.toolCalls.push(toChatToolCall(env.tool_call));
        return;
      }
      session.messages.push(
        stampProducingModel(session, makeAssistantToolMessage(toChatToolCall(env.tool_call))),
      );
      return;
    }
    case "plan_updated": {
      const last = session.messages[session.messages.length - 1];
      const planSteps = env.plan.map((e, idx) => ({
        id: `plan-${idx}`,
        description: e.content,
        status: (e.status as "pending" | "in_progress" | "completed") ?? "pending",
      }));
      if (last && last.role === "assistant") {
        last.plan = planSteps;
      } else {
        const fresh = stampProducingModel(session, makeAssistantTextMessage(""));
        fresh.plan = planSteps;
        session.messages.push(fresh);
      }
      // Mirror onto the session so the docked plan panel selects it directly.
      session.livePlan = planSteps;
      return;
    }
    case "available_commands": {
      session.availableCommands = env.commands;
      return;
    }
    case "mode_changed": {
      session.acpCurrentMode = env.mode_id;
      // Reflect agent-driven permission-mode changes back into the composer
      // pill. Claude Code emits `current_mode_update` when the user picks a
      // mode at the plan-review prompt (e.g. "bypass permissions") — without
      // this the pill kept showing the old mode. Guarded to claude-code + a
      // known permission mode so Codex's own modes don't leak into the pill.
      if (
        session.agentType === "claude-code" &&
        (CLAUDE_PERMISSION_MODES as readonly string[]).includes(env.mode_id)
      ) {
        session.claudePermissionMode = env.mode_id as ClaudePermissionMode;
      }
      return;
    }
    case "usage_updated": {
      session.usage = env.usage;
      return;
    }
    case "context_usage": {
      session.contextUsage = {
        used: env.used,
        size: env.size,
        cost: env.cost,
      };
      // Persist keyed by the stable transcript id so the gauge survives a
      // session switch (messages reload from disk) and an app restart (store
      // is gone). Restored in `replaceMessages`.
      if (session.acpSessionId) {
        saveCachedContextUsage(session.acpSessionId, session.contextUsage);
      }
      return;
    }
    case "compaction": {
      session.compacting = env.active;
      return;
    }
    case "compression_saved": {
      // Stashed until turn_finished folds it into the message's usage footer.
      session.pendingSavedTokens = env.saved_tokens;
      return;
    }
    case "model_changed": {
      // The native Cersei agent's model is UI-driven and stored as a BARE id
      // (its provider lives in `cerseiProvider`). The worker echoes back the
      // full "provider/model" we pushed, so applying it here would re-prefix
      // the value every cycle ("google/google/google/…") via the composer's
      // re-push. Ignore the echo for cersei — the UI is the source of truth.
      if (session.agentType !== "cersei") session.acpCurrentModel = env.model_id;
      return;
    }
    default:
      return;
  }
}
