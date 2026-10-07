// A stand-in for the agent host. Sessions are kept here so `agents_snapshot*`
// agree with what was streamed, and a scenario's transcript reaches the chat
// the way a real one does: as `atlas:agents` deltas.

import { emit } from "@tauri-apps/api/event";
import type { AgentInfo, PermissionDecision, PermissionOptionRef } from "@/types/acp";
import type {
  AgentDelta,
  SessionInit,
  SessionKey,
  SessionMessage,
  SessionModeInfo,
  SessionSnapshot,
  ToolCall,
} from "@/types/agents";
import type { TypedHandlers, Unit } from "./types";
import { text, tool, tools } from "./fixtures/chat";
import {
  askUserQuestionMulti,
  askUserQuestionSingle,
  exitPlanOptions,
  LONG_COMMAND,
  LONG_COMMAND_RESULT,
  PLAN_MARKDOWN,
  permissionToolCall,
  standardOptions,
} from "./fixtures/permission";

interface FakeSession {
  key: SessionKey;
  cwd: string;
  pluginId: string;
  messages: SessionMessage[];
}

const sessions = new Map<string, FakeSession>();
let seq = 0;

/** What a new session replays once it is bound. Set by a scenario. */
let seedTranscript: SessionMessage[] = [];
export function setSeedTranscript(messages: SessionMessage[]): void {
  seedTranscript = messages;
}

/** What a scenario knows about one new session, to decide its seed. */
export interface NewSessionInfo {
  sessionId: string;
  pluginId: string;
  cwd: string;
}

/**
 * Per-session seeding, for a scenario that wants ONE chat to open on a
 * recorded transcript and every later one empty. Wins over
 * `setSeedTranscript` when set; return `null` to seed nothing.
 */
let sessionSeeder: ((info: NewSessionInfo) => SessionMessage[] | null) | null = null;
export function setSessionSeeder(seeder: typeof sessionSeeder): void {
  sessionSeeder = seeder;
}

/**
 * A scenario's answer to a prompt. Return `true` when it has handled the turn
 * (streamed its own reply), and the default echo is skipped.
 */
export type PromptHandler = (info: NewSessionInfo & { text: string }) => boolean;
let promptHandler: PromptHandler | null = null;
export function setPromptHandler(handler: PromptHandler | null): void {
  promptHandler = handler;
}

/** The model a session reports, per agent — so a scenario's composer never
 *  says "Mock model". */
export interface AgentModels {
  current: string;
  available: SessionModeInfo[];
}
let modelsFor: ((pluginId: string) => AgentModels | null) | null = null;
export function setAgentModels(lookup: typeof modelsFor): void {
  modelsFor = lookup;
}

/** The slash commands a session advertises, per agent (ACP
 *  `available_commands`: `{ name, description, input? }`). */
let commandsFor: ((pluginId: string) => unknown[] | null) | null = null;
export function setAgentCommands(lookup: typeof commandsFor): void {
  commandsFor = lookup;
}

/** The name `agents_spawn` reports, per agent. */
let displayNameFor: ((pluginId: string) => string | null) | null = null;
export function setAgentDisplayNames(lookup: typeof displayNameFor): void {
  displayNameFor = lookup;
}

/** The session `sessionId` names, or the most recent one. */
function latest(sessionId?: string): FakeSession | undefined {
  if (sessionId) return sessions.get(sessionId);
  const all = [...sessions.values()];
  return all[all.length - 1];
}

const at = (s: FakeSession) => ({ agent_id: s.key.agent_id, session_id: s.key.session_id });

export function sendDelta(delta: AgentDelta): Promise<void> {
  return emit("atlas:agents", delta);
}

/** Name a session as the agent would (`title_updated`): a seeded chat opens titled, not "New chat". */
export function sendTitle(sessionId: string, title: string): Promise<void> {
  const s = latest(sessionId);
  if (!s) return Promise.resolve();
  return sendDelta({ kind: "title_updated", ...at(s), title });
}

/**
 * Load a session the agent did not start in this run — what `threads_resume`
 * does in Rust before the frontend asks for a snapshot. A history row opened
 * from the sidebar arrives here; without it, `agents_snapshot` answers "not
 * found" and the resume fails. A session already loaded is left as it is.
 */
