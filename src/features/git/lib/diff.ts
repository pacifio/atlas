// Unified-diff parser shared by the changes panel, the source-control
// manager, and the history commit view. Extracted from changes-panel.tsx.

export interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  language: string;
  /** Git printed "Binary files … differ" — there are no lines to show. */
  binary?: boolean;
  /** The path before a rename (`rename from`), when the file was renamed. */
  oldPath?: string;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface DiffLine {
  type: "add" | "remove" | "context";
  content: string;
  oldLine?: number;
  newLine?: number;
}

export function getLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "TypeScript",
    tsx: "TypeScript",
    js: "JavaScript",
    jsx: "JavaScript",
    py: "Python",
    rs: "Rust",
    go: "Go",
    rb: "Ruby",
    java: "Java",
    c: "C",
    h: "C",
    cpp: "C++",
    hpp: "C++",
    swift: "Swift",
    kt: "Kotlin",
    css: "CSS",
    scss: "CSS",
    html: "HTML",
    json: "JSON",
    toml: "TOML",
    yaml: "YAML",
    yml: "YAML",
    md: "Markdown",
    mdx: "Markdown",
    sh: "Shell",
    sql: "SQL",
    xml: "XML",
    svg: "XML",
  };
  return map[ext] ?? ext.toUpperCase();
}

export function parseDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  if (!raw.trim()) return files;
  const fileSections = raw.split(/^diff --git /m).filter(Boolean);

  for (const section of fileSections) {
    const lines = section.split("\n");
    const headerMatch = lines[0]?.match(/a\/(.+?) b\/(.+)/);
    const path = headerMatch?.[2] ?? headerMatch?.[1] ?? "unknown";
    let additions = 0,
      deletions = 0;
    const hunks: DiffHunk[] = [];
    let currentHunk: DiffHunk | null = null;
    let oldLine = 0,
      newLine = 0;
    let binary = false;
    let oldPath: string | undefined;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunkMatch) {
        oldLine = parseInt(hunkMatch[1], 10);
        newLine = parseInt(hunkMatch[2], 10);
        currentHunk = { header: line, oldStart: oldLine, newStart: newLine, lines: [] };
        hunks.push(currentHunk);
        continue;
      }
      if (!currentHunk) {
        // Extended header lines, before the first hunk.
        if (line.startsWith("Binary files ")) binary = true;
        else if (line.startsWith("rename from ")) oldPath = line.slice("rename from ".length);
        continue;
      }
      if (line.startsWith("+")) {
        currentHunk.lines.push({ type: "add", content: line.slice(1), newLine: newLine++ });
        additions++;
      } else if (line.startsWith("-")) {
        currentHunk.lines.push({ type: "remove", content: line.slice(1), oldLine: oldLine++ });
        deletions++;
      } else if (line.startsWith(" ")) {
        currentHunk.lines.push({
          type: "context",
          content: line.slice(1),
          oldLine: oldLine++,
          newLine: newLine++,
        });
      }
    }
    files.push({
      path,
      additions,
      deletions,
      hunks,
      language: getLanguage(path),
      ...(binary && { binary }),
      ...(oldPath && { oldPath }),
    });
  }
  return files;
}

export type VirtualRow =
  | { kind: "file-header"; file: DiffFile; fileIndex: number }
  | { kind: "hunk-header"; file: DiffFile; hunk: DiffHunk; fileIndex: number; hunkIndex: number }
  | {
      kind: "diff-line";
      line: DiffLine;
      fileIndex: number;
      hunkIndex: number;
      /** Index within the hunk's line list — the selection unit for
       *  line-level staging (matches the Rust side's visible index). */
      lineIndex: number;
    }
  | { kind: "file-footer"; fileIndex: number };

export function buildRows(files: DiffFile[], collapsedFiles: Set<string>): VirtualRow[] {
  const rows: VirtualRow[] = [];
  for (let fi = 0; fi < files.length; fi++) {
    const file = files[fi];
    rows.push({ kind: "file-header", file, fileIndex: fi });
    if (collapsedFiles.has(file.path)) continue;
    for (let hi = 0; hi < file.hunks.length; hi++) {
      const hunk = file.hunks[hi];
      rows.push({ kind: "hunk-header", file, hunk, fileIndex: fi, hunkIndex: hi });
      for (let li = 0; li < hunk.lines.length; li++) {
        rows.push({
          kind: "diff-line",
          line: hunk.lines[li],
          fileIndex: fi,
          hunkIndex: hi,
          lineIndex: li,
        });
      }
    }
    rows.push({ kind: "file-footer", fileIndex: fi });
  }
  return rows;
}

/** One side-by-side line pair; a missing side is filler. */
export interface SplitLine {
  left?: DiffLine;
  right?: DiffLine;
}

/**
 * Pair a hunk's lines for a side-by-side view. Context sits on both sides; a
 * run of removals followed by a run of additions is laid out row by row, so a
 * modified line reads across from what replaced it.
 */
export function splitHunkLines(hunk: DiffHunk): SplitLine[] {
  const out: SplitLine[] = [];
  const lines = hunk.lines;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type === "context") {
      out.push({ left: lines[i], right: lines[i] });
      i++;
      continue;
    }
    const removed: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (i < lines.length && lines[i].type === "remove") removed.push(lines[i++]);
    while (i < lines.length && lines[i].type === "add") added.push(lines[i++]);
    for (let k = 0; k < Math.max(removed.length, added.length); k++) {
      out.push({ left: removed[k], right: added[k] });
    }
  }
  return out;
}

/** Wire shape for hunk/line staging: the hunk exactly as displayed. */
export function hunkWireLines(hunk: DiffHunk): { kind: "context" | "add" | "del"; text: string }[] {
  return hunk.lines.map((l) => ({
    kind: l.type === "add" ? "add" : l.type === "remove" ? "del" : "context",
    text: l.content,
  }));
}
