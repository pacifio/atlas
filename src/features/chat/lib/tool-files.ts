// Shared helpers for extracting file paths + edit diffs from agent tool-call
// arguments. Hoisted out of `message-item.tsx` so the chat-store reducer (which
// accumulates per-turn files-touched for the adaptive turn card) and the
// rendering layer agree exactly on paths + add/remove counts.

import type { TurnFile } from "@/types/agent";
import { enginePatchFiles } from "./engine-patch";

const FILE_PATH_KEYS = ["file_path", "path", "filename", "filePath"];

/** First file-path-like string in a tool call's arguments, or null. */
export function getFilePathFromInput(input: Record<string, unknown>): string | null {
  for (const k of FILE_PATH_KEYS) {
    const v = input[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  // The native engine's edit names its files as a list.
  const paths = input.paths;
  if (Array.isArray(paths) && typeof paths[0] === "string" && paths[0].length > 0) {
    return paths[0];
  }
  return null;
}

/** The file a tool call is about: its arguments first, then the ACP
 *  `locations` the agent attached — the same order Rust's
 *  `tool_stats::extract_path` reads them in, so the two layers name the same
 *  file for the same call. */
export function getToolFilePath(
  input: Record<string, unknown>,
  locations: readonly string[] | undefined,
): string | null {
  return getFilePathFromInput(input) ?? locations?.find((l) => l.length > 0) ?? null;
}

/** Tools that mutate files (Claude Code, Codex, native). */
const EDIT_TOOLS = new Set([
  "edit",
  "write",
  "multiedit",
  "create_file",
  "create",
  "str_replace",
  "str_replace_editor",
  "apply_patch",
]);

export interface EditPart {
  old: string;
  neu: string;
}

const asStr = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Before/after text pairs for an edit tool call, straight from its args.
 *
 *  `kind` is the ACP class. A whole-file write is recognised by the tool's
 *  NAME, and the name on the wire is whatever the agent put in the call's
 *  `_meta` — for most adapters the ACP title, "Write src/x.ts", which is not
 *  "write". Without the kind, every Write counted as zero lines while every
 *  Edit (recognised by its `old_string`) counted correctly. */
export function getEditParts(
  toolName: string,
  args: Record<string, unknown>,
  kind?: string | null,
): EditPart[] {
  const parts: EditPart[] = [];
  const edits = args.edits;
  if (Array.isArray(edits)) {
    for (const e of edits) {
      if (e && typeof e === "object") {
        const o = e as Record<string, unknown>;
        const old = asStr(o.old_string) ?? asStr(o.oldString) ?? asStr(o.old_str) ?? "";
        const neu = asStr(o.new_string) ?? asStr(o.newString) ?? asStr(o.new_str) ?? "";
        if (old || neu) parts.push({ old, neu });
      }
    }
    if (parts.length) return parts;
  }
  const old = asStr(args.old_string) ?? asStr(args.oldString) ?? asStr(args.old_str);
  const neu = asStr(args.new_string) ?? asStr(args.newString) ?? asStr(args.new_str);
  if (old != null || neu != null) return [{ old: old ?? "", neu: neu ?? "" }];
  // Whole-file write/create — only when the tool is actually an editor.
  if (kind === "edit" || EDIT_TOOLS.has(toolName.toLowerCase())) {
    const content =
      asStr(args.content) ?? asStr(args.new_content) ?? asStr(args.text) ?? asStr(args.file_text);
    if (content != null) return [{ old: "", neu: content }];
  }
  return parts;
}

/** Classify a tool call as touching a file for reading or editing. Relies on
 *  the ACP `kind` first (set by all three agents), falling back to name. */
export function classifyToolFileKind(
  kind: string | null | undefined,
  toolName: string,
): "read" | "edit" | null {
  const name = (toolName || "").toLowerCase();
  if (kind === "edit" || EDIT_TOOLS.has(name)) return "edit";
  if (kind === "read") return "read";
  return null;
}

/** Trim common prefix/suffix and count changed lines (matches `EditDiffView`).
 *
 *  Exported because an edit reaches Atlas two ways — as recognisable tool
 *  arguments, and as an ACP `diff` content block — and both must count it the
 *  same, or the same change reads as a different size depending on which
 *  shape the agent happened to send. */
export function countChangedLines(oldStr: string, neu: string): { added: number; removed: number } {
  // Lines as a diff counts them: an empty side is zero lines, not one empty
  // line, and a trailing newline ends the last line rather than starting an
  // empty one. A created file is then "+N", not "+N −1" — what a unified diff
  // of it says, and what the capture record counts for the same write.
  const lines = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));
  const o = lines(oldStr);
  const n = lines(neu);
  let start = 0;
  while (start < o.length && start < n.length && o[start] === n[start]) start++;
  let eo = o.length;
  let en = n.length;
  while (eo > start && en > start && o[eo - 1] === n[en - 1]) {
    eo--;
    en--;
  }
  return { removed: Math.max(0, eo - start), added: Math.max(0, en - start) };
}

