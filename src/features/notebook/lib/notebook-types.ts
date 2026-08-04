// nbformat v4 types — only the fields the viewer reads. Full spec:
// https://nbformat.readthedocs.io/en/latest/format_description.html

export interface NotebookOutput {
  output_type: "stream" | "execute_result" | "display_data" | "error";
  // stream
  name?: "stdout" | "stderr";
  text?: string | string[];
  // execute_result / display_data
  data?: Record<string, string | string[]>;
  execution_count?: number | null;
  // error
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

export interface NotebookCell {
  cell_type: "code" | "markdown" | "raw";
  source: string | string[];
  outputs?: NotebookOutput[];
  execution_count?: number | null;
}

export interface NotebookFile {
  cells: NotebookCell[];
  metadata?: {
    kernelspec?: { language?: string; name?: string };
    language_info?: { name?: string };
  };
  nbformat?: number;
  nbformat_minor?: number;
}

/** nbformat allows `source`/`text`/`traceback` as either a single string or an
 *  array of lines (no trailing newlines between entries) — normalize both. */
export function joinSource(src: string | string[] | undefined): string {
  if (src === undefined) return "";
  return Array.isArray(src) ? src.join("") : src;
}

/** Best-effort language id for syntax highlighting, mapped to a highlight.js
 *  grammar name. Falls back to "python" (the overwhelmingly common case) so
 *  code cells still get *some* highlighting rather than none. */
export function notebookLanguage(nb: NotebookFile): string {
  const raw =
    nb.metadata?.language_info?.name ??
    nb.metadata?.kernelspec?.language ??
    "python";
  const lower = raw.toLowerCase();
  if (lower.startsWith("python")) return "python";
  return lower;
}

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;

/** Strip ANSI color codes Jupyter kernels embed in tracebacks — Atlas has no
 *  terminal-style ANSI renderer in this view, so keep the text plain. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_ESCAPE_RE, "");
}
