// The `northwind` scenario's agent chats: what an agent chat opens on, what
// the fake agent does when someone presses Enter, and which recorded Session
// a chat is (so Timeline comments show up beside its tool calls).
//
// No real agent runs in the browser. A prompt that matches a `ScriptedRun` in
// `northwind-content.ts` streams that run — thinking, tool calls that run and
// finish, words arriving a few at a time, approval cards — through the same
// `atlas:agents` deltas a real turn uses. A prompt that matches nothing gets a
// short, plausible answer rather than the default "(mock) You said:" echo.

import { emit } from "@tauri-apps/api/event";
import type { PermissionOptionRef } from "@/types/acp";
import { agentTypeFromPluginId } from "@/types/agent";
import type { SessionMessage, ToolCall } from "@/types/agents";
import type { AnchorEntry } from "@/features/chat/lib/comment-anchors";
import type { CommentTarget } from "@/features/chat/components/chat-comments-controller";
import {
  finishTurn,
  playTranscript,
  raisePermission,
  setAgentCommands,
  setAgentDisplayNames,
  setAgentModels,
  setPromptHandler,
  setSessionSeeder,
  setStatus,
  streamText,
  upsertToolCall,
  sendTitle,
  type AgentModels,
  type NewSessionInfo,
} from "../fake-agent";
import { NORTHWIND_FILES } from "../fixtures/northwind-repo";
import type { AgentKey, Beat, ScriptedRun, Step, ToolStep } from "./northwind-content-types";
import { CONTENT } from "./northwind-content";
import { matchRun } from "./northwind-match";
import { NORTHWIND_NATIVE_MODELS } from "./northwind-models";
import {
  abs,
  AGENT_LABEL,
  BEFORE_VIDEO_1,
  createSession,
  PROJECT,
  REMOTE_PROJECT_ID,
  rowId,
  session,
  sessionContent,
  sessions,
  setPending,
  PEOPLE,
  type PendingChange,
} from "./northwind-world";

// ── Agents ────────────────────────────────────────────────────────────────

/** A plugin id (`claude-code-ts`, `codex`, `atlas-agent`) as a content agent. */
export function agentKeyOf(pluginId: string): AgentKey | null {
  // Registry installs keep their registry id (video 9 installs `codex-acp`).
  const REGISTRY: Record<string, AgentKey> = { "codex-acp": "codex", "claude-acp": "claude-code" };
  if (REGISTRY[pluginId]) return REGISTRY[pluginId];
  const type: string = agentTypeFromPluginId(pluginId);
  return type === "claude-code" || type === "codex" || type === "atlas-agent" ? type : null;
}

const MODELS: Record<AgentKey, AgentModels> = {
  "claude-code": {
    current: "claude-opus-5-5",
    available: [
      { id: "claude-opus-5-5", name: "Opus 5.5" },
      { id: "claude-sonnet-5-5", name: "Sonnet 5.5" },
      { id: "claude-haiku-4-5", name: "Haiku 4.5" },
    ],
  },
  codex: {
    current: "gpt-5",
    available: [
      { id: "gpt-5", name: "GPT-5" },
      { id: "gpt-5-mini", name: "GPT-5 mini" },
      { id: "o3", name: "o3" },
    ],
  },
  "atlas-agent": {
    current: "claude-sonnet-5-5",
    // The gateway's list — the same one the picker's Refresh returns.
    available: NORTHWIND_NATIVE_MODELS,
  },
};

/**
 * What each agent offers under `/`. `remember` is the skill Atlas installs for
 * every agent (video 11 beat 1); `release-notes` is northwind-shop's project
 * skill, delivered to all three (video 11 beat 5). The rest is each agent's
 * own short list.
 */
