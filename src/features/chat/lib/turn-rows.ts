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
import { isBashToolCall, bashCommandOf } from "./tool-calls";
import {
  getFilePathFromInput,
  classifyToolFileKind,
  countEditLines,
  isFileCreated,
} from "./tool-files";
import { splitAtlasContext } from "./atlas-context";
import { stripNextSteps } from "./next-steps";

// ── Row kinds ──────────────────────────────────────────────────────────────

export const RowKind = {
  User: 0,
  Prose: 1,
  Thinking: 2,
  Marker: 3,
  MarkerGroup: 4,
  Separator: 5,
  TurnFooter: 6,
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
  attachments: number;
  timestamp: string;
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

export interface MarkerRow extends RowBase {
  kind: typeof RowKind.Marker;
  /** Verb shown in muted weight: "Ran", "Read", "Edited", "Searched". */
  verb: string;
  /** Monospace remainder — the command, path or pattern. Truncated in CSS. */
  detail: string;
  state: MarkerState;
  toolCallId: string;
  opens: MarkerDetail;
  /** Full path for edit markers — `detail` is shortened for display, and the
   *  diff viewer needs the real one. */
  path?: string;
  /** Only set for edit markers, so the row can show `+n −m` inline. */
  added: number;
  removed: number;
}

export interface MarkerGroupRow extends RowBase {
  kind: typeof RowKind.MarkerGroup;
  /** What this run did, in words: "Ran 3 shell commands, read 2 files". The
   *  reader should not have to open a block to know whether it is worth
   *  opening. */
  summary: string;
  /** How many tool calls the block stands for. */
  count: number;
  /** Distinct files edited by those calls. */
  modified: number;
  /** Lines added across them. */
  added: number;
  /** Wall time of the turn, pre-formatted; null when too short to be worth it. */
  duration: string | null;
  open: boolean;
  /** The turn is still running, so the markers below are live progress. */
  running: boolean;
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
  | TurnFooterRow;

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

/**
 * Trim a path to something that reads in one line without the eye scanning.
 *
 * Keeps the leading directories and the filename and elides the middle. The
 * segments nearest a file — `src`, `lib`, `components` — are the ones least
 * likely to tell two files apart, so keeping the *last* two rendered both
 * `crates/atlas-cersei/src/lib.rs` and `crates/atlas-agents/src/lib.rs` as
 * `src/lib.rs`, and a transcript full of `Read src/lib.rs` said nothing about
 * which file was read.
 */
export function shortPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 3) return parts.join("/");
  return [...parts.slice(0, 2), "…", parts[parts.length - 1]].join("/");
}

/**
 * What a run of tool calls did, in words.
 *
 * A count alone ("7 calls") tells the reader nothing about whether the block is
 * worth opening. Naming the work — "Ran 3 shell commands, read 2 files" — is
 * what lets a turn be followed without expanding anything, which is the whole
 * point of folding it.
 */