/** True when an edit tool call CREATED the file (every edit op had empty prior
 *  content) → git-status "A". A normal edit (non-empty `old`) is "M". The
 *  native engine's edit created its files when each came as whole content. */
export function isFileCreated(
  toolName: string,
  args: Record<string, unknown>,
  kind?: string | null,
): boolean {
  const parts = getEditParts(toolName, args, kind);
  if (parts.length > 0) return parts.every((p) => p.old === "");
  const engine = enginePatchFiles(args);
  return !!engine && engine.every((f) => f.shape === "content");
}

/** Total added/removed line counts for an edit tool call, across every file
 *  it names. */
export function countEditLines(
  toolName: string,
  args: Record<string, unknown>,
  kind?: string | null,
): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  const parts = getEditParts(toolName, args, kind);
  for (const p of parts) {
    const c = countChangedLines(p.old, p.neu);
    added += c.added;
    removed += c.removed;
  }
  if (parts.length === 0) {
    for (const f of enginePatchFiles(args) ?? []) {
      added += f.added;
      removed += f.removed;
    }
  }
  return { added, removed };
}

/**
 * The files a tool call touched, as the per-turn record keeps them — empty
 * when the call is not about a file. One call usually names one file; the
 * native engine's edit names every file of its patch, each with its own
 * counts (`enginePatchFiles`).
 *
 * One builder for the live accumulator (`tool_call_upserted`) and the
 * transcript reconstruction (`reconstructTurnSummaries`), so a resumed session
 * and a live one cannot disagree about what a call did.
 */
export function turnFilesOfToolCall(call: {
  toolName: string;
  kind: string | null | undefined;
  arguments: Record<string, unknown>;
  locations?: readonly string[];
}): TurnFile[] {
  const kind = classifyToolFileKind(call.kind, call.toolName);
  if (!kind) return [];
  if (kind === "edit" && getEditParts(call.toolName, call.arguments, call.kind).length === 0) {
    const engine = enginePatchFiles(call.arguments);
    if (engine) {
      // A renamed file is listed where it went.
      return engine.map((f) => ({
        path: f.movePath ?? f.path,
        kind,
        added: f.added,
        removed: f.removed,
        created: f.shape === "content",
        ...(f.movePath ? { movedFrom: f.path } : {}),
      }));
    }
  }
  const path = getToolFilePath(call.arguments, call.locations);
  if (!path) return [];
  if (kind === "read") return [{ path, kind, added: 0, removed: 0, created: undefined }];
  const { added, removed } = countEditLines(call.toolName, call.arguments, call.kind);
  return [
    {
      path,
      kind,
      added,
      removed,
      created: isFileCreated(call.toolName, call.arguments, call.kind),
    },
  ];
}