export function adoptSession(
  key: SessionKey,
  pluginId: string,
  cwd: string,
  messages: SessionMessage[] = [],
): void {
  if (sessions.has(key.session_id)) return;
  sessions.set(key.session_id, { key, cwd, pluginId, messages });
}

function sessionOrThrow(key: SessionKey): FakeSession {
  const s = sessions.get(key.session_id);
  if (!s) throw new Error(`session ${key.session_id} not found`);
  return s;
}

/** The native agent's approval presets, so the composer's mode pill has a
 *  mode to name instead of sitting on "Loading…". */
const MODES: SessionModeInfo[] = [
  {
    id: "read-only",
    name: "Read Only",
    description: "Reads files; asks before any edit or command.",
  },
  {
    id: "auto",
    name: "Auto",
    description: "Edits and runs commands in the workspace; asks outside it.",
  },
  {
    id: "full-access",
    name: "Full Access",
    description: "Edits and runs anything without asking.",
  },
];
const DEFAULT_MODE = "auto";

function snapshot(s: FakeSession, withMessages: boolean): SessionSnapshot {
  const now = new Date().toISOString();
  const models = modelsFor?.(s.pluginId) ?? null;
  return {
    ...at(s),
    cwd: s.cwd,
    plugin_id: s.pluginId,
    status: "idle",
    current_mode: DEFAULT_MODE,
    current_model: models?.current ?? "mock-model",
    available_modes: MODES,
    available_models: models?.available ?? [{ id: "mock-model", name: "Mock model" }],
    available_commands: commandsFor?.(s.pluginId) ?? [],
    config_options: [],
    prompt_image_supported: true,
    plan: [],
    messages: withMessages ? s.messages : [],
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 },
    created_at: now,
    updated_at: now,
  };
}

/** Stream `messages` into a session (the most recent one by default), in order. */
export async function playTranscript(
  messages: SessionMessage[],
  gapMs = 0,
  sessionId?: string,
): Promise<void> {
  const s = latest(sessionId);
  if (!s) {
    console.warn("[mock-backend] playTranscript: no session bound yet");
    return;
  }
  for (const message of messages) {
    s.messages.push(message);
    await sendDelta({ kind: "message_appended", ...at(s), message });
    if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
  }
}

/**
 * Stream one assistant message into a session word by word, the way a real
 * turn arrives: an empty message, then `text_chunk` (or `thinking_chunk`)
 * deltas. The held copy is kept whole so a snapshot re-read agrees.
 */
export async function streamText(
  body: string,
  opts: { sessionId?: string; mode?: "text" | "thinking"; chunkMs?: number; id?: string } = {},
): Promise<void> {
  const s = latest(opts.sessionId);
  if (!s) return;
  const mode = opts.mode ?? "text";
  const message: SessionMessage = {
    id: opts.id ?? `m-${++seq}`,
    role: "assistant",
    mode,
    content: "",
    ...(mode === "thinking" ? { thinking: "" } : {}),
    tool_calls: [],
    timestamp: new Date().toISOString(),
  };
  s.messages.push(message);
  await sendDelta({ kind: "message_appended", ...at(s), message: { ...message } });
  for (const chunk of body.match(/\S+\s*/g) ?? []) {
    if (mode === "thinking") message.thinking = (message.thinking ?? "") + chunk;
    else message.content += chunk;
    await sendDelta({
      kind: mode === "thinking" ? "thinking_chunk" : "text_chunk",
      ...at(s),
      message_id: message.id,
      delta: chunk,
    });
    await new Promise((r) => setTimeout(r, opts.chunkMs ?? 28));
  }
}

/** Update one tool call in place (status, output) — for live-turn scenarios. */
export function upsertToolCall(
  messageId: string,
  toolCall: ToolCall,
  sessionId?: string,
): Promise<void> {
  const s = latest(sessionId);
  if (!s) return Promise.resolve();
  // Keep the snapshot in step with the stream, so a re-read agrees.
  const held = s.messages.find((m) => m.id === messageId);
  if (held) {
    held.tool_calls = held.tool_calls.map((call) => (call.id === toolCall.id ? toolCall : call));
  }
  return sendDelta({
    kind: "tool_call_upserted",
    ...at(s),
    message_id: messageId,
    tool_call: toolCall,
  });
}

