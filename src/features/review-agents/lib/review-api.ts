import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** One flagged issue. Fields are snake_case: produced verbatim by the model
 *  (PR-Agent schema) and passed straight through Rust. */
export interface KeyIssue {
  relevant_file: string;
  issue_header: string;
  issue_content: string;
  start_line?: number | null;
  end_line?: number | null;
}

/** Per-file review verdict (snake_case). */
export interface FileVerdict {
  path: string;
  summary: string;
  /** "low" | "medium" | "high" */
  risk: string;
  key_issues: KeyIssue[];
  score?: number | null;
}

/** The full multi-file review report (snake_case). */
export interface ReviewReport {
  summary: string;
  /** Mermaid flowchart source for the architecture diagram (may be empty). */
  architecture_mermaid: string;
  score?: number | null;
  estimated_effort_to_review?: number | null;
  security_concerns: string;
  relevant_tests: string;
  files: FileVerdict[];
  not_reviewed: string[];
  input_tokens: number;
  output_tokens: number;
  cost_usd?: number | null;
}

/** A completed, persisted review (camelCase outer — Rust `ReviewRecord`). */
export interface ReviewRecord {
  id: string;
  title: string;
  provider: string;
  model: string;
  createdAt: string;
  report: ReviewReport;
}

/** Which diff to review. Mirrors the Rust `ReviewSource` (tag = "type"). */
export type ReviewSource =
  | { type: "working" }
  | { type: "staged" }
  | { type: "commit"; sha: string }
  | { type: "range"; from: string; to: string }
  | { type: "branch"; base?: string | null };

/** Streamed review events from Rust, tagged by review `id`. */
export type ReviewEvent =
  | { id: string; kind: "file_started"; path: string }
  | { id: string; kind: "file_done"; verdict: FileVerdict }
  | { id: string; kind: "file_error"; message: string }
  | { id: string; kind: "delta"; delta: string }
  | { id: string; kind: "complete"; record: ReviewRecord }
  | { id: string; kind: "error"; message: string };

export interface BaseBranches {
  branches: string[];
  default: string | null;
}

export const review = {
  /** BYOK providers that have a key AND the reviewer can drive. */
  providers: () => invoke<string[]>("review_providers"),
  /** Candidate base branches + detected default for Branch mode. */
  baseBranches: (project: string) => invoke<BaseBranches>("review_base_branches", { project }),
  start: (id: string, project: string, provider: string, model: string, source: ReviewSource) =>
    invoke<void>("review_start", { id, project, provider, model, source }),
  cancel: (id: string) => invoke<void>("review_cancel", { id }),
  list: (project: string) => invoke<ReviewRecord[]>("review_list", { project }),
  get: (project: string, id: string) => invoke<ReviewRecord | null>("review_get", { project, id }),
  /** Model ids for a provider — reuses the Model-Chat listing command. */
  models: (provider: string) => invoke<{ id: string }[]>("modelchat_models", { provider }),
};

export const listenReview = (handler: (e: ReviewEvent) => void): Promise<UnlistenFn> =>
  listen<ReviewEvent>("atlas:review", (e) => handler(e.payload));

/** Serialize a single file's verdict to markdown for sharing with the agent. */
export function fileToMarkdown(file: FileVerdict): string {
  const lines: string[] = [];
  lines.push(`Please review and address the following in \`${file.path}\` (risk: ${file.risk}):`);
  lines.push("");
  if (file.summary) lines.push(file.summary, "");
  for (const i of file.key_issues) {
    const at = typeof i.start_line === "number" ? `:${i.start_line}` : "";
    lines.push(`- **${i.issue_header}** (\`${i.relevant_file}${at}\`) — ${i.issue_content}`);
  }
  return lines.join("\n");
}

/** Serialize a report to markdown for sharing with the coding agent. */
export function reportToMarkdown(record: ReviewRecord): string {
  const r = record.report;
  const lines: string[] = [];
  lines.push(`# Code review — ${record.title}`);
  lines.push("");
  if (r.summary) lines.push(r.summary, "");
  const meta: string[] = [];
  if (typeof r.score === "number") meta.push(`**Score:** ${r.score}/100`);
  if (typeof r.estimated_effort_to_review === "number")
    meta.push(`**Effort:** ${r.estimated_effort_to_review}/5`);
  meta.push(`**Tests:** ${r.relevant_tests}`);
  if (meta.length) lines.push(meta.join(" · "), "");
  if (r.security_concerns && r.security_concerns.trim().toLowerCase() !== "no") {
    lines.push(`**Security:** ${r.security_concerns}`, "");
  }
  if (r.architecture_mermaid.trim()) {
    lines.push("## Architecture", "", "```mermaid", r.architecture_mermaid.trim(), "```", "");
  }
  if (r.files.length) {
    lines.push("## Files", "");
    for (const f of r.files) {
      lines.push(`### \`${f.path}\` — risk: ${f.risk}`);
      if (f.summary) lines.push(f.summary);
      for (const i of f.key_issues) {
        const at = typeof i.start_line === "number" ? `:${i.start_line}` : "";
        lines.push(`- **${i.issue_header}** (\`${i.relevant_file}${at}\`) — ${i.issue_content}`);
      }
      lines.push("");
    }
  }
  if (r.not_reviewed.length) {
    lines.push(
      `_Not individually reviewed (${r.not_reviewed.length}): ${r.not_reviewed.join(", ")}_`,
    );
  }
  return lines.join("\n");
}
