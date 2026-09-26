// Projection: ChatMessage[] → turns → a flat, typed row index.
//
// The old transcript rendered one `MessageItem` per stored message and derived
// grouping (`compact`, `isLastInGroup`, dividers, time gaps) from neighbouring
// messages on EVERY render. Two problems: the turn — the thing users reason
// about, and the thing the footer and "Show changes" belong to — had no
// representation, and grouping was O(n) work repeated per frame.
//
// Here the thread is projected ONCE into a closed set of row kinds. Everything
// a row needs to render is baked into the row record at projection time. The
// rendering layer never looks at a neighbour.
//
// The closed set matters: a new row kind is a deliberate addition to the
// vocabulary of the transcript, not an ad-hoc branch in a render function.

import type { ChatMessage, ToolCallDisplay, TurnFile } from "@/types/agent";
import type { ImageAttachment } from "@/types/agents";

// Shared so a row without images keeps a stable prop for the row's `memo`.
const NO_ATTACHMENTS: readonly ImageAttachment[] = Object.freeze([]);
import { isBashToolCall, bashCommandOf } from "./tool-calls";
import { orgToolOf, orgToolRow } from "@/features/org-actions/lib/org-tool-rows";
import { parseShellCommand } from "./parse-shell-command";
import {
  getFilePathFromInput,
  classifyToolFileKind,
  countChangedLines,
  countEditLines,
  isFileCreated,
} from "./tool-files";
import { splitAtlasContext } from "./atlas-context";
import { stripNextSteps, stripNextStepsDirective } from "./next-steps";

// ── Row kinds ──────────────────────────────────────────────────────────────

export const RowKind = {
  User: 0,
  Prose: 1,
  Thinking: 2,
  Marker: 3,
  MarkerGroup: 4,
  Separator: 5,
  TurnFooter: 6,
  WorkHeader: 7,
} as const;

/** Marker execution state — drives the leading glyph, nothing else. */
export type MarkerState = "pending" | "running" | "done" | "failed";

/** What a marker click opens in the detail panel. */
export type MarkerDetail = "diff" | "output" | "none";

interface RowBase {
  /** Stable across projections — the virtualizer keys on this. */
  id: string;
  turnId: string;
  /** True for the first row of its turn (anchor target for scroll/expand). */
  firstInTurn: boolean;
}

export interface UserRow extends RowBase {
  kind: typeof RowKind.User;
  text: string;
  /** Heavy @-mention context, collapsed behind a chip. */
  contextBlocks: number;
  /** Set once the user has expanded a clamped bubble. Expanding swaps the row
   *  for a taller one — a data change with a known new height, never a reflow. */
  expanded: boolean;
  /** The images sent with the prompt, shown as tiles above the bubble. */
  attachments: readonly ImageAttachment[];
  timestamp: string;
}

/** The `ChatMessage.id` behind a user row. Row ids are minted as
 *  `u:<messageId>` in the projection below; anything that has to address the
 *  MESSAGE (pins, jumps) goes through this rather than slicing the prefix at
 *  the call site. */
export function userRowMessageId(rowId: string): string {
  return rowId.startsWith("u:") ? rowId.slice(2) : rowId;
}

export interface ProseRow extends RowBase {
  kind: typeof RowKind.Prose;
  text: string;
  /** The live streaming tail; the only row whose content changes per frame. */
  streaming: boolean;
  /** Shown on the first prose row of an assistant turn. */
  showHeader: boolean;
  model: string | null;
  timestamp: string;
}

export interface ThinkingRow extends RowBase {
  kind: typeof RowKind.Thinking;
  text: string;
  streaming: boolean;
  expanded: boolean;
}

/**
 * Which glyph a marker row leads with — a closed set, mapped to an icon by the
 * renderer.
 *
 * A key rather than a component: rows are plain data compared shallowly by
 * `memo`, and a freshly-minted component reference per projection would miss
 * on every row, every frame. It is also the reason this lives here and not in
 * the render layer — classification already happens once, in `markerFor`, from
 * the same signals that pick the verb.
 */
export type MarkerTool =
  | "run"
  | "read"
  | "edit"
  | "search"
  | "list"
  | "fetch"
  | "think"
  | "delete"
  | "move"
  | "file"
  | "org"
  | "tool";

export interface MarkerRow extends RowBase {
  kind: typeof RowKind.Marker;
  /** Verb shown in muted weight: "Ran", "Read", "Edited", "Searched". */
  verb: string;
  /** Icon key for the leading slot, paired with `verb`. */
  tool: MarkerTool;
  /** Monospace remainder — the command, path or pattern. Truncated in CSS. */
  detail: string;
  state: MarkerState;
  toolCallId: string;
  opens: MarkerDetail;
  /** Full path for edit markers — `detail` is shortened for display, and the
   *  diff viewer needs the real one. */
  path?: string;
  /** The untouched shell command, on bash rows whose verb came from parsing it.
   *  `detail` shows the file those rows read, not the command that read it, so
   *  this is what the hover title falls back to — the information the
   *  reclassification hid has to stay reachable without opening the panel. */
  cmd?: string;
  /** Only set for edit markers, so the row can show `+n −m` inline. */
  added: number;
  removed: number;
  /** Epoch ms the call was first seen, client-stamped by the store. `undefined`
   *  on any call restored from a transcript — see `ToolCallDisplay.startedAt`.
   *  Feeds the live elapsed figure; nothing settled reads it. */
  startedAt: number | undefined;
}