/** Stream a chunk of live output into a running tool call. */
export function appendToolOutput(
  messageId: string,
  toolCallId: string,
  delta: string,
  sessionId?: string,
): Promise<void> {
  const s = latest(sessionId);
  if (!s) return Promise.resolve();
  return sendDelta({
    kind: "tool_call_output_chunk",
    ...at(s),
    message_id: messageId,
    tool_call_id: toolCallId,
    delta,
  });
}

export function setStatus(
  status: "idle" | "running" | "waiting" | "error",
  sessionId?: string,
): Promise<void> {
  const s = latest(sessionId);
  if (!s) return Promise.resolve();
  return sendDelta({ kind: "status", ...at(s), status });
}

/** End the turn the way the real projector does — a `turn_finished` terminal,
 *  not a bare status flip. The store only freezes turn-end state (the turn's
 *  "Worked for" time, its files footer, next-step chips) on the terminal, so a
 *  mock that just went idle never showed any of it. */
export function finishTurn(sessionId?: string): Promise<void> {
  const s = latest(sessionId);
  if (!s) return Promise.resolve();
  return sendDelta({ kind: "turn_finished", ...at(s), stop_reason: "end_turn", turn_seq: 0 });
}

// ── Permission requests ──────────────────────────────────────────────────
//
// The real backend never raises `permission_request` out of nowhere: the
// tool call it names already exists in the thread (created "pending", then
// `WaitingForConfirmation`), and `session/request_permission` refers to it by
// id (`atlas-agent-delta/src/projector.rs::permission_requested`). So a
// trigger here first appends that pending tool call to the transcript, same
// as a real turn would, then emits the `permission_request` delta pointing at
// it — the same channel and payload shape `atlas-agent-delta::project`
// builds (see `fixtures/permission.ts`). Resolving it later updates that same
// tool call and replies in the transcript, so accept/reject are visible
// there too, not just in the modal closing.

function isAllowKind(kind: string): boolean {
  return kind === "allow_once" || kind === "allow_always";
}

export interface OpenPermission {
  agentId: string;
  sessionId: string;
  messageId: string;
  toolCall: ToolCall;
  options: PermissionOptionRef[];
  /** What the transcript tool call's `result` becomes once resolved. */
  result: (allowed: boolean) => string;
  /** A follow-up assistant line, or `null` to stay silent — used by the
   *  multi-question variant, whose answer already talks back through the
   *  ordinary `agents_send` echo once its composed text is sent. */
  reply: (decision: PermissionDecision, option: PermissionOptionRef | null) => string | null;
}

const openPermissions = new Map<string, OpenPermission>();

export async function raisePermission(opts: {
  /** The session to raise it in; the most recent one by default. */
  sessionId?: string;
  transcriptCall: ToolCall;
  title: string;
  kind: string;
  rawInput: unknown;
  options: PermissionOptionRef[];
  result: OpenPermission["result"];
  reply: OpenPermission["reply"];
}): Promise<void> {
  const s = latest(opts.sessionId);
  if (!s) {
    console.warn("[mock-backend] requestPermission: no session bound yet");
    return;
  }
  const sid = s.key.session_id;
  await setStatus("running", sid);
  const message = tools([opts.transcriptCall], new Date().toISOString());
  await playTranscript([message], 0, sid);
  await setStatus("waiting", sid);

  const requestId = `perm-req-${++seq}`;
  openPermissions.set(requestId, {
    agentId: s.key.agent_id,
    sessionId: s.key.session_id,
    messageId: message.id,
    toolCall: opts.transcriptCall,
    options: opts.options,
    result: opts.result,
    reply: opts.reply,
  });
  await sendDelta({
    kind: "permission_request",
    ...at(s),
    request_id: requestId,
    tool_call: permissionToolCall({
      id: opts.transcriptCall.id,
      title: opts.title,
      kind: opts.kind,
      rawInput: opts.rawInput,
    }),
    options: opts.options,
  });
}