const SKILL_COMMANDS = [
  {
    name: "remember",
    description: "Save a decision, fact or rule to Atlas's shared memory for this repo",
    input: { hint: "what to remember" },
  },
  {
    name: "release-notes",
    description: "Write release notes for northwind-shop from the commits since the last tag.",
    input: null,
  },
];
const COMMANDS: Record<AgentKey, unknown[]> = {
  "claude-code": [
    ...SKILL_COMMANDS,
    { name: "review", description: "Review the current changes", input: null },
    { name: "compact", description: "Summarise the conversation to free up context", input: null },
    { name: "init", description: "Write a CLAUDE.md for this project", input: null },
  ],
  codex: [
    ...SKILL_COMMANDS,
    { name: "review", description: "Review the working tree", input: null },
    { name: "status", description: "Show the model, approvals and token use", input: null },
  ],
  "atlas-agent": [
    ...SKILL_COMMANDS,
    { name: "plan", description: "Plan before changing anything", input: { hint: "task" } },
  ],
};

// ── Steps as a chat transcript ────────────────────────────────────────────

/** The chat-side id of a recorded step: a tool call's id, or a message's. */
export const chatIdOf = (sessionId: string, stepId: string): string => `nw:${sessionId}:${stepId}`;

/** What each agent calls its tools, so a row reads the way that agent's would. */
function toolNameOf(agent: AgentKey, tool: ToolStep["tool"], command?: string): string {
  // Organisation tools are served by the `atlas_org` MCP server; Atlas Agent
  // names them `atlas_org.<tool>`, an ACP agent `mcp__atlas_org__<tool>`.
  if (tool === "org") {
    const name = command ?? "org";
    return agent === "atlas-agent" ? `atlas_org.${name}` : `mcp__atlas_org__${name}`;
  }
  // Atlas memory is the `atlas_memory` MCP server, named the same two ways.
  if (tool === "memory") {
    const name = command ?? "memory_search";
    return agent === "atlas-agent" ? `atlas_memory.${name}` : `mcp__atlas_memory__${name}`;
  }
  const names: Record<AgentKey, Record<string, string>> = {
    "claude-code": { read: "Read", edit: "Edit", write: "Write", bash: "Bash", grep: "Grep" },
    codex: {
      read: "read_file",
      edit: "apply_patch",
      write: "apply_patch",
      bash: "shell",
      grep: "shell",
    },
    "atlas-agent": {
      read: "read_file",
      edit: "apply_patch",
      write: "apply_patch",
      bash: "shell",
      grep: "grep_files",
    },
  };
  return names[agent][tool];
}

/** The ACP tool kind, which picks the row's icon. */
function toolKindOf(tool: ToolStep["tool"]): string {
  switch (tool) {
    case "read":
      return "read";
    case "edit":
    case "write":
      return "edit";
    case "bash":
      return "execute";
    case "grep":
      return "search";
    default:
      return "other";
  }
}

type ToolLike = Pick<ToolStep, "tool" | "title" | "path" | "command" | "args" | "result" | "diff">;

/** The arguments a tool call would have carried. */
export function toolArgsOf(t: ToolLike): Record<string, unknown> {
  if (t.args) return t.args;
  switch (t.tool) {
    case "read":
      return { file_path: abs(t.path ?? "") };
    case "edit":
      return {
        file_path: abs(t.path ?? ""),
        old_string: t.diff?.before ?? "",
        new_string: t.diff?.after ?? "",
      };
    case "write":
      return { file_path: abs(t.path ?? ""), content: t.diff?.after ?? "" };
    case "bash":
      return { command: t.command ?? t.title };
    case "grep":
      return { pattern: t.command ?? "", path: PROJECT.path };
    default:
      return {};
  }
}

/** "live now" / "today" / "yesterday" / "3 days ago", as Atlas Agent words it. */
function agoOf(ms: number): string {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(new Date()) - day(new Date(ms))) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

/**
 * `org_sessions` for an author, read off the Timeline as it stands — so the
 * list is true in every take, `?video=1` (before the discount-code run) or not.
 */