export interface MarkerGroupRow extends RowBase {
  kind: typeof RowKind.MarkerGroup;
  /** The whole folded block as one sentence: "Read files, ran commands". This
   *  is what tells one block from the next in a column of them, which is why
   *  it is the line and not a fixed label. */
  summary: string;
  /** How many tool calls the block stands for. Not rendered — the summary is
   *  the whole line — but it is what `summary` was counted from, and the thing
   *  to assert on when testing that projection. */
  count: number;
  /** The glyph for the whole block: the icon of the FIRST bucket in `summary`,
   *  so the wrench leads "Loaded a tool, read files…" and the book leads "Read
   *  files, ran commands" — note 3 under "Folded-block summary". */
  tool: MarkerTool;
  /** Calls in this consecutive sequence, shown inside the disclosure. */
  markers: MarkerRow[];
  open: boolean;
  /** At least one call in the sequence is still active. */
  running: boolean;
  liveLabel: string | null;
  /** The active call's own glyph while `running` — the live line names that
   *  call, so it wears that call's icon rather than the block's. */
  liveTool: MarkerTool | null;
  /** Epoch ms the active call started, for the ticking figure in the live line's
   *  right gutter. The turn header above already counts the whole turn; this
   *  answers the different question a folded block otherwise hides — how long
   *  THIS command has been going, and therefore whether it is stuck. */
  liveStartedAt: number | null;
  /** Calls in this block already finished, shown beside the live line.
   *
   *  Deliberately not "3 of 6": tool calls stream in one at a time, so the
   *  total does not exist until the block ends. Counting what is DONE is the
   *  only honest progress a collapsed block can report, and it is the whole of
   *  the accumulation a one-line live state can show. */
  liveDone: number;
}

/**
 * "Working for 46s" / "Worked for 7m 37s ›" — the head of an assistant turn.
 *
 * Once the turn settles, everything before its final answer (earlier prose,
 * thinking, tool blocks) is folded behind this row and simply not projected, so
 * a finished turn costs a header, its answer and its footer however much work
 * it did. Opening it puts those rows back in the thread, in flow.
 */
export interface WorkHeaderRow extends RowBase {
  kind: typeof RowKind.WorkHeader;
  /** The turn is still running: the row ticks and nothing is folded. */
  live: boolean;
  /** Epoch ms the live clock counts from — the user's message. */
  startedAt: number | null;
  /** Settled wall time, when the turn was timed live (`ChatMessage.workedMs`). */
  workedMs: number | null;
  /** There are rows behind the header to fold; without them it is a caption. */
  foldable: boolean;
  open: boolean;
}

export interface SeparatorRow extends RowBase {
  kind: typeof RowKind.Separator;
  label: string;
}

export interface TurnFooterRow extends RowBase {
  kind: typeof RowKind.TurnFooter;
  /** The first few, shown collapsed. */
  files: TurnFile[];
  /** Everything — the overflow disclosure renders from this. */
  allFiles: TurnFile[];
  /** How many `allFiles` holds beyond `files`. */
  overflow: number;
  repoAtTurn: boolean;
  /** Message id, so the footer can reach usage/suggestions/contextUsage. */
  messageId: string;
  hasSuggestions: boolean;
  contextChip: boolean;
}

export type Row =
  | UserRow
  | ProseRow
  | ThinkingRow
  | MarkerRow
  | MarkerGroupRow
  | SeparatorRow
  | TurnFooterRow
  | WorkHeaderRow;

// ── Turns ──────────────────────────────────────────────────────────────────

export interface Turn {
  id: string;
  role: "user" | "assistant";
  /** Indices into the projection's `rows` array. */
  rowStart: number;
  rowEnd: number;
  /** Original `messages` index of the turn's first message — the existing
   *  `atlas:chat-jump` event and the bash panel address messages this way. */
  messageIndex: number;
  status: "streaming" | "settled" | "error";
  /** Preview for the nav rail (user turns only). */
  preview: string;
  timestamp: string;
  toolCount: number;
  fileCount: number;
}

export interface Projection {
  rows: Row[];
  turns: Turn[];
}

/**
 * Tool calls that are the agent talking to ITSELF — planning, task bookkeeping,
 * scheduling. They produce no artifact the reader can inspect and no change to
 * the project, so a run of five `TaskUpdate` lines is pure noise between two
 * paragraphs of prose. Dropped at projection time so they never cost a row.
 */
const INTERNAL_TOOLS = new Set([
  "exitplanmode",
  "todowrite",
  "taskcreate",
  "taskupdate",
  "taskget",
  "tasklist",
  "taskoutput",
  "taskstop",
  "schedulewakeup",
  "reportfindings",
  "updateplan",
  "plan",
]);

