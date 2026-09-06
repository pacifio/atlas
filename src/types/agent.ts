import type { SessionModeInfo } from "./agents";

/** The agents Atlas has first-party BRANDING for — labels, brand icons and
 *  `.agent-*` CSS tokens, which are Atlas's own design rather than registry
 *  metadata. It is not a list of agents that exist: apart from `cersei` (the
 *  native agent) every one of these must be installed from the Marketplace
 *  before it can run (ADR-0002), and an installed agent with no entry here
 *  simply renders from its registry metadata. */
export type FirstPartyAgent = "claude-code" | "codex" | "opencode" | "cursor" | "kilo" | "cersei";

/** Agent identity is plugin-id-first and OPEN (Paseo-style): the first-party
 *  literals keep autocomplete/narrowing, but any registry-installed plugin id
 *  is a valid agent type. `"custom"` survives as a legacy value only. */
export type AgentType = FirstPartyAgent | "custom" | (string & {});

/** Open alias — kept for call-site readability where "switchable" intent
 *  matters. The actual switchable list is dynamic and entirely catalog-derived:
 *  `useSwitchableAgents()` in features/agents (the native agent + whatever the
 *  user installed). */
export type SwitchableAgent = FirstPartyAgent | (string & {});

/** The native, in-process agent. The one id that is always runnable: it needs
 *  no install, cannot be uninstalled, and is what a fresh profile offers on its
 *  own (ADR-0002 — Atlas ships no ACP agents).
 *
 *  This is NOT a default ACP agent and must never be used as a stand-in for
 *  one; it is the identity of "Atlas itself". The switchable list is otherwise
 *  entirely catalog-derived — see `switchableAgentIds()` in features/agents. */
export const NATIVE_AGENT_ID = "cersei";

/** Upstream 0.3.0-x's name for the same constant — its identity model calls
 *  the native agent `NATIVE_AGENT` and files merged from that line import it
 *  under this name. One value, two spellings; do not let them diverge. */
export const NATIVE_AGENT = NATIVE_AGENT_ID;

/** First-party labels. For externals use `agentMeta(id).label`
 *  (features/agents/lib/agent-meta). */
export const AGENT_LABEL: Record<FirstPartyAgent, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  kilo: "Kilo",
  // The key is the stored agent id, which stays `cersei` forever because every
  // recorded thread resolves through it (D7). The label is the product name.
  // They are deliberately different things.
  cersei: "Atlas Agent",
};

/** The Rust-side spawnable plugin id for each first-party agent (see
 *  `AgentSpec::all_known()` in crates/atlas-acp). Single source of truth —
 *  every agentType→pluginId decision goes through `pluginIdForAgent`. */
export const PLUGIN_ID_BY_AGENT: Record<FirstPartyAgent, string> = {
  "claude-code": "claude-code-ts",
  codex: "codex",
  opencode: "opencode",
  cursor: "cursor",
  kilo: "kilo",
  cersei: "cersei",
};

function isFirstPartyAgent(agentType: string): agentType is FirstPartyAgent {
  return Object.prototype.hasOwnProperty.call(PLUGIN_ID_BY_AGENT, agentType);
}

/** The spawnable spec id for an agent type.
 *
 *  No identity at all — absent, or the retired `"custom"` — routes to the
 *  NATIVE agent. It used to route to Claude Code, the last hardcoded default
 *  plugin id: on a fresh profile that silently aimed at an agent nobody had
 *  installed, and it is reached for real by resuming a history row that
 *  recorded no agent type. `switchableAgentOf` already resolves the same
 *  inputs to the native agent, and the two must not disagree about one
 *  session (ADR-0002). */
export function pluginIdForAgent(agentType: AgentType | undefined): string {
  if (!agentType || agentType === "custom") return PLUGIN_ID_BY_AGENT[NATIVE_AGENT_ID];
  if (isFirstPartyAgent(agentType)) return PLUGIN_ID_BY_AGENT[agentType];
  // External agents: the agent type IS the plugin id.
  return agentType;
}