function listSessionsOf(member: string): string {
  const person = Object.values(PEOPLE).find((p) => p.name === member);
  const theirs = sessions().filter((s) => s.content.author === person?.key);
  const live = theirs.filter((s) => s.live).length;
  const rows = theirs
    .slice(0, 6)
    .map(
      (s) =>
        `${s.live ? "●" : " "} ${s.content.title} · ${AGENT_LABEL[s.content.agent]}, ${s.live ? "live now" : agoOf(s.lastMs)}`,
    );
  return [
    `${theirs.length} sessions in northwind-shop${live ? ` · ${live} live` : ""}`,
    ...rows,
  ].join("\n");
}

/** What a finished tool call returned, when the content does not say. */
export function toolResultOf(t: ToolLike): string {
  if (t.result !== undefined) return t.result;
  if (t.tool === "org" && t.command === "org_sessions" && typeof t.args?.author === "string")
    return listSessionsOf(t.args.author);
  switch (t.tool) {
    case "edit":
      return `Applied 1 edit to ${t.path}.`;
    case "write":
      return `Created ${t.path}.`;
    case "read":
      return (NORTHWIND_FILES[t.path ?? ""]?.text ?? "").split("\n").slice(0, 12).join("\n");
    default:
      return "";
  }
}

export function toolCallOf(
  id: string,
  agent: AgentKey,
  t: ToolLike,
  status: ToolCall["status"] = "completed",
): ToolCall {
  const call: ToolCall = {
    id,
    tool_name: toolNameOf(agent, t.tool, t.command),
    title: t.title,
    kind: toolKindOf(t.tool),
    status,
    arguments: toolArgsOf(t),
    result: status === "completed" ? toolResultOf(t) : null,
    locations: t.path ? [{ path: abs(t.path) }] : [],
  };
  if ((t.tool === "edit" || t.tool === "write") && t.diff && t.path) {
    call.content_blocks = [
      t.diff.before === undefined
        ? { type: "diff", path: abs(t.path), newText: t.diff.after }
        : { type: "diff", path: abs(t.path), oldText: t.diff.before, newText: t.diff.after },
    ];
  }
  return call;
}

/**
 * A recorded Session as the agent chat that produced it: one user message per
 * prompt, thinking and responses as assistant messages, and each run of
 * consecutive tool calls as one tool message. Checkpoints are not chat rows.
 */
export function transcriptOf(sessionId: string): SessionMessage[] {
  const state = session(sessionId);
  const content = state?.content ?? sessionContent(sessionId);
  if (!content) return [];
  const base = state?.startMs ?? Date.now();
  const at = (step: Step) => new Date(base + step.min * 60_000).toISOString();
  const out: SessionMessage[] = [];
  let toolRun: SessionMessage | null = null;
  for (const step of state?.steps ?? content.steps) {
    const id = chatIdOf(sessionId, step.id);
    if (step.kind === "tool") {
      if (!toolRun) {
        toolRun = {
          id: `${id}:tools`,
          role: "assistant",
          mode: "tool",
          content: "",
          tool_calls: [],
          timestamp: at(step),
        };
        out.push(toolRun);
      }
      toolRun.tool_calls.push(toolCallOf(id, content.agent, step));
      continue;
    }
    toolRun = null;
    if (step.kind === "prompt") {
      out.push({
        id,
        role: "user",
        mode: "text",
        content: step.text,
        tool_calls: [],
        timestamp: at(step),
      });
    } else if (step.kind === "thinking") {
      out.push({
        id,
        role: "assistant",
        mode: "thinking",
        content: "",
        thinking: step.text,
        tool_calls: [],
        timestamp: at(step),
      });
    } else if (step.kind === "response") {
      out.push({
        id,
        role: "assistant",
        mode: "text",
        content: step.text,
        tool_calls: [],
        model: content.model,
        timestamp: at(step),
      });
    }
  }
  return out;
}

// ── Which chat is which recorded Session ──────────────────────────────────

/** Native chat session id (`sess-N`) → the recorded Session it is. */
const bindings = new Map<string, string>();

/**
 * `chat_comment_target`: the recorded rows of the Session behind this chat, so
 * the chat can place the Timeline's comments on its own tool calls.
 */