function isInternalTool(tc: ToolCallDisplay): boolean {
  return INTERNAL_TOOLS.has(tc.toolName.trim().toLowerCase());
}

// ── Marker labelling ───────────────────────────────────────────────────────

/** What a tool call changed, however it reported it. */
interface FileEdit {
  /** The file the marker names — the first one the call touched. */
  path: string;
  added: number;
  removed: number;
  created: boolean;
}

/** The edit a tool call reported STRUCTURALLY, as ACP `diff` content blocks.
 *
 *  An ACP agent's tools are its own: `apply_patch(patch_id)` says nothing that
 *  `classifyToolFileKind` can read, and the edit lives entirely in the blocks.
 *  Without this the marker fell through to the generic branch — no file name,
 *  no line counts, and a click that opened the output pane instead of the diff
 *  viewer, even though the before/after text was right there.
 *
 *  Each block carries the WHOLE file either side, not the fragment that
 *  changed, so blocks naming the SAME path collapse to first-before against
 *  last-after — the state the call found the file in against the state it left
 *  it in. Summing them instead would count intermediate states the reader
 *  never sees: a line rewritten twice would read as two changed lines against
 *  a diff showing one. This is the same fold `collectTurnEdits` does for the
 *  viewer the marker opens, so the count and the diff agree.
 *
 *  A tool call is still exactly ONE marker (the row invariant), so a call that
 *  changed several files is named by the first and sized by all of them. */
function diffEditOf(tc: ToolCallDisplay): FileEdit | null {
  const blocks = (tc.contentBlocks ?? []).filter((b) => b.type === "diff");
  if (blocks.length === 0) return null;

  const byPath = new Map<string, { old: string; new: string; created: boolean }>();
  for (const b of blocks) {
    const seen = byPath.get(b.path);
    byPath.set(b.path, {
      // The wire OMITS `oldText` for a file the call created; an empty string
      // is a real file that happened to be empty.
      old: seen ? seen.old : (b.oldText ?? ""),
      new: b.newText,
      created: seen ? seen.created : b.oldText === undefined,
    });
  }

  let added = 0;
  let removed = 0;
  for (const file of byPath.values()) {
    const counts = countChangedLines(file.old, file.new);
    added += counts.added;
    removed += counts.removed;
  }
  return {
    path: blocks[0].path,
    added,
    removed,
    // "Created" only when the call brought nothing into existence but new
    // files — one edited file among them makes it an edit.
    created: [...byPath.values()].every((file) => file.created),
  };
}

/** Trim a path to something that reads in one line without the eye scanning. */
function shortPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 2) return parts.join("/");
  return parts.slice(-2).join("/");
}

/** ACP's semantic class, which every agent that sets `kind` at all gets right. */
const TOOL_ICON_BY_KIND: Record<string, MarkerTool> = {
  execute: "run",
  read: "read",
  edit: "edit",
  delete: "delete",
  move: "move",
  search: "search",
  fetch: "fetch",
  think: "think",
};

/**
 * The icon key for a call the verb branches did not already classify.
 *
 * `kind` first — it is the protocol's own answer. The name sniff below only
 * catches MCP servers, which are free to send no kind at all; it is
 * deliberately narrow, because a wrong icon is worse than the generic wrench.
 * Substrings that appear inside unrelated words ("rm" in "confirm", "web" in
 * "webhook") are not in it for that reason.
 */
function toolIconFor(kind: string | null | undefined, toolName: string): MarkerTool {
  const byKind = TOOL_ICON_BY_KIND[kind ?? ""];
  if (byKind) return byKind;
  const name = toolName.toLowerCase();
  if (name.includes("search") || name.includes("grep") || name.includes("glob")) return "search";
  if (name.includes("fetch") || name.includes("http") || name.includes("url")) return "fetch";
  if (name.includes("delete") || name.includes("remove")) return "delete";
  if (name.includes("rename") || name.includes("move")) return "move";
  return "tool";
}

// ── Folded-block summary ───────────────────────────────────────────────────
//
// "Loaded a tool, read files, ran commands" — the whole of a folded turn as one
// sentence, the way the Codex desktop app writes it.
//
// That app is not open source and its UI was not part of the engine port, so
// unlike `parse-shell-command.ts` this is RECONSTRUCTED from screenshots rather
// than ported. Three things the screenshots actually prove, and which the code
// below is shaped by — change them only against new evidence:
//
//  1. The buckets are coarser than the row glyphs. A turn whose rows were
//     `run ×6, tool ×1, read ×1, search ×1` summarised as exactly three
//     fragments with no "searched" among them — so a search counts toward
//     "read files". The plural confirms it: that turn read ONE file by glyph
//     yet said "read files", which only adds up if the search counted too.
//  2. The order is fixed, not by frequency and not by when things happened.
//     That same turn led with "Loaded a tool" off a single call while its six
//     commands came last, and its first row chronologically was a command.
//  3. The glyph is the first bucket in the sentence, again not the commonest —
//     the wrench above six terminal rows, and a book on "Read files, ran
//     commands".
//
// Where the fragment for a bucket is unobserved (`edit`), or where a glyph has
// no obviously right bucket (`fetch`, `think`), the choice below is ours.

