// IPC wrappers for the Knowledge panel. Command names and payload fields are
// the Rust contract (`tests/ipc-contract.test.ts`, `wire-shape-contract`) —
// keep them byte-identical.

import { invoke } from "@tauri-apps/api/core";

export interface KnowledgeClonedRepo {
  name: string;
  display_name: string;
  path: string;
  has_readme: boolean;
}

export function listClonedRepos(projectPath: string) {
  return invoke<KnowledgeClonedRepo[]>("list_cloned_repos", { projectPath });
}

export function importIntoKnowledge(projectPath: string, sources: string[]) {
  return invoke<{ notes_imported: number; files_copied: number }>("import_into_knowledge", {
    projectPath,
    sources,
  });
}

export function readRepoReadme(projectPath: string, repoName: string) {
  return invoke<string>("read_repo_readme", {
    projectPath,
    repoName,
  });
}

export function saveKnowledgeNote(projectPath: string, id: string, content: string) {
  return invoke("save_knowledge_note", {
    projectPath,
    id,
    content,
  });
}

export function knowledgeCoverDataUrl(projectPath: string, cover: string) {
  return invoke<string>("knowledge_cover_data_url", { projectPath, cover });
}