export function commentTargetFor(nativeSessionId: string): CommentTarget | null {
  const sessionId = bindings.get(nativeSessionId);
  const state = sessionId ? session(sessionId) : undefined;
  if (!sessionId || !state) return null;
  let turnSeq = 0;
  const entries: AnchorEntry[] = [];
  for (const step of state.steps) {
    if (step.kind === "prompt") turnSeq += 1;
    if (step.kind === "checkpoint") continue;
    entries.push({
      rowId: rowId(sessionId, step.id),
      kind: step.kind === "tool" ? "tool_call" : step.kind,
      turnSeq: Math.max(1, turnSeq),
      // Prompts pair by turn; everything else by the id the chat holds.
      nativeId: step.kind === "prompt" ? null : chatIdOf(sessionId, step.id),
      toolName:
        step.kind === "tool" ? toolNameOf(state.content.agent, step.tool, step.command) : null,
    });
  }
  return { remoteProjectId: REMOTE_PROJECT_ID, sessionId, entries };
}

// ── Scripted runs ─────────────────────────────────────────────────────────

/** What an approval card's Allow does. Supplied by `northwind.ts`. */
export type Effects = Record<
  Extract<Beat, { kind: "approval" }>["effect"],
  (args: Record<string, unknown>) => void
>;
/** What a run's `afterwards` does. Supplied by `northwind.ts`. */
export interface RunHooks {
  effects: Effects;
  rememberDecision: () => void;
}
let hooks: RunHooks | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

/** Approval options as Atlas Agent's org tools offer them. */
function approvalOptions(chatMessage: boolean): PermissionOptionRef[] {
  return chatMessage
    ? [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "decline", name: "Decline", kind: "reject_once" },
      ]
    : [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "allow_session", name: "Allow for this session", kind: "allow_always" },
        { optionId: "decline", name: "Decline", kind: "reject_once" },
      ];
}

let callSeq = 0;

/** One tool call: appears running, then finishes with its result. */
async function runTool(
  sid: string,
  agent: AgentKey,
  id: string,
  t: ToolLike,
  ms: number,
): Promise<void> {
  const message: SessionMessage = {
    id: `${id}:tools`,
    role: "assistant",
    mode: "tool",
    content: "",
    tool_calls: [toolCallOf(id, agent, t, "running")],
    timestamp: now(),
  };
  await playTranscript([message], 0, sid);
  await sleep(ms);
  await upsertToolCall(message.id, toolCallOf(id, agent, t, "completed"), sid);
  await sleep(250);
}

/**
 * The audit record Rust broadcasts for every organisation call, refusals
 * included, so this take's calls land in the Log like the real thing's.
 */
function auditOrgCall(
  sid: string,
  agent: AgentKey,
  tool: string,
  args: Record<string, unknown> | undefined,
  ok: boolean,
  text: string,
): void {
  void emit("atlas:org-action", {
    sessionId: sid,
    agent,
    tool,
    arguments: args ?? {},
    ok,
    text,
  });
}

async function playBeat(sid: string, agent: AgentKey, beat: Beat): Promise<"waiting" | void> {
  switch (beat.kind) {
    case "thinking":
      await streamText(beat.text, { sessionId: sid, mode: "thinking", chunkMs: 14 });
      return;
    case "text":
      await streamText(beat.text, { sessionId: sid });
      return;
    case "tool":
      await runTool(sid, agent, `nw:run:${++callSeq}`, beat, beat.ms ?? 700);
      if (beat.tool === "org" && beat.command) {
        auditOrgCall(sid, agent, beat.command, beat.args, true, beat.result ?? "");
      }
      return;
    case "approval": {
      const effect = beat.effect;
      const command = effect === "replyToComment" ? "org_comment_reply" : "org_send";
      await raisePermission({
        sessionId: sid,
        transcriptCall: toolCallOf(
          `nw:run:${++callSeq}`,
          agent,
          {
            tool: "org",
            title: beat.title,
            args: beat.args,
            command,
          },
          "pending",
        ),
        title: beat.title,
        kind: "other",
        rawInput: beat.args,
        options: approvalOptions(effect !== "replyToComment"),
        result: (allowed) => (allowed ? "Done." : "Declined by user."),
        reply: (_decision, option) => {
          const allowed = option?.kind === "allow_once" || option?.kind === "allow_always";
          if (allowed) hooks?.effects[effect](beat.args);
          auditOrgCall(
            sid,
            agent,
            command,
            beat.args,
            allowed,
            allowed ? "Done." : "Declined by user.",
          );
          return allowed ? beat.allowed : beat.declined;
        },
      });
      // The turn ends when the card is answered (`resolvePermission`).
      return "waiting";
    }
  }
}