type SummaryBucket = "tool" | "read" | "edit" | "run";

/** Which sentence fragment each row glyph counts toward. */
const SUMMARY_BUCKET: Record<MarkerTool, SummaryBucket> = {
  run: "run",
  // Searching and listing are reading — see note 1 above.
  read: "read",
  search: "read",
  list: "read",
  file: "read",
  edit: "edit",
  delete: "edit",
  move: "edit",
  // Unobserved: a fetch or a think has no fragment of its own, and "loaded a
  // tool" is the least wrong of the four.
  tool: "tool",
  fetch: "tool",
  think: "tool",
  org: "tool",
};

/** Fixed order — note 2 above. `edit`'s slot is the one we chose. */
const SUMMARY_ORDER: readonly SummaryBucket[] = ["tool", "read", "edit", "run"];

/** [one, several]. The singular is load-bearing: "Loaded a tool" is what a
 *  single call reads as, and it is how note 1's plural was diagnosed.
 *
 *  A counted form ("3 files read") was tried on a two-line header and reverted:
 *  every block then opened with the same bold "Tool calls" label, so a column
 *  of them stopped differentiating at a glance. The sentence IS the
 *  differentiator — "Read files, ran commands" and "Edited files" are
 *  recognisably different lines. */
const SUMMARY_PHRASE: Record<SummaryBucket, [string, string]> = {
  tool: ["loaded a tool", "loaded tools"],
  read: ["read a file", "read files"],
  edit: ["edited a file", "edited files"],
  run: ["ran a command", "ran commands"],
};

/** One folded block → the sentence on its header, and the glyph that leads it
 *  (note 3: the first bucket's, not the commonest). */
