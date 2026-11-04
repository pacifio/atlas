/**
 * The transcript's rows as the package's `SessionView` blocks (D16: desktop
 * and web render a session from one presentational shape).
 *
 * Pure and React-free: it reads the `projectRows` projection and the messages
 * it came from, and maps each content row to a `TurnView` keyed by the row's
 * id. Only User, Prose, Thinking, MarkerGroup and (a settled turn's lone call)
 * Marker rows have one; WorkHeader, Separator, TurnFooter, Subagent, Injected
 * and Interruption rows keep their own views. Nothing here drives the
 * transcript yet: drawing tool calls as `ToolCallCard`s is a D24 change
 * waiting on ATL-718 (see ATL-910).
 *
 * Two rules:
 *
 * - It sets no turn outcome: an entry is one row, not a turn. A cancelled
 *   turn reads as its failed calls (the store sweeps live calls to failed)
 *   and a failed turn as failed calls plus the store's `Error: …` prose row,
 *   which is what the transcript shows today.
 * - It shares structure, like `projectRows` does: an entry whose inputs are
 *   the same objects as last time comes back as last time's `TurnView`, so a
 *   memoised `TurnRow` holds for every row but the one that changed. A tool
 *   call's output streams by replacing its `ToolCallDisplay` without touching
 *   the `MarkerRow`, which is why a group compares its calls too; a thought
 *   grows in its message while a collapsed `ThinkingRow` stays put, which is
 *   why a thinking entry compares its text.
 */

import type {
  AttachmentView,
  DiffData,
  SessionPhase,
  SessionView,
  StreamingState,
  ToolCallView,
  ToolKind,
  TurnView,
} from "@tryatlas/design/session";
import type { ChatMessage, ToolCallDisplay } from "@/types/agent";
import { bashCommandOf, isBashToolCall } from "./tool-calls";
import {
  RowKind,
  userRowMessageId,
  type MarkerRow,
  type MarkerTool,
  type Projection,
  type Row,
} from "./turn-rows";

export interface AdapterInput {
  messages: readonly ChatMessage[];
  projection: Projection;
  phase: SessionPhase;
  /** The model line's fallback when a message names no model. */
  agentLabel: string;
}

export interface TranscriptSessionView {
  /** By row id; only content rows have one (see the header). */
  byRow: ReadonlyMap<string, TurnView>;
  streaming: StreamingState | undefined;
  phase: SessionPhase;
}

/** What an entry was built from: reused while every one is the same value. */
interface Built {
  row: Row;
  deps: readonly unknown[];
}
const built = new WeakMap<TurnView, Built>();

const KIND: Record<MarkerTool, ToolKind> = {
  run: "execute",
  read: "read",
  list: "read",
  edit: "edit",
  delete: "delete",
  move: "move",
  search: "search",
  fetch: "fetch",
  think: "think",
  file: "other",
  org: "other",
  memory: "other",
  browser: "other",
  tool: "other",
};

const NO_DEPS: readonly unknown[] = [];

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Project the transcript's rows onto `TurnView`s, reusing `prev`'s where nothing changed. */
export function toSessionView(
  input: AdapterInput,
  prev?: TranscriptSessionView | null,
): TranscriptSessionView {
  const { messages, projection, phase, agentLabel } = input;
  const byId = new Map<string, ToolCallDisplay>();
  const messageById = new Map<string, ChatMessage>();
  for (const m of messages) {
    messageById.set(m.id, m);
    for (const tc of m.toolCalls) byId.set(tc.id, tc);
  }

  const byRow = new Map<string, TurnView>();
  let streaming: StreamingState | undefined;
  for (const row of projection.rows) {
    let deps: readonly unknown[] = NO_DEPS;
    let make: (() => TurnView) | null = null;
    switch (row.kind) {
      case RowKind.User: {
        const id = userRowMessageId(row.id);
        make = () => ({ key: id, user: userOf(row, id), items: [] });
        break;
      }
      case RowKind.Prose: {
        const id = row.id.slice(2);
        if (row.streaming) streaming = { itemId: id, activity: "text" };
        const model = row.showHeader ? row.model || agentLabel : undefined;
        deps = [model];
        make = () => ({
          key: row.id,
          items: [{ kind: "text", id, text: row.text, at: row.timestamp, ...(model && { model }) }],
        });
        break;
      }
      case RowKind.Thinking: {
        const id = row.id.slice(3);
        if (row.streaming && streaming?.activity !== "text") {
          streaming = { itemId: id, activity: "thinking" };
        }
        // A collapsed row carries no text: the thought is the message's.
        const text = messageById.get(id)?.thinking ?? row.text;
        deps = [text];
        make = () => ({ key: row.id, items: [{ kind: "thinking", id, text }] });
        break;
      }
      case RowKind.MarkerGroup: {
        const calls = row.markers.map((m) => byId.get(m.toolCallId));
        deps = calls;
        make = () => ({
          key: row.id,
          items: row.markers.flatMap((m, i) => {
            const tc = calls[i];
            return tc ? [{ kind: "tool" as const, call: toToolCallView(tc, m) }] : [];
          }),
        });
        break;
      }
      case RowKind.Marker: {
        // A settled turn's lone call stands alone rather than in a group.
        const tc = byId.get(row.toolCallId);
        if (!tc) break;
        deps = [tc];
        make = () => ({ key: row.id, items: [{ kind: "tool", call: toToolCallView(tc, row) }] });
        break;
      }
    }
    if (!make) continue;
    const old = prev?.byRow.get(row.id);
    const was = old && built.get(old);
    if (old && was && was.row === row && sameDeps(was.deps, deps)) {
      byRow.set(row.id, old);
      continue;
    }
    const view = make();
    built.set(view, { row, deps });
    byRow.set(row.id, view);
  }
  return { byRow, streaming, phase };
}