/** Replay a recorded Session's turn: every step after its first prompt. */
async function replaySteps(sid: string, sessionId: string): Promise<void> {
  const content = sessionContent(sessionId);
  if (!content) return;
  const steps = content.steps.filter((s) => s.kind !== "checkpoint").slice(1);
  for (const step of steps) {
    const id = chatIdOf(sessionId, step.id);
    if (step.kind === "thinking") {
      await streamText(step.text, { sessionId: sid, mode: "thinking", chunkMs: 14, id });
    } else if (step.kind === "response") {
      await streamText(step.text, { sessionId: sid, id });
    } else if (step.kind === "tool") {
      const ms =
        step.tool === "bash" ? 1_500 : step.tool === "read" || step.tool === "grep" ? 450 : 1_000;
      await runTool(sid, content.agent, id, step, ms);
    }
  }
}

/** The video-1 Session's edits, as uncommitted changes against the repo. */
function pendingFrom(sessionId: string): PendingChange[] {
  const content = sessionContent(sessionId);
  const out = new Map<string, PendingChange>();
  for (const step of content?.steps ?? []) {
    if (step.kind !== "tool" || !step.path || !step.diff) continue;
    if (step.tool !== "edit" && step.tool !== "write") continue;
    const head = NORTHWIND_FILES[step.path]?.text;
    if (head === undefined) continue;
    const prev = out.get(step.path);
    const before = prev?.before ?? head;
    // HEAD already holds this change (the repo is written as of after it), so
    // "before" is HEAD with the edit undone.
    if (step.diff.before === undefined || !head.includes(step.diff.after)) {
      out.set(step.path, { path: step.path, before: prev?.before ?? null, after: head });
      continue;
    }
    out.set(step.path, {
      path: step.path,
      before: (before ?? head).replace(step.diff.after, step.diff.before),
      after: head,
    });
  }
  return [...out.values()];
}

/**
 * Record a Session video 1 makes on camera, if this take hasn't yet: on the
 * Timeline, with its edits uncommitted in the git panel. The prompt that makes
 * it does this; so do the cues that point at it (3, 6), in case that prompt
 * went to the fallback answer.
 */
export function ensureVideo1Session(id: string, startedAt = Date.now()): void {
  if (!BEFORE_VIDEO_1 || session(id)) return;
  createSession(id, startedAt);
  setPending(pendingFrom(id), [id]);
  void emit("atlas:capture-changed", {});
}

async function finish(
  run: ScriptedRun,
  sid: string,
  agent: AgentKey,
  startedAt: number,
): Promise<void> {
  if (run.afterwards === "discountSession") {
    const id = run.replay ?? "s-discount";
    ensureVideo1Session(id, startedAt);
    bindings.set(sid, id);
    // What the capture worker emits after a turn: the board and this chat's
    // comment target both re-read.
    void emit("atlas:capture-changed", {});
  } else if (run.afterwards === "rememberDecision") {
    hooks?.rememberDecision();
  } else if (run.afterwards === "recordSession" && run.replay) {
    // The capture worker's job in the real app: the turn the viewer just
    // watched becomes a Session on the Timeline, under its agent's glyph.
    // Only from the agent it was written for: a Codex prompt sent to Claude
    // Code must not land on the Timeline as Codex.
    if (sessionContent(run.replay)?.agent !== agent) return;
    if (!session(run.replay)) createSession(run.replay, startedAt);
    bindings.set(sid, run.replay);
    void emit("atlas:capture-changed", {});
  }
}

