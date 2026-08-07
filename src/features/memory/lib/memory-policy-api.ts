import { invoke } from "@tauri-apps/api/core";

export interface Policy {
  id: string;
  key: string;
  hint: string;
  value: string;
  /** "strong" (hard rule — MUST/NEVER/ALWAYS) | "soft" (preference/guidance). */
  category: "soft" | "strong";
  /** "preference" (curated probe) | "codebase" (a feedback/behavior memory). */
  origin: "preference" | "codebase";
  /** "semantic" (cosine-matched probe) | "keyword" (direct memory listing). */
  match_kind: "semantic" | "keyword";
  source: string; // "claude" | "codex"
  file_path: string;
  doc_title: string;
  score: number;
}

export const memoryPolicy = {
  list: (projectPath: string) => invoke<Policy[]>("memory_policies", { projectPath }),
  update: (filePath: string, oldText: string, newText: string) =>
    invoke<void>("memory_policy_update", { filePath, oldText, newText }),
};
