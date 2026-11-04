// What Memory hands the agent. Most changes to memory are asked for, not
// typed: "this is outdated, we moved to Postgres" goes to a session, and the
// agent fixes the record with its memory tools. Every ask from the panel is
// built here, as `AgentContext` (`@/features/ask-agent/lib/agent-context`),
// so the panel's views only say where the button goes.
//
// Pure: the caller resolves anything that needs the stores (an open tab, the
// project's name).

import type {
  AgentContext,
  MemoryEntryContext,
  QuoteContext,
} from "@/features/ask-agent/lib/agent-context";
import type { ActivityGroup, ActivityLine } from "./memory-activity";
import type { ReviewItem } from "./memory-review-items";
import { dreamLabel } from "./memory-review-items";
import type { MemoryEntry } from "./shared-memory-api";
import { isMac } from "@/lib/platform";

/** The panel's prompt line opens the box with this, so whatever the user
 *  types reads as an instruction about memory. */
export const MEMORY_INSTRUCTION_PROMPT = "Update this project's shared memory: ";

/** The keys a tab's search field hands its words to the agent with: the ask
 *  box's own send keys. */
export const MEMORY_ASK_KEYS: readonly string[] = isMac ? ["⌘", "↵"] : ["Ctrl", "↵"];

/** What a memory's "Ask agent…" suggests asking, beside it and in the box. */
export const ENTRY_ASK_EXAMPLE = "This is outdated, we moved to Postgres";

/** How many memories the prompt line's digest lists. The agent can search
 *  the rest with its memory tools; this is where to start, not a dump. */
export const DIGEST_ENTRIES = 20;
const DIGEST_LINE_CHARS = 140;

/** The project as a context names it: the last segment of its path. */
export function projectLabel(projectPath: string | null): string | null {
  if (!projectPath) return null;
  return projectPath.replace(/\/+$/, "").split("/").pop() || projectPath;
}

/** One memory as a chip. */
export function entryContext(e: MemoryEntry, projectPath: string | null): MemoryEntryContext {
  return {
    kind: "memory_entry",
    id: String(e.id),
    memoryKind: e.kind,
    text: e.content,
    project: projectLabel(projectPath),
  };
}

function oneLine(text: string, max = DIGEST_LINE_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** The prompt line's context: the project's current memories, the ones
 *  agents lean on most first, one line each and at most `DIGEST_ENTRIES` of
 *  them. Null when nothing is remembered yet. */
export function memoryDigest(
  entries: readonly MemoryEntry[],
  projectPath: string | null,
): QuoteContext | null {
  const current = entries
    .filter((e) => e.state !== "archived")
    .sort((a, b) => b.uses - a.uses || b.updatedAt - a.updatedAt);
  if (current.length === 0) return null;
  const listed = current.slice(0, DIGEST_ENTRIES);
  const name = projectLabel(projectPath) ?? "this project";
  const head =
    listed.length === current.length
      ? `${name} shared memory, all ${current.length} current`
      : `${name} shared memory, the ${listed.length} most used of ${current.length} current`;
  const lines = listed.map((e) => {
    const unconfirmed = e.state === "candidate" ? ", unconfirmed" : "";
    return `- [${e.kind} #${e.id}${unconfirmed}] ${oneLine(e.content)}`;
  });
  return { kind: "quote", text: [head, ...lines].join("\n"), source: "the Memory panel" };
}

/** A review item's "Ask agent": the memories it is about, and a prompt that
 *  asks for a rewrite before the user decides. */
export function reviewAsk(
  item: ReviewItem,
  projectPath: string | null,
): { context: AgentContext[]; prompt: string } {
  const ctx = (e: MemoryEntry) => entryContext(e, projectPath);
  switch (item.type) {
    case "candidate":
      return {
        context: [ctx(item.entry)],
        prompt: "Rewrite this memory before I approve it: ",
      };
    case "conflict":
      return {
        context: [ctx(item.a), ctx(item.b)],
        prompt: "These two memories disagree. Rewrite them as what is true now: ",
      };
    case "merge":
      return {
        context: [ctx(item.keep), ...item.drop.map(ctx)],
        prompt: "These look like the same memory. Rewrite them as one: ",
      };
    case "dream":
      return {
        context: item.proposal.entries.map(ctx),
        prompt: `The nightly memory review proposes “${dreamLabel(item.proposal.op)}”. Rewrite it before I accept: `,
      };
  }
}

/** An Activity line's "Why did you learn this?". To the session that wrote
 *  it, when it is open (`openTab`): the line is enough, it was there. To a
 *  new session otherwise, with where the line came from, so the agent can
 *  look it up. */
export function activityAsk(
  line: ActivityLine,
  group: ActivityGroup,
  entry: MemoryEntry | null,
  projectPath: string | null,
  openTab: string | null,
  agentLabel: string,
): { context: AgentContext[]; prompt: string; target: string } {
  const said = [line.verb, line.path, line.path && line.text ? "—" : null, line.text]
    .filter(Boolean)
    .join(" ");
  const what: AgentContext = entry
    ? entryContext(entry, projectPath)
    : { kind: "quote", text: said, source: "memory activity" };
  if (openTab) {
    return { context: [what], prompt: "Why did you learn this? ", target: openTab };
  }
  const at = new Date(group.end);
  const when = Number.isNaN(at.getTime()) ? "unknown" : at.toISOString();
  const provenance: QuoteContext = {
    kind: "quote",
    source: "memory activity provenance",
    text: [
      `${agentLabel} ${said}`,
      group.sessionId ? `Session: ${group.sessionId}` : "Session: not recorded",
      `Agent: ${group.agent || "unknown"}`,
      `At: ${when}`,
      projectLabel(projectPath) ? `Project: ${projectLabel(projectPath)}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
  };
  return {
    context: entry ? [what, provenance] : [provenance],
    prompt: "Why was this learned? Find the session it came from and explain. ",
    target: "new",
  };
}