async function play(run: ScriptedRun, sid: string, agent: AgentKey): Promise<void> {
  const startedAt = Date.now();
  await setStatus("running", sid);
  await sleep(450);
  let waiting = false;
  if (run.replay) await replaySteps(sid, run.replay);
  for (const beat of run.beats) {
    if ((await playBeat(sid, agent, beat)) === "waiting") {
      waiting = true;
      break;
    }
  }
  await finish(run, sid, agent, startedAt);
  if (!waiting) await finishTurn(sid);
}

/** A prompt nothing scripted: a short answer that would not look odd on camera. */
async function playFallback(sid: string, agent: AgentKey, text: string): Promise<void> {
  await setStatus("running", sid);
  await sleep(500);
  await runTool(
    sid,
    agent,
    `nw:run:${++callSeq}`,
    {
      tool: "read",
      title: "Read README.md",
      path: "README.md",
    },
    500,
  );
  const topic = readablePrompt(text).split(" ").slice(0, 8).join(" ");
  await streamText(
    `I've read the project layout. Before I change anything for "${topic}", which part of northwind-shop should I start with: the client pages in \`src/client\`, or the API in \`src/server\`?`,
    { sessionId: sid },
  );
  await finishTurn(sid);
}

/**
 * The prompt as a person would read it: what Atlas appends for the agent
 * (the next-steps block) dropped, and every picked mention — `@member:"Zuhayer
 * Masud"`, `@conversation:shop`, `@recorded-session:"…"`, `@comment:"…"` —
 * reduced to its name. So a run matches whether Zuhayer was typed or picked
 * from the @ picker, which is how the videos do it.
 */
export function readablePrompt(text: string): string {
  return text
    .split("═══ Atlas next-steps")[0]
    .replace(/[@#][a-z-]+:"([^"]*)"/g, "$1")
    .replace(/[@#][a-z-]+:(\S+)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function findRun(text: string, agent: AgentKey): ScriptedRun | undefined {
  return matchRun(CONTENT.runs, readablePrompt(text), agent);
}

// ── Wiring ────────────────────────────────────────────────────────────────

/**
 * Which recorded Session the FIRST agent chat opens on (`?chat=<session id>`,
 * default `s-discount`; `?chat=none` for an empty one). Video 4 keeps "the
 * agent chat tab for that session" open; video 11 starts from `s-normalize`.
 */
function openingSession(): string | null {
  const asked = new URLSearchParams(location.search).get("chat");
  if (asked === "none") return null;
  if (asked) return asked;
  return BEFORE_VIDEO_1 ? null : "s-discount";
}

export function installNorthwindAgent(runHooks: RunHooks): void {
  hooks = runHooks;
  let opening = openingSession();

  setAgentModels((pluginId) => {
    const key = agentKeyOf(pluginId);
    return key ? MODELS[key] : null;
  });
  setAgentCommands((pluginId) => {
    const key = agentKeyOf(pluginId);
    return key ? COMMANDS[key] : null;
  });
  setAgentDisplayNames((pluginId) => {
    const key = agentKeyOf(pluginId);
    return key ? AGENT_LABEL[key] : null;
  });

  setSessionSeeder((info: NewSessionInfo) => {
    if (!opening) return null;
    const id = opening;
    const content = sessionContent(id);
    if (!content || !session(id) || agentKeyOf(info.pluginId) !== content.agent) return null;
    opening = null;
    bindings.set(info.sessionId, id);
    // Titled the way Atlas titled it when it ran: the prompt's first 40 characters.
    const prompt = content.steps.find((step) => step.kind === "prompt");
    if (prompt?.kind === "prompt") {
      setTimeout(() => void sendTitle(info.sessionId, prompt.text.slice(0, 40)), 0);
    }
    return transcriptOf(id);
  });

  setPromptHandler(({ sessionId, pluginId, text }) => {
    const agent = agentKeyOf(pluginId) ?? "atlas-agent";
    const run = findRun(text, agent);
    void (run ? play(run, sessionId, agent) : playFallback(sessionId, agent, text));
    return true;
  });
}
