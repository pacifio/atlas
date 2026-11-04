// What a surface hands the agent: a piece of work, as structure.
//
// `AgentContext` is the one shape every surface speaks — a file range, a diff
// hunk, a memory entry, a commit, an error, a quote. `askAgent` turns each into
// an `agent_context` chip in the session composer (`MentionAgentContext`, a
// composer mention like a cite or a paste), so the user sees what goes with the
// prompt and can take it back out. At send, `composePrompt` writes each chip as
// a block after the prose: a header naming the source, then the excerpt in a
// fence it cannot close (`contextAsText`). That happens on the TypeScript side
// only — the chip never reaches `compose_prompt` (Rust), and nothing on the
// wire changes: the agent receives ordinary prompt text.
//
// Paths that carry plain text only (the send queue, a send whose
// `compose_prompt` failed) inline the same blocks (`withContextsInline`).

import { cutText, citeLabel } from "@/features/chat/lib/cited-text";
import type { MentionAgentContext, MentionData } from "@/features/chat/lib/mentions";

/** Lines of a file. `excerpt` is the text of `startLine`..`endLine`
 *  (1-based, inclusive). `path` is as the surface shows it, project-relative
 *  where it can be. */
export interface FileRangeContext {
  kind: "file_range";
  path: string;
  startLine: number;
  endLine: number;
  excerpt: string;
}

/** A whole file, by path, as the surface shows it. No excerpt: the agent
 *  reads the file itself. */
export interface FileContext {
  kind: "file";
  path: string;
}

/** One hunk of a diff, `@@` header included. */
export interface DiffHunkContext {
  kind: "diff_hunk";
  path: string;
  hunk: string;
  staged: boolean;
  /** The hunk is from the working tree against HEAD, staged and unstaged
   *  changes together (a partly staged file); `staged` then says nothing. */
  againstHead?: boolean;
}

/** A memory entry. `memoryKind` is the memory's own kind ("decision",
 *  "fact", …); `project` the project it belongs to, null for a global one. */
export interface MemoryEntryContext {
  kind: "memory_entry";
  id: string;
  memoryKind: string;
  text: string;
  project: string | null;
}

/** A commit, by its full or short sha. */
export interface CommitContext {
  kind: "commit";
  sha: string;
  subject: string;
}

/** A failure the user can see. `source` names where it happened ("git push",
 *  "Ship", "CI: lint"); `message` is what the surface shows; `log` is the
 *  longer output behind it, when there is one. */
export interface ErrorContext {
  kind: "error";
  source: string;
  message: string;
  log?: string;
  command?: string;
  cwd?: string;
}

/** Any text, with an optional label for where it came from. */
export interface QuoteContext {
  kind: "quote";
  text: string;
  source?: string;
}

export type AgentContext =
  | FileContext
  | FileRangeContext
  | DiffHunkContext
  | MemoryEntryContext
  | CommitContext
  | ErrorContext
  | QuoteContext;

/** The most of any one body (an excerpt, a hunk, a message) a chip carries.
 *  The large-paste limit: the excerpt points the agent at the place, and it
 *  can read the file, the diff or the log for more. */
export const CONTEXT_BODY_MAX_CHARS = 4000;
/** An error's log keeps its END, where the failure usually is. */
export const CONTEXT_LOG_MAX_CHARS = 8000;

const LABEL_CHARS = 40;

function capHead(text: string, max = CONTEXT_BODY_MAX_CHARS): string {
  return text.length > max ? `${cutText(text, max - 1).trimEnd()}…` : text;
}

function capTail(text: string, max = CONTEXT_LOG_MAX_CHARS): string {
  if (text.length <= max) return text;
  // Not through a surrogate pair from the other end either.
  let start = text.length - (max - 1);
  const first = text.charCodeAt(start);
  if (first >= 0xdc00 && first <= 0xdfff) start += 1;
  return `…${text.slice(start)}`;
}

/** `ctx` with every body within budget, so every chip that exists is. */
export function capContext(ctx: AgentContext): AgentContext {
  switch (ctx.kind) {
    case "file":
      return ctx;
    case "file_range":
      return { ...ctx, excerpt: capHead(ctx.excerpt) };
    case "diff_hunk":
      return { ...ctx, hunk: capHead(ctx.hunk) };
    case "memory_entry":
      return { ...ctx, text: capHead(ctx.text) };
    case "commit":
      return { ...ctx, subject: capHead(ctx.subject, 400) };
    case "error":
      return {
        ...ctx,
        message: capHead(ctx.message),
        ...(ctx.log ? { log: capTail(ctx.log) } : {}),
      };
    case "quote":
      return { ...ctx, text: capHead(ctx.text) };
  }
}

