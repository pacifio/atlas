// The turn rail's pure half: which turns get a tick, where each tick sits, which
// one the reader is on, and how much gutter the rail may use. Everything here is
// a function of plain numbers or of the projection, so it is tested without a
// DOM; `turn-rail.tsx` is the half that touches one.
//
// A tick is one TURN in the reader's sense: a user prompt and everything the
// agent did in reply, up to the next prompt. The projection's own `turns` split
// the reply off as a separate assistant turn, so only the user turns become
// ticks, and the reply is found by walking forward to the next user row.

import type { Nodes } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { TURN_RAIL_PERSISTENT_GUTTER } from "./row-metrics";
import { RowKind, type Projection, type Row } from "./turn-rows";

export interface TurnRailItem {
  /** The user row's id (`u:<messageId>`), which is also its `data-row-id`. */
  readonly id: string;
  /** What `Transcript.scrollToMessage` takes. */
  readonly messageIndex: number;
}

export interface TurnRailPreview {
  readonly userText: string | null;
  readonly assistantText: string | null;
}

/** Below this many turns there is nothing to navigate between. */
export const TURN_RAIL_MIN_ITEMS = 2;
/** Pixels between ticks before the rail compresses to its maximum height. */
const TURN_RAIL_ITEM_SPACING = 8;
/** The rail never grows past this, however long the session: past it the ticks
 *  compress toward each other instead. */
const TURN_RAIL_MAX_HEIGHT_CSS = "calc(100vh - 18rem)";
/** The hit strip starts this far into the gutter (the ticks' own inset). */
const TURN_RAIL_HIT_STRIP_LEFT = 12;
const TURN_RAIL_HIT_STRIP_MAX_WIDTH = 40;
/** While a preview card is open the strip widens to take in the card, so the
 *  pointer can travel onto it without the card closing. */
const TURN_RAIL_EXPANDED_HIT_STRIP_WIDTH = "22rem";
/** The previous/next buttons sit centred on the strip's left edge; a strip
 *  narrower than this would leave them half outside the panel. */
const TURN_RAIL_NAVIGATION_REACH = 14;
/** Upper bound on the reply text parsed for a preview, which shows three lines.
 *  Keeps the parse cheap while a long reply is still streaming. */
const PREVIEW_SOURCE_LIMIT = 1_500;

// ── Items ───────────────────────────────────────────────────────────────────

/** One item per user turn, in thread order. */
export function deriveTurnRailItems(projection: Projection): TurnRailItem[] {
  const items: TurnRailItem[] = [];
  for (const turn of projection.turns) {
    if (turn.role !== "user") continue;
    const row = projection.rows[turn.rowStart];
    if (row?.kind !== RowKind.User) continue;
    items.push({ id: row.id, messageIndex: turn.messageIndex });
  }
  return items;
}

/**
 * `next` when it differs from `prev`, else `prev` itself. The projection is
 * rebuilt on every streaming frame, and the rail must not re-render with it:
 * the turn list only changes when a prompt is sent or history loads.
 */
export function stableTurnRailItems(
  prev: readonly TurnRailItem[] | null,
  next: TurnRailItem[],
): readonly TurnRailItem[] {
  if (!prev || prev.length !== next.length) return next;
  for (let i = 0; i < next.length; i++) {
    if (prev[i].id !== next[i].id || prev[i].messageIndex !== next[i].messageIndex) return next;
  }
  return prev;
}

/**
 * The prompt of the turn whose user row is `userRowId`, and the agent's final
 * text in reply: the last prose row before the next prompt. Raw text; the card
 * compacts it through `resolveTurnRailPreview`.
 */
export function turnRailPreviewSource(
  rows: readonly Row[],
  userRowId: string,
): TurnRailPreview | null {
  const start = rows.findIndex((row) => row.id === userRowId);
  const userRow = rows[start];
  if (userRow?.kind !== RowKind.User) return null;
  let assistantText: string | null = null;
  for (let i = start + 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.kind === RowKind.User || row.kind === RowKind.Injected) break;
    if (row.kind === RowKind.Prose && row.text.trim()) assistantText = row.text;
  }
  return { userText: userRow.text, assistantText };
}

// ── Preview text ────────────────────────────────────────────────────────────

const markdownPreviewParser = unified().use(remarkParse).use(remarkGfm).freeze();

const INLINE_PARENT_TYPES = new Set<Nodes["type"]>([
  "paragraph",
  "heading",
  "tableCell",
  "emphasis",
  "strong",
  "delete",
  "link",
  "linkReference",
]);