async function resolvePermission(
  agentId: string,
  sessionId: string,
  requestId: string,
  decision: PermissionDecision,
): Promise<void> {
  const open = openPermissions.get(requestId);
  openPermissions.delete(requestId);
  // Mirrors the real `permission_resolved` delta (App.tsx's `popPermission`
  // case) — redundant with the modal's own optimistic pop, but keeps the wire
  // shape faithful for anything else that might be watching it.
  await sendDelta({
    kind: "permission_resolved",
    agent_id: agentId,
    session_id: sessionId,
    request_id: requestId,
  });
  if (!open) return;

  const option =
    decision.kind === "selected"
      ? (open.options.find((o) => o.optionId === decision.option_id) ?? null)
      : null;
  const allowed = !!option && isAllowKind(option.kind);

  await upsertToolCall(
    open.messageId,
    {
      ...open.toolCall,
      status: allowed ? "completed" : "failed",
      result: open.result(allowed),
    },
    sessionId,
  );

  const line = open.reply(decision, option);
  if (line) await playTranscript([text(line, new Date().toISOString())], 0, sessionId);
  await finishTurn(sessionId);
}

let permSeq = 0;
const permId = () => `perm-tc-${++permSeq}`;

/** Plain command approval — the standard case (`__atlasMock.actions.requestPermission`). */
export function requestPermission(): Promise<void> {
  const id = permId();
  const command = "rm -rf .turbo dist";
  return raisePermission({
    transcriptCall: tool.run(command, { id, status: "pending" }),
    title: command,
    kind: "execute",
    rawInput: { command },
    options: standardOptions("this command"),
    result: (allowed) => (allowed ? "removed .turbo and dist\n" : "Rejected by user."),
    reply: (decision, option) =>
      decision.kind === "cancelled"
        ? "Okay — I won't run that."
        : option && isAllowKind(option.kind)
          ? "Done — cleaned the build output."
          : "Understood — I'll leave the build output alone.",
  });
}

/** A long, multi-line command — checks the preview wraps instead of
 *  overflowing (`__atlasMock.actions.requestPermissionLongArgs`). */
export function requestPermissionLongArgs(): Promise<void> {
  const id = permId();
  return raisePermission({
    transcriptCall: tool.run("run a repo-wide focused-test sweep", { id, status: "pending" }),
    title: "Run shell pipeline",
    kind: "execute",
    rawInput: { command: LONG_COMMAND },
    options: standardOptions("shell pipelines like this"),
    result: (allowed) => (allowed ? LONG_COMMAND_RESULT : "Rejected by user."),
    reply: (decision, option) =>
      decision.kind === "cancelled"
        ? "Okay — skipping the sweep."
        : option && isAllowKind(option.kind)
          ? "Ran it — see the output above."
          : "Understood — I'll skip the sweep.",
  });
}

/** ExitPlanMode's two-panel review (`__atlasMock.actions.requestPermissionPlan`). */
export function requestPermissionPlan(): Promise<void> {
  const id = permId();
  return raisePermission({
    transcriptCall: tool.other("ExitPlanMode", { plan: PLAN_MARKDOWN }, { id, status: "pending" }),
    title: "Exit plan mode",
    kind: "think",
    rawInput: { plan: PLAN_MARKDOWN },
    options: exitPlanOptions(),
    result: (allowed) => (allowed ? "Plan approved." : "Plan rejected — staying in plan mode."),
    reply: (decision, option) =>
      decision.kind === "cancelled"
        ? "Sticking with plan mode."
        : option && isAllowKind(option.kind)
          ? "Thanks — I'll start implementing the plan."
          : "Okay, I'll keep refining the plan.",
  });
}

/** Claude's `AskUserQuestion`, one single-select question — resolves through
 *  a real ACP option when the answer names a choice unambiguously
 *  (`__atlasMock.actions.requestPermissionQuestion`). */