function summarise(markers: MarkerRow[]): string {
  // Grouped by the verb the marker already carries, so this stays in step with
  // whatever `markerFor` decided to call the call.
  const nouns: Record<string, [string, string]> = {
    Ran: ["shell command", "shell commands"],
    Read: ["file", "files"],
    Edited: ["file", "files"],
    Created: ["file", "files"],
    Searched: ["pattern", "patterns"],
  };
  const counts = new Map<string, number>();
  for (const m of markers) counts.set(m.verb, (counts.get(m.verb) ?? 0) + 1);

  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([verb, n], i) => {
      const noun = nouns[verb];
      // An unmapped verb is the tool's own name — keep its casing, since
      // lower-casing it produced "terminalStart 1×".
      if (!noun) return `${verb} ${n}×`;
      const label = i === 0 ? verb : verb.toLowerCase();
      return `${label} ${n} ${n === 1 ? noun[0] : noun[1]}`;
    });

  // Three named kinds, then a tail count — a summary that needs a scrollbar is
  // not a summary, but hiding a kind behind "+1 more" is worse than naming it.
  const NAMED = 3;
  if (parts.length <= NAMED) return parts.join(", ");
  const rest = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(NAMED)
    .reduce((n, [, c]) => n + c, 0);
  return `${parts.slice(0, NAMED).join(", ")} +${rest} more`;
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

  let verb = tc.toolName;
  let detail = "";
  let opens: MarkerDetail = tc.result ? "output" : "none";
  let added = 0;
  let removed = 0;

  const args = tc.arguments ?? {};
  const fileKind = classifyToolFileKind(tc.kind, tc.toolName);
  const path = getFilePathFromInput(args);

  if (isBashToolCall(tc)) {
    verb = "Ran";
    detail = bashCommandOf(args);
    opens = "output";
  } else if (fileKind === "edit" && path) {
    verb = isFileCreated(tc.toolName, args, tc.diff) ? "Created" : "Edited";
    detail = shortPath(path);
    const counts = countEditLines(tc.toolName, args, tc.diff);
    added = counts.added;
    removed = counts.removed;
    opens = "diff";
  } else if (fileKind === "read" && path) {
    verb = "Read";
    detail = shortPath(path);
    opens = tc.result ? "output" : "none";
  } else if (typeof args.pattern === "string") {
    verb = "Searched";
    detail = args.pattern;
    opens = "output";
  } else if (path) {
    verb = tc.toolName;
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
    detail: detail.replace(/\s+/g, " ").trim(),
    state,
    toolCallId: tc.id,
    opens,
    path: path ?? undefined,
    added,
    removed,
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

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
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
  const text = stripNextSteps(split.prose).trim();
  const v: UserDerived = {
    text,
    contextBlocks: split.context ? split.blockCount : 0,
    preview: text.replace(/\s+/g, " ").slice(0, 80),
  };
  userDerivedCache.set(m, v);
  return v;
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
  /** Ids of tool-call blocks the reader has opened. A turn has one per run of
   *  consecutive tool calls, so expansion is per block and not per turn. */
  expandedGroups: ReadonlySet<string>;
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

  // The live turn is the assistant run after the last user message. Computed
  // once here because each run of tool calls needs to know whether it is the
  // trailing one *while* it is being emitted, not after the turn closes.
  let lastUserIdx = -1;
  for (let k = lastIdx; k >= 0; k--) {
    if (messages[k].role === "user") {
      lastUserIdx = k;
      break;
    }
  }

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
        attachments: m.attachments?.length ?? 0,
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

    let toolCount = 0;
    let footerMsg: ChatMessage | null = null;
    let headerShown = false;
    let sawError = false;

    // ── Tool calls group by RUN, and stay where they happened ──────────────
    //
    // A run is a maximal stretch of tool calls with no prose or thinking
    // between them. Every run is emitted at its own position, so narration and
    // the action it describes stay adjacent:
    //
    //     "First I'll check the config."   ← prose
    //     Read 1 file                      ← run
    //     "That confirmed the bug."        ← prose
    //     Edited 1 file                    ← run
    //
    // The previous version accumulated every marker in the turn and spliced
    // them all at the first tool call, which rendered as the complete list of
    // actions followed by every paragraph explaining them — in the wrong
    // order, with no way to tell which sentence went with which call. Density
    // was the reason, and folding a run still buys that; hoisting never did.
    const turnIsLive = opts.streaming && turnFirstIdx > lastUserIdx;
    let run: MarkerRow[] = [];
    let runStartTs = 0;
    let runEndTs = 0;
    let runIndex = 0;

    /** Emit the pending run as one folded block at the current position. */
    const flushRun = (isLast: boolean) => {
      if (run.length === 0) return;
      const groupId = `mg:${turnId}:${runIndex}`;
      // While the turn is live the trailing run is its progress report, so it
      // stays open; runs that already finished fold, exactly as they do once
      // the turn settles.
      const running = isLast && turnIsLive;
      const open = running || opts.expandedGroups.has(groupId);
      const span = runEndTs - runStartTs;
      rows.push({
        kind: RowKind.MarkerGroup,
        id: groupId,
        turnId,
        firstInTurn: false,
        summary: summarise(run),
        count: run.length,
        modified: new Set(run.filter((r) => r.opens === "diff").map((r) => r.detail)).size,
        added: run.reduce((n, r) => n + r.added, 0),
        duration: span > 1000 ? fmtDuration(span) : null,
        open,
        running,
      });
      if (open) rows.push(...run);
      run = [];
      runIndex += 1;
    };

    while (i < messages.length && messages[i].role === "assistant") {
      const msg = messages[i];
      const tail = opts.streaming && i === lastIdx;
      if (!tail && isEmptyMessage(msg)) {
        i += 1;
        continue;
      }

      const ts = new Date(msg.timestamp).getTime();
      if (msg.thinking && msg.thinking.trim()) {
        flushRun(false);
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
        if (run.length === 0) runStartTs = ts;
        runEndTs = ts;
        toolCount += 1;
        run.push(markerFor(tc, turnId, false));
        if (tc.status === "failed") sawError = true;
      }

      const prose = derivedProse(msg);
      if (prose) {
        // Before the prose, so the calls this paragraph is about sit above it.
        flushRun(false);
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
      i += 1;
    }

    // Whatever the turn ended on. A turn that finishes with tool calls has no
    // prose after them to trigger the flush.
    flushRun(true);

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
        status: opts.streaming && i > lastIdx ? "streaming" : sawError ? "error" : "settled",
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
      const old = prevRows.get(rows[i].id);
      if (old && sameShallow(old, rows[i])) rows[i] = old;
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
