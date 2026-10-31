/**
 * The leading icon of a tool line, and the two numbers that size it.
 *
 * Lifted out of `transcript-rows.tsx` because the transcript is no longer the
 * only surface that draws a tool call as one line: the Timeline's recorded
 * session renders the same "icon + verb + target" sentence (see
 * `artifacts/lib/tool-line.ts`). A second icon table would be two vocabularies
 * for one thing, and they would drift the first time a tool was added.
 */

import {
  AppWindow,
  ArrowRightLeft,
  BookOpen,
  Brain,
  BrainCircuit,
  Building2,
  File,
  FolderClosed,
  Globe,
  Pencil,
  Search,
  SquareTerminal,
  Trash2,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import type { MarkerTool } from "../lib/turn-rows";

/**
 * One icon per `MarkerTool` key, in a small fixed vocabulary: the
 * wrench for a loaded tool, the book for a read, the boxed prompt for a
 * command, the folder for a listing, the magnifier for a search.
 *
 * Shapes only, never colours (house rule 2) — the one tint is red on failure.
 * Keyed by the projection's classification so rows stay plain data; see
 * `MarkerTool` in `turn-rows.ts` for how each call is classified.
 */
const TOOL_ICON: Record<MarkerTool, LucideIcon> = {
  run: SquareTerminal,
  read: BookOpen,
  edit: Pencil,
  search: Search,
  list: FolderClosed,
  fetch: Globe,
  // A delegated sub-agent is a different KIND of work from a file read.
  think: Brain,
  delete: Trash2,
  move: ArrowRightLeft,
  file: File,
  // An organisation call (ADR-0014): the building the organisation screens
  // already use.
  org: Building2,
  // Atlas memory: the Memory tab's own icon.
  memory: BrainCircuit,
  // A browser-driving MCP server, whichever one.
  browser: AppWindow,
  tool: Wrench,
};

/** Near the height of the 13px row text, drawn at a thin stroke. */
export const ICON_PX = 14;
export const ICON_STROKE = 1.5;

/** A tool call's (or a block's) leading icon, red when it failed. */
export function ToolGlyph({ tool, failed }: { tool: MarkerTool; failed: boolean }) {
  const Icon = TOOL_ICON[tool];
  return (
    <Icon
      size={ICON_PX}
      strokeWidth={ICON_STROKE}
      className={failed ? "text-[var(--atlas-status-error-foreground)]" : undefined}
    />
  );
}

/** Rows whose detail is a file the reader can open — only these get the dimmer,
 *  dotted-underline link treatment. A command or a search pattern is not a
 *  link, so it stays in the verb's tone. */
export const FILE_DETAIL = new Set<MarkerTool>(["read", "edit", "file"]);