function summarizeMarkers(markers: MarkerRow[]): { summary: string; tool: MarkerTool } {
  const counts = new Map<SummaryBucket, number>();
  for (const m of markers) {
    const bucket = SUMMARY_BUCKET[m.tool];
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  const present = SUMMARY_ORDER.filter((b) => counts.has(b));
  if (present.length === 0) return { summary: "Used tools", tool: "tool" };

  const fragments = present.map((b) => SUMMARY_PHRASE[b][counts.get(b) === 1 ? 0 : 1]);
  const sentence = fragments.join(", ");
  // Only the first fragment is capitalised; the rest stay mid-sentence.
  return {
    summary: sentence.charAt(0).toUpperCase() + sentence.slice(1),
    // Each bucket is named after the glyph that stands for it.
    tool: present[0],
  };
}

/**
 * A live disclosure names the current action, then returns to its aggregate
 * sentence when that action finishes. Keep the phrase short enough to occupy
 * the same quiet, single-line slot as the collapsed summary.
 *
 * The rule is "name the target, fall back to the generic phrase" — the generic
 * phrases exist for calls whose target Atlas could not read, NOT as the normal
 * case. `run` is why: "Running command" made `bun run build:app` and `ls`
 * render as the same line, and the command is the entire content of a run.
 *
 * Which part of the target gets named differs by tool, and it is not a style
 * choice. A path's basename identifies it ("Reading turn-rows.ts") while its
 * parent directories are noise at this size; a command, a pattern or a URL has
 * no such tail, and slicing one on "/" would cut it mid-token. So paths take
 * the last segment and everything else is used whole — CSS truncates the line.
 */
function liveMarkerLabel(marker: MarkerRow): string {
  const target = marker.detail;
  const basename = target.split("/").pop() ?? target;
  switch (marker.tool) {
    case "read":
      return target ? `Reading ${basename}` : "Reading files";
    case "edit":
      return target ? `Editing ${basename}` : "Editing files";
    case "delete":
      return target ? `Deleting ${basename}` : "Deleting files";
    case "move":
      return target ? `Moving ${basename}` : "Moving files";
    case "list":
      return target ? `Listing ${basename}` : "Listing files";
    case "file":
      return target ? `Opening ${basename}` : "Opening a file";
    // `search`'s detail is already a phrase ("pattern in dir"), so it reads as
    // the object of "searching for" rather than as a name.
    case "search":
      return target ? `Searching for ${target}` : "Searching files";
    case "run":
      return target ? `Running ${target}` : "Running command";
    case "fetch":
      return target ? `Fetching ${target}` : "Fetching content";
    case "think":
      return "Thinking…";
    // An organisation call's line is already a phrase ("Looked up Grace").
    case "org":
      return target ? `${marker.verb} ${target}` : marker.verb;
    default:
      return target ? `Running ${marker.verb} ${target}` : "Using a tool";
  }
}

/**
 * One tool call → one marker. Codex shows a single line with the command
 * truncated and no separate result row; state lives in the glyph and the full
 * output lives in the panel. We match that: a tool call never produces more
 * than one row, so a tool-heavy turn costs a predictable number of rows.
 */
function markerFor(tc: ToolCallDisplay, turnId: string, first: boolean): MarkerRow {
  const state: MarkerState =
    tc.status === "failed"
      ? "failed"
      : tc.status === "completed"
        ? "done"
        : tc.status === "running"
          ? "running"
          : "pending";

  // A tool call that ran a terminal always has an output pane worth opening,
  // even before the command's first byte: watching it stream is the point.
  const ranTerminal = (tc.contentBlocks ?? []).some((b) => b.type === "terminal");

  let verb = tc.toolName;
  let tool: MarkerTool = toolIconFor(tc.kind, tc.toolName);
  let detail = "";
  let cmd: string | undefined;
  let opens: MarkerDetail = tc.result || ranTerminal ? "output" : "none";
  let added = 0;
  let removed = 0;

  const args = tc.arguments ?? {};
  const fileKind = classifyToolFileKind(tc.kind, tc.toolName);
  const argsPath = getFilePathFromInput(args);
  // Two ways an edit is reported, one shape. Recognisable arguments win: a
  // tool Atlas already understands must not read differently just because the
  // agent also attached the structural blocks.
  const edit: FileEdit | null =
    fileKind === "edit" && argsPath
      ? {
          path: argsPath,
          created: isFileCreated(tc.toolName, args),
          ...countEditLines(tc.toolName, args),
        }
      : diffEditOf(tc);
  // The path the marker reports: whatever the arguments named, else whatever
  // the diff blocks did. It is what the diff viewer lands on.
  const path = argsPath ?? edit?.path ?? null;

  const orgTool = orgToolOf(tc.toolName);
  if (orgTool) {
    // An organisation call (ADR-0014): the organisation icon, and the line
    // that names what it was about — the member, conversation or recorded
    // session — from the table the Logs row reads too. A failed call's text
    // is its reason, so only a settled success's answer improves the name.
    const row = orgToolRow(orgTool, args, tc.status === "completed" ? tc.result : null);
    tool = "org";
    verb = row.verb;
    detail = row.detail;
  } else if (isBashToolCall(tc)) {
    // Every one of these is the same tool. What separates `cat file` from
    // `cargo test` is the command itself, so that is what gets read — see
    // `parse-shell-command.ts` for why this is a port and not a wire field.
    // A command it cannot reduce to one action stays "Ran", verbatim.
    const command = bashCommandOf(args) || (tc.kind === "execute" ? tc.toolName : "");
    opens = "output";
    cmd = command;
    const parsed = parseShellCommand(command);
    if (parsed.kind === "read") {
      verb = "Read";
      tool = "read";
      detail = shortPath(parsed.path);
    } else if (parsed.kind === "list") {
      verb = "Listed";
      tool = "list";
      detail = parsed.path ? shortPath(parsed.path) : "";
    } else if (parsed.kind === "search") {
      verb = "Searched";
      tool = "search";
      // "pattern in dir" — the pattern verbatim, since a regex may contain
      // slashes that `shortPath` would happily eat; only the path is shortened.
      detail = parsed.path
        ? `${parsed.query ?? ""} in ${shortPath(parsed.path)}`.trim()
        : (parsed.query ?? "");
    } else {
      verb = "Ran";
      tool = "run";
      detail = command;
      // The verb already says "Ran" and `detail` already IS the command, so a
      // title repeating it would be noise.
      cmd = undefined;
    }
  } else if (edit) {
    verb = edit.created ? "Created" : "Edited";
    tool = "edit";
    detail = shortPath(edit.path);
    added = edit.added;
    removed = edit.removed;
    opens = "diff";
  } else if (fileKind === "read" && path) {
    verb = "Read";
    tool = "read";
    detail = shortPath(path);
    opens = tc.result || ranTerminal ? "output" : "none";
  } else if (typeof args.pattern === "string") {
    verb = "Searched";
    tool = "search";
    detail = args.pattern;
    opens = "output";
  } else if (path) {
    verb = tc.toolName;
    // It named a file but neither `kind` nor its arguments say what it did to
    // it. A neutral page beats guessing between the book and the pencil.
    if (tool === "tool") tool = "file";
    detail = shortPath(path);
  } else {
    verb = tc.toolName;
    detail = "";
  }

  return {
    kind: RowKind.Marker,
    id: `mk:${tc.id}`,
    turnId,
    firstInTurn: first,
    verb,
    tool,
    detail: detail.replace(/\s+/g, " ").trim(),
    state,
    toolCallId: tc.id,
    opens,
    cmd,
    path: path ?? undefined,
    added,
    removed,
    startedAt: tc.startedAt,
  };
}

// ── Projection ─────────────────────────────────────────────────────────────

/** Gap between turns that earns a "N ago" separator. */
const TURN_GAP_MS = 20 * 60 * 1000;

function formatGap(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * A message renders nothing at all — no prose, no thinking, no tools, no files,
 * no plan. claude-agent-acp routinely emits signature-only `thinking` blocks
 * with empty content as turn markers; projecting them produced phantom rows
 * whose padding read as unexplained gaps. Filtered here rather than in the
 * list, so the row index never contains one.
 */
function isEmptyMessage(m: ChatMessage): boolean {
  return (
    !(m.content && m.content.trim()) &&
    !(m.thinking && m.thinking.trim()) &&
    m.toolCalls.length === 0 &&
    m.fileChanges.length === 0 &&
    !(m.plan && m.plan.length > 0)
  );
}

/**
 * Per-message derived-text caches, keyed by the message OBJECT. `projectRows`
 * runs once per applied streaming batch, and these strip/split/regex passes
 * over full message bodies made its per-frame cost scale with total transcript
 * bytes, not tail size (every assistant body paid a `toLowerCase` copy inside
 * `stripNextSteps`, every user prompt a whitespace regex — per frame, forever).
 * Immer keeps settled messages identity-stable across batches, so a WeakMap
 * hit costs one lookup; only the streaming tail (fresh identity each frame)
 * recomputes, and dead entries fall out with their messages via GC.
 */
interface UserDerived {
  text: string;
  contextBlocks: number;
  preview: string;
}
const userDerivedCache = new WeakMap<ChatMessage, UserDerived>();
const proseCache = new WeakMap<ChatMessage, string>();

function derivedUser(m: ChatMessage): UserDerived {
  const hit = userDerivedCache.get(m);
  if (hit) return hit;
  const split =
    m.atlasContext !== undefined
      ? {
          prose: m.atlasProse ?? m.content,
          context: m.atlasContext,
          blockCount: m.atlasContextBlockCount ?? 0,
        }
      : splitAtlasContext(m.content);
  const text = stripNextStepsDirective(split.prose).trim();
  const v: UserDerived = {
    text,
    contextBlocks: split.context ? split.blockCount : 0,
    preview: text.replace(/\s+/g, " ").slice(0, 80),
  };
  userDerivedCache.set(m, v);
  return v;
}

/** The text a user bubble SHOWS for `m` — injected memory/context blocks and
 *  the next-steps directive stripped. This is what a pin records, so it is the
 *  one comparison that survives ids being re-minted (`resolvePinIndex`). */
export function userMessageText(m: ChatMessage): string {
  return derivedUser(m).text;
}

/** The prose a response row SHOWS — the assistant half of a pin's durable
 *  key, the same way `userMessageText` is the prompt half. */
export function assistantMessageText(m: ChatMessage): string {
  return derivedProse(m);
}

function derivedProse(m: ChatMessage): string {
  const hit = proseCache.get(m);
  if (hit !== undefined) return hit;
  const v = stripNextSteps(m.content ?? "").trim();
  proseCache.set(m, v);
  return v;
}

export interface ProjectOptions {
  /** Ids of user bubbles / thinking blocks the reader has expanded. */
  expanded: ReadonlySet<string>;
  /** The trailing assistant message is live. */
  streaming: boolean;
  /** Turns whose tool-call block the reader has opened. */
  expandedTurns: ReadonlySet<string>;
  /** The trailing assistant turn has not finished, even if it is not streaming
   *  right now — it may be paused on a permission prompt. Drives the work
   *  header only; defaults to `streaming`. */
  turnInProgress?: boolean;
}

/**
 * Project a thread into rows.
 *
 * This DOES run per applied streaming batch — immer gives `messages` a new
 * identity on every appended chunk — which is why `prev` matters: rows and
 * turns that are field-identical to the previous projection are returned as
 * the PREVIOUS objects, so the memo'd row views hold for every row except the
 * ones that actually changed (typically just the streaming tail). Without the
 * sharing pass, every row object was freshly allocated each frame and every
 * mounted row re-rendered per chunk.
 */
export function projectRows(
  messages: ChatMessage[],
  opts: ProjectOptions,
  prev?: Projection | null,
): Projection {
  const rows: Row[] = [];
  const turns: Turn[] = [];

  const lastIdx = messages.length - 1;
  let i = 0;

  while (i < messages.length) {
    const m = messages[i];
    const isStreamingTail = opts.streaming && i === lastIdx && m.role === "assistant";

    if (!isStreamingTail && isEmptyMessage(m)) {
      i += 1;
      continue;
    }

    // ── User turn: exactly one row. ────────────────────────────────────────
    if (m.role === "user") {
      const derived = derivedUser(m);
      const text = derived.text;
      const turnId = `t:${m.id}`;
      // The gap separator belongs BETWEEN turns, so it is emitted before
      // `rowStart` is captured — otherwise a turn's first row would be the
      // separator, and both `firstInTurn` and every scroll anchor that targets
      // "the start of this turn" would point one row too high.
      maybeGapSeparator(rows, messages, i, turnId);
      const rowStart = rows.length;

      rows.push({
        kind: RowKind.User,
        id: `u:${m.id}`,
        turnId,
        firstInTurn: true,
        text,
        contextBlocks: derived.contextBlocks,
        expanded: opts.expanded.has(`u:${m.id}`),
        attachments: m.attachments ?? NO_ATTACHMENTS,
        timestamp: m.timestamp,
      });

      turns.push({
        id: turnId,
        role: "user",
        rowStart,
        rowEnd: rows.length,
        messageIndex: i,
        status: "settled",
        preview: derived.preview,
        timestamp: m.timestamp,
        toolCount: 0,
        fileCount: 0,
      });
      i += 1;
      continue;
    }

    // ── Assistant turn: consume the whole consecutive assistant run. ───────
    // The store emits one message per block (text / tool / thinking); a turn is
    // the run of them between user messages. Collapsing that run here is what
    // gives the footer and the "Show changes" button something to belong to.
    const turnFirstIdx = i;
    const turnId = `t:${m.id}`;
    maybeGapSeparator(rows, messages, i, turnId);
    const rowStart = rows.length;

    let markers: MarkerRow[] = [];
    const flushMarkers = () => {
      if (markers.length === 0) return;
      const id = `mg:${turnId}:${markers[0].toolCallId}`;
      rows.push({
        kind: RowKind.MarkerGroup,
        id,
        turnId,
        firstInTurn: rows.length === rowStart,
        ...summarizeMarkers(markers),
        count: markers.length,
        markers,
        open: opts.expandedTurns.has(id),
        running: false,
        liveLabel: null,
        liveTool: null,
        liveStartedAt: null,
        liveDone: 0,
      });
      markers = [];
    };
    let workedMs: number | null = null;
    let toolCount = 0;
    let footerMsg: ChatMessage | null = null;
    let headerShown = false;
    let sawError = false;

    while (i < messages.length && messages[i].role === "assistant") {
      const msg = messages[i];
      const tail = opts.streaming && i === lastIdx;
      if (!tail && isEmptyMessage(msg)) {
        i += 1;
        continue;
      }

      if (msg.thinking && msg.thinking.trim()) {
        flushMarkers();
        rows.push({
          kind: RowKind.Thinking,
          id: `th:${msg.id}`,
          turnId,
          firstInTurn: rows.length === rowStart,
          text: msg.thinking,
          streaming: tail,
          expanded: opts.expanded.has(`th:${msg.id}`),
        });
      }

      for (const tc of msg.toolCalls) {
        if (isInternalTool(tc)) continue;
        toolCount += 1;
        markers.push(markerFor(tc, turnId, false));
        if (tc.status === "failed") sawError = true;
      }

      const prose = derivedProse(msg);
      if (prose) {
        flushMarkers();
        rows.push({
          kind: RowKind.Prose,
          id: `p:${msg.id}`,
          turnId,
          firstInTurn: rows.length === rowStart,
          text: prose,
          streaming: tail,
          showHeader: !headerShown,
          model: msg.model ?? null,
          timestamp: msg.timestamp,
        });
        headerShown = true;
      }

      // The footer data is frozen onto the trailing message at turn_finished.
      if (msg.turnSummary || msg.suggestions || msg.contextUsage) footerMsg = msg;
      if (msg.workedMs !== undefined) workedMs = msg.workedMs;
      i += 1;
    }
    flushMarkers();

    const turnIsLive = opts.streaming && i > lastIdx;
    if (turnIsLive) {
      for (let rowIndex = rowStart; rowIndex < rows.length; rowIndex++) {
        const row = rows[rowIndex];
        if (row.kind !== RowKind.MarkerGroup) continue;
        // A RUNNING call outranks a later PENDING one. Agents that fan out
        // announce several calls before starting them, so the last unfinished
        // marker is routinely one that has not begun — taking it would put
        // "Running cargo test" on screen before cargo test was launched.
        let running: MarkerRow | null = null;
        let pending: MarkerRow | null = null;
        let done = 0;
        for (const marker of row.markers) {
          if (marker.state === "running") running = marker;
          else if (marker.state === "pending") pending = marker;
          else done += 1;
        }
        const active = running ?? pending;
        if (!active) continue;
        row.running = true;
        row.liveLabel = liveMarkerLabel(active);
        row.liveTool = active.tool;
        row.liveDone = done;
        // Only a running call is timed. A pending one has not started; its
        // stamp is when it was ANNOUNCED, so counting from it would report
        // queue time as work.
        row.liveStartedAt = running?.startedAt ?? null;
      }
    }

    const turnInProgress = (opts.turnInProgress ?? opts.streaming) && i > lastIdx;
    if (rows.length > rowStart) {
      foldWork(rows, rowStart, {
        turnId,
        live: turnInProgress,
        startedAt: turnInProgress ? turnStartMs(messages, turnFirstIdx) : null,
        workedMs,
        expandedTurns: opts.expandedTurns,
      });
    }

    if (footerMsg?.turnSummary) {
      const files = footerMsg.turnSummary.files;
      rows.push({
        kind: RowKind.TurnFooter,
        id: `f:${footerMsg.id}`,
        turnId,
        firstInTurn: false,
        files: files.slice(0, 3),
        allFiles: files,
        overflow: Math.max(0, files.length - 3),
        repoAtTurn: footerMsg.turnSummary.repoAtTurn,
        messageId: footerMsg.id,
        hasSuggestions: (footerMsg.suggestions?.chips.length ?? 0) > 0,
        contextChip: !!footerMsg.contextUsage || !!footerMsg.usage,
      });
    }

    if (rows.length > rowStart) {
      const firstMsg = messages[turnFirstIdx];
      turns.push({
        id: turnId,
        role: "assistant",
        rowStart,
        rowEnd: rows.length,
        messageIndex: turnFirstIdx,
        status: turnIsLive ? "streaming" : sawError ? "error" : "settled",
        preview: "",
        timestamp: firstMsg.timestamp,
        toolCount,
        fileCount: footerMsg?.turnSummary?.files.length ?? 0,
      });
    }
  }

  // Mark the first row of each turn now that splices are done.
  for (const t of turns) {
    if (rows[t.rowStart]) rows[t.rowStart].firstInTurn = true;
  }

  // Structural sharing — must run AFTER the firstInTurn pass above, or a reused
  // (shared) object could be mutated in place and the change would be invisible
  // to a memo comparing identities.
  if (prev) {
    const prevRows = new Map<string, Row>();
    for (const r of prev.rows) prevRows.set(r.id, r);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const old = prevRows.get(row.id);
      if (old?.kind === RowKind.MarkerGroup && row.kind === RowKind.MarkerGroup) {
        const oldMarkers = new Map(old.markers.map((marker) => [marker.id, marker]));
        row.markers = row.markers.map((marker) => {
          const previous = oldMarkers.get(marker.id);
          return previous && sameShallow(previous, marker) ? previous : marker;
        });
      }
      if (old && sameShallow(old, row)) rows[i] = old;
    }
    const prevTurns = new Map<string, Turn>();
    for (const t of prev.turns) prevTurns.set(t.id, t);
    for (let i = 0; i < turns.length; i++) {
      const old = prevTurns.get(turns[i].id);
      if (old && sameShallow(old, turns[i])) turns[i] = old;
    }
  }

  return { rows, turns };
}

/**
 * One-level equality for row/turn records. Arrays compare element-by-identity —
 * `TurnFooterRow.files` is re-`slice`d every projection, but its ELEMENTS are
 * the stable `turnSummary.files` objects frozen at turn end, so identity per
 * element is exactly the right test.
 */
function sameShallow(a: object, b: object): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    const va = (a as Record<string, unknown>)[k];
    const vb = (b as Record<string, unknown>)[k];
    if (va === vb) continue;
    if (Array.isArray(va) && Array.isArray(vb) && va.length === vb.length) {
      let eq = true;
      for (let i = 0; i < va.length; i++) {
        if (va[i] !== vb[i]) {
          eq = false;
          break;
        }
      }
      if (eq) continue;
    }
    return false;
  }
  return true;
}