const BLOCK_HTML_TAG =
  /^(?:address|article|aside|blockquote|br|dd|details|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|summary|table|tbody|td|th|thead|tr|ul)$/i;

function markdownNodeText(node: Nodes): string {
  if (node.type === "html") {
    return node.value
      .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
      .replace(/<\/?([a-z][\w-]*)(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi, (_, tag: string) =>
        BLOCK_HTML_TAG.test(tag) ? " " : "",
      );
  }
  if (node.type === "break") return " ";
  if ("value" in node) return node.value;
  if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
  if (!("children" in node)) return "";
  const separator = INLINE_PARENT_TYPES.has(node.type) ? "" : " ";
  return node.children.map(markdownNodeText).join(separator);
}

function compactPreview(text: string | null | undefined): string | null {
  const compact = text?.replace(/\s+/g, " ").trim() ?? "";
  return compact.length > 0 ? compact : null;
}

/** The card's text: whitespace collapsed, and the reply's markdown reduced to
 *  the words it renders as. */
export function resolveTurnRailPreview(source: TurnRailPreview | null): TurnRailPreview | null {
  if (source === null) return null;
  return {
    userText: compactPreview(source.userText),
    assistantText: compactPreview(
      source.assistantText === null
        ? null
        : markdownNodeText(
            markdownPreviewParser.parse(source.assistantText.slice(0, PREVIEW_SOURCE_LIMIT)),
          ),
    ),
  };
}

// ── Geometry ────────────────────────────────────────────────────────────────

/** Natural spacing until the cap, then compression: the ticks are placed by
 *  percentage, so a capped rail pulls them closer together. */
export function resolveTurnRailHeightStyle(itemCount: number): string {
  const naturalHeight = Math.max(1, (itemCount - 1) * TURN_RAIL_ITEM_SPACING);
  return `min(${naturalHeight}px, ${TURN_RAIL_MAX_HEIGHT_CSS})`;
}

export function resolveTurnRailTopPercent(index: number, itemCount: number): number {
  if (itemCount <= 1) return 0;
  return (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) * 100;
}

/** The tick nearest the pointer, so a compressed rail is still hoverable
 *  without aiming at a 2px line. */
export function resolveTurnRailIndexFromPointer(input: {
  readonly itemCount: number;
  readonly railTop: number;
  readonly railHeight: number;
  readonly pointerY: number;
}): number | null {
  if (input.itemCount <= 0 || input.railHeight <= 0) return null;
  if (input.itemCount === 1) return 0;
  const progress = Math.max(0, Math.min(1, (input.pointerY - input.railTop) / input.railHeight));
  return Math.max(0, Math.min(input.itemCount - 1, Math.round(progress * (input.itemCount - 1))));
}

/** Where a turn's prompt sits relative to the visible part of the transcript.
 *  A prompt above the mounted window is `above`. */
export type TurnRailPlacement = "above" | "in" | "below";

/**
 * The turn being read: the first prompt in view, else the last one above the
 * viewport (the reader is partway through its reply). `null` before any.
 */
export function resolveTurnRailCurrentIndex(
  placements: readonly TurnRailPlacement[],
): number | null {
  let preceding: number | null = null;
  for (let i = 0; i < placements.length; i++) {
    const placement = placements[i];
    if (placement === "in") return i;
    if (placement === "below") return preceding;
    preceding = i;
  }
  return preceding;
}

function sanitizeGutter(gutter: number): number {
  return Number.isFinite(gutter) && gutter > 0 ? gutter : 0;
}

export function resolveTurnRailHasPersistentGutter(gutter: number): boolean {
  return sanitizeGutter(gutter) >= TURN_RAIL_PERSISTENT_GUTTER;
}

/** 0 when the gutter is too narrow for a strip at all: the rail is then inert
 *  and never shown. */
export function resolveTurnRailHitStripWidth(gutter: number): number {
  return Math.max(
    0,
    Math.min(
      TURN_RAIL_HIT_STRIP_MAX_WIDTH,
      Math.floor(sanitizeGutter(gutter)) - TURN_RAIL_HIT_STRIP_LEFT,
    ),
  );
}

export function resolveTurnRailNavigationInteractive(collapsedWidth: number): boolean {
  return collapsedWidth >= TURN_RAIL_NAVIGATION_REACH;
}

export function resolveTurnRailInteractiveWidth(
  collapsedWidth: number,
  expanded: boolean,
): number | string {
  return expanded ? TURN_RAIL_EXPANDED_HIT_STRIP_WIDTH : collapsedWidth;
}