function userOf(row: Extract<Row, { kind: typeof RowKind.User }>, id: string): TurnView["user"] {
  const attachments: AttachmentView[] = row.attachments.map((a) => ({
    kind: "image",
    mimeType: a.mimeType,
    src: `data:${a.mimeType};base64,${a.dataBase64}`,
  }));
  if (row.contextBlocks > 0) {
    attachments.push({ kind: "file", name: `${row.contextBlocks} attached` });
  }
  return {
    id,
    text: row.text,
    at: row.timestamp,
    ...(attachments.length > 0 && { attachments }),
  };
}

/**
 * One call as a card. A shell call is a terminal (command and output) rather
 * than input and output; an edit carries its counts as a diff with no texts,
 * because diffs open in the real viewer and whole files never go into the view.
 */
export function toToolCallView(tc: ToolCallDisplay, marker: MarkerRow): ToolCallView {
  const view: ToolCallView = {
    id: tc.id,
    name: tc.toolName,
    title: marker.detail ? `${marker.verb} ${marker.detail}` : marker.verb,
    kind: KIND[marker.tool],
    status: tc.status,
  };
  if (tc.startedAt !== undefined && Number.isFinite(tc.startedAt))
    view.at = new Date(tc.startedAt).toISOString();
  const durationMs = marker.durationMs ?? tc.duration ?? undefined;
  if (durationMs !== undefined) view.durationMs = durationMs;
  if (marker.path) view.paths = [marker.path];
  const args = tc.arguments ?? {};
  if (isBashToolCall(tc)) {
    view.terminal = { command: bashCommandOf(args) || tc.toolName, output: tc.result ?? "" };
  } else {
    if (Object.keys(args).length > 0) view.input = { text: JSON.stringify(args, null, 2) };
    if (tc.result != null) view.output = { text: tc.result };
  }
  if (marker.opens === "diff" && marker.path) {
    const diff: DiffData = {
      path: marker.path,
      insertions: marker.added,
      deletions: marker.removed,
      change: marker.verb === "Created" ? "added" : "modified",
    };
    view.diffs = [diff];
  }
  return view;
}

/**
 * The whole transcript as one `SessionView`: `byRow` merged in row order into
 * conversational turns, a new one at each prompt (keyed by its message id,
 * D16). Rows before the first prompt go into a turn keyed `pre`. Built fresh
 * each call: it is for drawing a whole session at once, not per frame. A settled
 * turn's folded work is not in the projection, so it is not here either.
 */
export function assembleSessionView(t: TranscriptSessionView, rows: readonly Row[]): SessionView {
  const turns: TurnView[] = [];
  let current: TurnView | null = null;
  for (const row of rows) {
    const view = t.byRow.get(row.id);
    if (!view) continue;
    if (row.kind === RowKind.User) {
      current = { key: view.key, user: view.user, items: [] };
      turns.push(current);
      continue;
    }
    if (!current) {
      current = { key: "pre", items: [] };
      turns.push(current);
    }
    current.items.push(...view.items);
  }
  return { meta: {}, phase: t.phase, turns, streaming: t.streaming };
}