/** Derive the display agent type from a spawnable plugin id. Unknown ids pass
 *  through unchanged — an external agent's identity is its plugin id, and
 *  collapsing it (the old `"custom"` fallback) lost it forever. */
export function agentTypeFromPluginId(pluginId: string): AgentType {
  if (pluginId === "codex") return "codex";
  if (pluginId === "opencode") return "opencode";
  if (pluginId === "cursor") return "cursor";
  if (pluginId === "kilo") return "kilo";
  if (pluginId === "cersei") return "cersei";
  // The NATIVE claude ids only — the current spec id and the legacy one old
  // history rows recorded. A `startsWith("claude")` here also swallowed the
  // EXTERNAL registry agent "claude-acp", whose identity is its plugin id:
  // every snapshot-seed gate then compared the collapsed "claude-code" against
  // the tab's real "claude-acp", dropped the seed as stale, and the
  // modes/knobs pills starved. Same bug `switchableAgentOf` was already
  // cured of — externals pass through.
  if (pluginId === "claude-code-ts" || pluginId === "claude-code") return "claude-code";
  return pluginId;
}
export type AgentStatus = "idle" | "running" | "waiting" | "done" | "error";

/** True when the agent is actively working OR paused waiting on the user (a
 *  permission / plan approval). Both must keep the "busy" affordance so the
 *  spinner / composer never look "done" while a turn is still in progress. */
export function isBusyAgentStatus(status: string | undefined): boolean {
  return status === "running" || status === "waiting";
}

/** True if any tool call in the session is still non-terminal (pending/running).
 *  The composer stays "busy" while tools are in flight even if `status` has
 *  (racily) flipped to idle, so it never re-enables ahead of a still-spinning
 *  tool card. Rust is authoritative — it defers turn-end until tool calls
 *  quiesce — this is the thin view-side guard against any residual race.
 *  O(1): reads the store-maintained `inflightToolIds` map (synced on
 *  tool_call_upserted, swept on every terminal) — ChatPanel calls this once
 *  per streaming frame, so an O(messages) rescan here was per-frame cost. */
export function hasInFlightToolCalls(
  session: { inflightToolIds?: Record<string, true> } | undefined,
): boolean {
  const ids = session?.inflightToolIds;
  if (!ids) return false;
  for (const _ in ids) return true;
  return false;
}
export type MessageRole = "user" | "assistant" | "system" | "tool";
/** Claude Code's permission modes as the ACP adapter spells them. `auto`
 *  ("Claude handles permission decisions") exists only on models that support
 *  it — the adapter advertises it per session, and it is what the plan-approval
 *  prompt's elevated option becomes on those models (in place of bypass). It
 *  has to be a known mode here or the composer pill goes stale the moment a
 *  plan is approved with it. */
export type ClaudePermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions"
  | "auto";

export const CLAUDE_PERMISSION_MODES: ClaudePermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "auto",
];

export const CLAUDE_PERMISSION_MODE_LABEL: Record<ClaudePermissionMode, string> = {
  default: "Default",
  acceptEdits: "Accept Edits",
  plan: "Plan Mode",
  bypassPermissions: "Bypass Permissions",
  auto: "Auto",
};