function shortLabel(text: string, max = LABEL_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${cutText(flat, max - 1).trimEnd()}…` : flat;
}

function rangeOf(start: number, end: number): string {
  return start === end ? `${start}` : `${start}–${end}`;
}

/** The chip's label: short, one line, says what it is. */
export function contextLabel(ctx: AgentContext): string {
  switch (ctx.kind) {
    case "file":
      return shortLabel(ctx.path);
    case "file_range":
      return shortLabel(`${ctx.path}:${rangeOf(ctx.startLine, ctx.endLine)}`);
    case "diff_hunk":
      return shortLabel(
        `${ctx.path} · ${ctx.againstHead ? "hunk vs HEAD" : `${ctx.staged ? "staged" : "unstaged"} hunk`}`,
      );
    case "memory_entry":
      return shortLabel(`Memory · ${ctx.text}`);
    case "commit":
      return shortLabel(`${ctx.sha.slice(0, 7)} ${ctx.subject}`);
    case "error":
      return shortLabel(`${ctx.source} error`);
    case "quote":
      return citeLabel(ctx.text);
  }
}

/** What a hover over the chip shows: the source, then the start of the body. */
export function contextTitle(ctx: AgentContext): string {
  const head = (text: string) => capHead(text.split("\n").slice(0, 12).join("\n"), 600);
  switch (ctx.kind) {
    case "file":
      return ctx.path;
    case "file_range":
      return `${ctx.path}, lines ${rangeOf(ctx.startLine, ctx.endLine)}\n${head(ctx.excerpt)}`;
    case "diff_hunk":
      return `${ctx.path} (${ctx.againstHead ? "staged and unstaged, vs HEAD" : ctx.staged ? "staged" : "unstaged"})\n${head(ctx.hunk)}`;
    case "memory_entry":
      return `${ctx.memoryKind} memory${ctx.project ? ` · ${ctx.project}` : ""}\n${head(ctx.text)}`;
    case "commit":
      return `${ctx.sha} ${ctx.subject}`;
    case "error":
      return `${ctx.source}${ctx.command ? ` · ${ctx.command}` : ""}\n${head(ctx.message)}`;
    case "quote":
      return ctx.source ? `${ctx.source}\n${head(ctx.text)}` : head(ctx.text);
  }
}

/** A fresh chip id: short, since it is visible in the prompt (`@ctx:<id>`). */
export function newContextId(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** The chip for `ctx`, capped. */
export function agentContextMention(
  ctx: AgentContext,
  id: string = newContextId(),
): MentionAgentContext {
  const context = capContext(ctx);
  return { kind: "agent_context", id, displayName: contextLabel(context), context };
}

/** A fence the body cannot close. */
function fenceFor(body: string): string {
  let longest = 0;
  for (const run of body.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

function fenced(body: string, lang = ""): string {
  const fence = fenceFor(body);
  return `${fence}${lang}\n${body.replace(/\n$/, "")}\n${fence}`;
}

/** A file extension as a fence's language, when it looks like one. */
function langOf(path: string): string {
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(path)?.[1];
  return ext ? ext.toLowerCase() : "";
}

/** The source, as the block's header says it. */
function sourceLine(ctx: AgentContext): string {
  switch (ctx.kind) {
    case "file":
      return `the file \`${ctx.path}\``;
    case "file_range":
      return `\`${ctx.path}\`, lines ${rangeOf(ctx.startLine, ctx.endLine)}`;
    case "diff_hunk":
      return ctx.againstHead
        ? `a diff hunk against HEAD (staged and unstaged changes) in \`${ctx.path}\``
        : `a ${ctx.staged ? "staged" : "unstaged"} diff hunk in \`${ctx.path}\``;
    case "memory_entry":
      return `${ctx.memoryKind} memory \`${ctx.id}\`${ctx.project ? ` in project ${ctx.project}` : " (global)"}`;
    case "commit":
      return `commit \`${ctx.sha}\``;
    case "error":
      return [
        `an error from ${ctx.source}`,
        ctx.command ? `running \`${ctx.command}\`` : null,
        ctx.cwd ? `in \`${ctx.cwd}\`` : null,
      ]
        .filter(Boolean)
        .join(", ");
    case "quote":
      return ctx.source ? `quoted text from ${ctx.source}` : "quoted text";
  }
}

/** The chip as the agent reads it: a header naming its source, then the
 *  excerpt quoted in a fence it cannot close. */
export function contextAsText(m: Pick<MentionAgentContext, "id" | "context">): string {
  const ctx = m.context;
  const head = `Context (@ctx:${m.id}), ${sourceLine(ctx)}:`;
  switch (ctx.kind) {
    case "file":
      return `Context (@ctx:${m.id}), ${sourceLine(ctx)}.`;
    case "file_range":
      return `${head}\n${fenced(ctx.excerpt, langOf(ctx.path))}`;
    case "diff_hunk":
      return `${head}\n${fenced(ctx.hunk, "diff")}`;
    case "memory_entry":
      return `${head}\n${fenced(ctx.text)}`;
    case "commit":
      return `${head} ${ctx.subject.replace(/\s+/g, " ").trim()}`;
    case "error":
      return ctx.log
        ? `${head}\n${fenced(ctx.message)}\nLog:\n${fenced(ctx.log)}`
        : `${head}\n${fenced(ctx.message)}`;
    case "quote":
      return `${head}\n${fenced(ctx.text)}`;
  }
}

/** Each context chip written out after the prose. `composePrompt` does this
 *  for a normal send; the queue and a failed compose do it too. Appends —
 *  call it once per prompt. */
export function withContextsInline(text: string, mentions: readonly MentionData[]): string {
  const contexts = mentions.filter((m): m is MentionAgentContext => m.kind === "agent_context");
  if (contexts.length === 0) return text;
  return [text, ...contexts.map(contextAsText)].join("\n\n");
}