export function requestPermissionQuestion(): Promise<void> {
  const id = permId();
  const q = askUserQuestionSingle();
  return raisePermission({
    transcriptCall: tool.other("AskUserQuestion", q.rawInput, { id, status: "pending" }),
    title: "Ask a question",
    kind: "other",
    rawInput: q.rawInput,
    options: q.options,
    result: (allowed) => (allowed ? "Answered." : "Cancelled."),
    reply: (decision, option) =>
      decision.kind === "cancelled"
        ? "Okay — I'll hold off."
        : option
          ? `Using ${option.name}.`
          : null,
  });
}

/** Claude's `AskUserQuestion`, two questions (one multi-select) — no single
 *  option names the combination, so it always composes a free-text reply
 *  (`__atlasMock.actions.requestPermissionQuestionMulti`). */
export function requestPermissionQuestionMulti(): Promise<void> {
  const id = permId();
  const q = askUserQuestionMulti();
  return raisePermission({
    transcriptCall: tool.other("AskUserQuestion", q.rawInput, { id, status: "pending" }),
    title: "Ask a question",
    kind: "other",
    rawInput: q.rawInput,
    options: q.options,
    result: (allowed) => (allowed ? "Answered." : "Cancelled."),
    // Silent either way: a composed answer is sent as an ordinary message and
    // gets the usual `agents_send` echo; Escape needs no narration.
    reply: () => null,
  });
}

/**
 * What the frontend reads from each command below — the type argument of its
 * `invoke<T>`, or `Unread` where it awaits only success or failure.
 */
export interface AgentResponses {
  agents_spawn: AgentInfo;
  agents_new_session: SessionInit;
  agents_snapshot: SessionSnapshot;
  agents_snapshot_meta: SessionSnapshot;
  agents_list_running: AgentInfo[];
  agents_replay_transcript: SessionMessage[];
  agents_drop_session: Unit;
  agents_cancel: Unit;
  agents_respond_permission: Unit;
  agents_send: Unit;
}

export const agentHandlers: TypedHandlers<AgentResponses> = {
  agents_spawn: ({ pluginId }): AgentInfo => ({
    agent_id: `agent-${pluginId}`,
    spec_id: pluginId,
    display_name: displayNameFor?.(String(pluginId)) ?? "Atlas Agent",
  }),
  agents_new_session: ({ agentId, cwd }): SessionInit => {
    const key = { agent_id: agentId, session_id: `sess-${++seq}` };
    const s: FakeSession = {
      key,
      cwd,
      pluginId: String(agentId).replace(/^agent-/, ""),
      messages: [],
    };
    sessions.set(key.session_id, s);
    const seed = sessionSeeder
      ? (sessionSeeder({ sessionId: key.session_id, pluginId: s.pluginId, cwd: String(cwd) }) ?? [])
      : seedTranscript;
    if (seed.length) {
      // After the frontend has stored the binding.
      setTimeout(() => void playTranscript(seed, 0, key.session_id), 50);
    }
    return { key, current_mode: DEFAULT_MODE, available_modes: MODES };
  },
  // Rust answers an unknown key with `Err`, never `null`.
  agents_snapshot: ({ key }) => snapshot(sessionOrThrow(key), true),
  agents_snapshot_meta: ({ key }) => snapshot(sessionOrThrow(key), false),
  agents_list_running: () => [],
  agents_replay_transcript: () => [],
  agents_drop_session: () => null,
  agents_cancel: () => setStatus("idle"),
  agents_respond_permission: ({ agentId, sessionId, requestId, decision }) => {
    void resolvePermission(agentId, sessionId, requestId, decision);
    return null;
  },
  // Echo the prompt back so the composer loop is exercisable.
  agents_send: async ({ key, text }) => {
    const s = sessions.get(key.session_id);
    if (!s) return null;
    const handled = promptHandler?.({
      sessionId: s.key.session_id,
      pluginId: s.pluginId,
      cwd: s.cwd,
      text: String(text),
    });
    if (handled) return null;
    const now = () => new Date().toISOString();
    await setStatus("running");
    const reply: SessionMessage = {
      id: `m-${++seq}`,
      role: "assistant",
      mode: "text",
      content: `(mock) You said: ${text}`,
      tool_calls: [],
      timestamp: now(),
    };
    setTimeout(() => {
      void playTranscript([reply]).then(() => finishTurn());
    }, 400);
    return null;
  },
};