/** One file a turn read or modified, with edit line counts (0 for reads). */
export interface TurnFile {
  path: string;
  kind: "read" | "edit";
  added: number;
  removed: number;
  /** For edits only: the file was created new (all edit ops had empty `old`) →
   *  git-status "A"; otherwise "M". Undefined for reads. */
  created?: boolean;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  agentType: AgentType;
  model: string;
  status: AgentStatus;
  /** True between the user clicking Stop and the cancelled turn's terminal
   *  delta arriving. The UI must NOT flip to idle optimistically on Stop —
   *  the backend may still be winding tools down, and an "idle" lie here let
   *  the user start a second turn while the first was live (the interleave /
   *  history-loss race). Cleared by every terminal (idle/error/turn_finished/
   *  turn_failed). */
  stopping?: boolean;
  /** The agent process backing this session died (agent_disconnected). The
   *  binding fields are kept for resume — the next send (or the Restart
   *  affordance) respawns the agent and load_session-resumes where the
   *  transcript kind supports it. Never auto-restarted silently. */
  disconnected?: boolean;
  /** Live retry countdown (native agent): a transient provider failure is
   *  being retried after a backoff. Cleared when content resumes flowing or
   *  the turn ends. */
  retryStatus?: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    lastError: string;
    /** ms epoch when this retry status arrived (for the countdown). */
    receivedAt: number;
  };
  /** Ids of tool calls currently pending/running, maintained incrementally on
   *  tool_call_upserted and swept (to undefined) on every terminal — the O(1)
   *  source for `hasInFlightToolCalls`. */
  inflightToolIds?: Record<string, true>;
  /** Turn identity of this session's current/most-recent turn, taken from the
   *  Rust `turn_seq` on status/terminal deltas. Used to reject a stale terminal
   *  (idle/error) belonging to a turn already superseded by a newer send —
   *  the guard against premature "done" under parallel / queued / wake timing.
   *  Absent (or 0) for the native cersei agent, which is treated as current. */
  currentTurnSeq?: number;
  /** The current turn's live plan (ACP `plan` / TodoWrite), mirrored here from
   *  the trailing assistant message so the docked plan panel above the composer
   *  can select it with one narrow read instead of scanning `messages` every
   *  streaming frame. Set on `plan_updated`, reset at each turn start. The dock
   *  hides itself when this is empty or fully completed while idle. */
  livePlan?: PlanStep[];
  /** Per-turn scratch: files the current turn has read/edited, keyed by tool
   *  call id so repeated pending→completed upserts are idempotent (no message
   *  rescans). Reset at turn start, frozen into the trailing message's
   *  `turnSummary` at turn_finished, then cleared. */
  turnScratch?: {
    seq: number;
    tools: Record<string, TurnFile>;
  };
  workingDirectory: string;
  tasks: AgentTask[];
  createdAt: string;
  updatedAt: string;
  /** Claude-only permission mode. Absent for non-Claude agents (e.g. Codex),
   *  which drive their modes via the generic ACP `acpCurrentMode`/snapshot. */
  claudePermissionMode?: ClaudePermissionMode;
  /** True only after the user explicitly changes Claude's mode in this tab. */
  claudePermissionModeExplicit?: boolean;
  /** Id of the user message sent JUST NOW — the only row that plays the
   *  composer-side bubble entrance animation (see UserRowView). */
  justSentMessageId?: string;
  /** ACP agent process bound to this tab (set eagerly when the tab mounts). */
  acpAgentId?: string;
  /**
   * Session id bound to this tab. This is the SAME identifier the canonical
   * Claude Code agent writes its JSONL transcript under in
   * `~/.claude/projects/<encoded-cwd>/<id>.jsonl` — so it's both the ACP
   * session id and the on-disk session id. One name, one field.
   */
  acpSessionId?: string;
  /** Currently selected ACP session mode (default / acceptEdits / plan / …). */
  acpCurrentMode?: string;
  /** True only after the user explicitly changes an ACP mode in this tab. */
  acpModeExplicit?: boolean;
  /** Modes the agent advertised for this session — drives the composer's mode
   *  picker for non-Claude agents (e.g. Codex). Seeded from the snapshot. */
  acpAvailableModes?: SessionModeInfo[];
  /** True while a non-Claude session is still booting (agent spawn + new_session)
   *  and its real modes haven't been confirmed yet. When true the composer shows
   *  the picker in a loading state, optimistically pre-filled from the persisted
   *  per-agent modes cache so switching feels instant. Cleared by `setAcpModes`. */
  acpModesPending?: boolean;
  /** Currently selected ACP model id (default / sonnet / haiku / …). For the
   *  native Cersei agent this is the bare model id; the provider lives in
   *  `cerseiProvider` and the two are pushed to the backend as `provider/model`. */
  acpCurrentModel?: string;
  /** Raw ACP `configOptions` for this session (P2.2). Kept current by the
   *  `config_options_updated` delta so a knob toggled INSIDE the agent is
   *  reflected without waiting for a snapshot refetch. */
  acpConfigOptions?: unknown[];
  /** An unanswered `elicitation/create` from the agent (P3.3). */
  pendingElicitation?: {
    agentId: string;
    requestId: string;
    mode: "form" | "url";
    message: string;
    requestedSchema?: unknown;
    url?: string | null;
  };
  /** Models the ACP agent advertised (Claude Code / Codex) — drives the
   *  composer's model picker. Seeded from the snapshot's `available_models`;
   *  empty for agents (or the native one) that don't expose ACP model lists. */
  acpAvailableModels?: SessionModeInfo[];
  /** BYOK provider id backing the native Cersei agent's model selection
   *  (e.g. "anthropic", "openai"). Unused by the ACP agents. */
  cerseiProvider?: string;
  /** Cumulative token/cost usage for the session (native agent surfaces it via
   *  `usage_updated` deltas; drives the composer's token/cost pill). */
  usage?: import("./agents").Usage;
  /** Latest ACP context-window gauge (Claude Code / Codex) from `context_usage`
   *  deltas — `used`/`size` tokens + cost. Snapshotted onto the trailing
   *  assistant message at turn end (ACP agents have no per-turn in/out split). */
  contextUsage?: { used: number; size: number; cost: number };
  /** True while the native agent is compacting its context window. */
  compacting?: boolean;
  /** Reasoning-effort level for the native agent ("" / low / medium / high /
   *  max). Only meaningful for Anthropic models (maps to a thinking budget). */
  cerseiEffort?: string;
  /** RTK tool-output compression for the native agent (default on). */
  cerseiCompress?: boolean;
  /** Cumulative usage snapshot at the end of the previous turn — used to derive
   *  per-turn usage for the message footer. */
  lastUsageSnapshot?: { input: number; output: number; cost: number };
  /** Tokens RTK compression saved on the in-flight turn, captured from the
   *  `compression_saved` delta and folded into the usage footer at turn end. */
  pendingSavedTokens?: number;
  /** Available slash commands as reported by the agent for this session. */
  availableCommands?: unknown[];
  /**
   * Cached preview/count fields the sidebar reads. Maintained by the store
   * on user-message inserts and bulk replace so the sidebar's per-tab
   * summary doesn't have to scan `messages` on every streaming chunk.
   */
  firstUserContent?: string;
  userMessageCount?: number;
  /**
   * True while the tab is asynchronously hydrating a historical transcript
   * from disk (sidebar click → `readClaudeSession`). The chat panel renders
   * a "loading transcript" placeholder instead of the welcome state during
   * this window so navigation never flashes the empty page.
   */
  transcriptLoading?: boolean;
  /**
   * True between the OPTIMISTIC bind of a resumed session and the moment the
   * backend has actually loaded it (agent spawn + ACP `session/load`).
   *
   * Resume paints the transcript from disk long before the session is sendable
   * (see `resumeSessionFast`), so `acpSessionId` being set is no longer proof
   * that Rust knows about the session — sending in that window would hit a
   * session the manager never installed. `handleSend` treats this exactly like
   * "not bound yet" and queues the prompt; the drain effect flushes it when the
   * flag clears.
   */
  resumePending?: boolean;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  /** Images the user attached to this message. Optimistic user-echo only —
   *  never set on assistant messages, and not recovered on session replay
   *  (Rust history is text-only). Rendered as thumbnails in the bubble. */
  attachments?: import("./agents").ImageAttachment[];
  toolCalls: ToolCallDisplay[];
  fileChanges: FileChange[];
  plan: PlanStep[] | null;
  timestamp: string;
  /**
   * Discriminator for ACP-driven assistant messages. Splits one logical "turn"
   * into a sequence of single-purpose messages so they render in event order
   * (text, then tool, then text, then thinking, etc.).
   *
   * - "text": markdown content
   * - "tool": one or more tool calls only
   * - "thinking": collapsible thought chunks
   *
   * Undefined for legacy / user / system / chat-API messages — falls back to
   * the original combined render.
   */
  mode?: "text" | "tool" | "thinking";
  /** Accumulated thinking chunks; only set when mode === "thinking". */
  thinking?: string;
  /** Pre-split for user messages composed via the @-mention picker. The
   *  composer appends a "Atlas context" suffix to the prose; storing
   *  the split + block count here means MessageItem doesn't re-run a
   *  regex on `content` for every render. Computed once in `addMessage`
   *  when the message is inserted. Undefined for messages that don't
   *  carry an Atlas-context block (every assistant message, every user
   *  message sent without `@` mentions). */
  atlasProse?: string;
  atlasContext?: string;
  atlasContextBlockCount?: number;
  /** Per-turn token usage + cost for the native agent, attached when the turn
   *  finishes. Drives the end-of-message usage footer. `saved` = approx tokens
   *  RTK compression shaved off this turn (0 when compression was off). */
  usage?: { input: number; output: number; cost: number; saved?: number };
  /** ACP context-window gauge (Claude Code / Codex) frozen onto the trailing
   *  assistant message at turn end. These agents can't report a per-turn
   *  input/output split, so the card shows this `used`/`size` context gauge in
   *  the same slot the native agent uses for `usage`. */
  contextUsage?: { used: number; size: number; cost: number };
  /** Adaptive per-turn footer, frozen onto the trailing assistant message at
   *  turn_finished (mirrors `usage` — never set mid-stream). Drives the
   *  TurnSummaryCard's files-read/modified accordion + action buttons. */
  turnSummary?: {
    turnSeq: number;
    files: TurnFile[];
    /** Whether the workspace was a git repo when the turn ended (gates commit). */
    repoAtTurn: boolean;
  };
  /** Agent-suggested next steps for this turn's footer. Generated once at
   *  turn end (parse-first, optional BYOK). `turnSeq` guards against a stale
   *  async result landing after a newer turn started. */
  suggestions?: {
    turnSeq: number;
    status: "idle" | "loading" | "ready" | "error";
    chips: string[];
  };
  /** Model that produced this assistant message, stamped when the message is
   *  created (and backstopped at turn end). The badge renders ONLY this —
   *  never live session state — so a later model or agent switch can't
   *  relabel messages produced by a different model. Unstamped messages
   *  (pre-fix history, disk-hydrated transcripts) render no badge. */
  model?: string;
}

