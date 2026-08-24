// Shared helpers for extracting file paths + edit diffs from agent tool-call
// arguments. Hoisted out of `message-item.tsx` so the chat-store reducer (which
// accumulates per-turn files-touched for the adaptive turn card) and the
// rendering layer agree exactly on paths + add/remove counts.

const FILE_PATH_KEYS = ["file_path", "path", "filename", "filePath"];

/** First file-path-like string in a tool call's arguments, or null. */
export function getFilePathFromInput(input: Record<string, unknown>): string | null {
  for (const k of FILE_PATH_KEYS) {
    const v = input[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
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

/** Before/after text pairs for an edit tool call, straight from its args. */
export function getEditParts(toolName: string, args: Record<string, unknown>): EditPart[] {
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
  if (EDIT_TOOLS.has(toolName.toLowerCase())) {
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
  const o = oldStr.split("\n");
  const n = neu.split("\n");
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
 *  content) → git-status "A". A normal edit (non-empty `old`) is "M". */
export function isFileCreated(toolName: string, args: Record<string, unknown>): boolean {
  const parts = getEditParts(toolName, args);
  return parts.length > 0 && parts.every((p) => p.old === "");
}

/** Total added/removed line counts for an edit tool call. */
export function countEditLines(
  toolName: string,
  args: Record<string, unknown>,
): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const p of getEditParts(toolName, args)) {
    const c = countChangedLines(p.old, p.neu);
    added += c.added;
    removed += c.removed;
  }
  return { added, removed };
}