/** When the live clock of the assistant turn at `firstIdx` starts: the user
 *  message it answers. Null when there is none to count from. */
function turnStartMs(messages: ChatMessage[], firstIdx: number): number | null {
  const prev = messages[firstIdx - 1];
  if (!prev || prev.role !== "user") return null;
  const t = Date.parse(prev.timestamp);
  return Number.isFinite(t) ? t : null;
}

/**
 * Put the work header at the head of the assistant turn starting at
 * `rowStart`, and — once the turn has settled and the reader has not opened it
 * — drop everything before the final answer.
 *
 * "The final answer" is the trailing run of prose rows: whatever the agent said
 * after it last used a tool or thought. A turn that ENDS on a tool block has no
 * answer, and folds whole.
 */
function foldWork(
  rows: Row[],
  rowStart: number,
  o: {
    turnId: string;
    live: boolean;
    startedAt: number | null;
    workedMs: number | null;
    expandedTurns: ReadonlySet<string>;
  },
): void {
  let answerStart = rows.length;
  while (answerStart > rowStart && rows[answerStart - 1].kind === RowKind.Prose) answerStart -= 1;
  const foldable = !o.live && answerStart > rowStart;
  // A settled prose-only turn with no timing has nothing to say.
  if (!o.live && !foldable && o.workedMs === null) return;

  const id = `wk:${o.turnId}`;
  const open = foldable && o.expandedTurns.has(id);
  if (foldable && !open) {
    const folded = rows.splice(rowStart, answerStart - rowStart);
    // The model · time line rode on the turn's first prose row, which may have
    // just been folded. Hand it to the first row still showing.
    const answer = rows[rowStart];
    if (
      answer?.kind === RowKind.Prose &&
      folded.some((r) => r.kind === RowKind.Prose && r.showHeader)
    ) {
      answer.showHeader = true;
    }
  }
  rows.splice(rowStart, 0, {
    kind: RowKind.WorkHeader,
    id,
    turnId: o.turnId,
    firstInTurn: true,
    live: o.live,
    startedAt: o.startedAt,
    workedMs: o.workedMs,
    foldable,
    open,
  });
}

/** Faint "N ago" divider marking a real pause between turns. */
function maybeGapSeparator(rows: Row[], messages: ChatMessage[], i: number, turnId: string): void {
  if (i === 0) return;
  const gap =
    new Date(messages[i].timestamp).getTime() - new Date(messages[i - 1].timestamp).getTime();
  if (gap <= TURN_GAP_MS) return;
  rows.push({
    kind: RowKind.Separator,
    id: `gs:${messages[i].id}`,
    turnId,
    firstInTurn: false,
    label: `${formatGap(gap)} ago`,
  });
}