/**
 * A tool-content block that renders structurally rather than as result text
 * (P1.4). Mirrors `atlas_agents::session::ToolContentBlock` — the Rust test
 * `blocks_serialize_to_the_shape_the_frontend_expects` pins this wire shape.
 */
export type ToolContentBlock =
  /** An edit the agent proposed or made. `oldText` is absent for a new file. */
  | { type: "diff"; path: string; oldText?: string; newText: string }
  /** A terminal the agent created via ACP `terminal/*`. */
  | { type: "terminal"; terminalId: string };

export interface ToolCallDisplay {
  id: string;
  toolName: string;
  /** ACP semantic class: "execute" | "read" | "edit" | "fetch" | … . The
   *  reliable way to recognise a bash/shell call — `toolName` is the ACP
   *  `title`, which for Bash is the command itself, not "bash". */
  kind: string | null;
  arguments: Record<string, unknown>;
  result: string | null;
  status: "pending" | "running" | "completed" | "failed";
  duration: number | null;
  /**
   * Structural content the agent attached to this call. Absent for almost every
   * call — only ACP agents that report edits as `ToolCallContent::Diff` (rather
   * than as recognisable Write/Edit arguments) populate it.
   */
  contentBlocks?: ToolContentBlock[];
}

export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
  status: "added" | "modified" | "deleted";
}

export interface PlanStep {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed";
}

export interface AgentTask {
  id: string;
  title: string;
  status: "action_needed" | "running" | "done" | "error";
  linesAdded: number;
  linesRemoved: number;
}
