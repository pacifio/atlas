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

export function deleteClonedRepo(projectPath: string, repoName: string) {
  return invoke("delete_cloned_repo", { projectPath, repoName });
}

/** Copy an image into the KB's covers folder; resolves the stored cover ref. */
export function uploadKnowledgeCover(projectPath: string, entryId: string, srcPath: string) {
  return invoke<string>("knowledge_cover_upload", { projectPath, entryId, srcPath });
}

export function exportKnowledgeNoteMd(projectPath: string, entryId: string, targetPath: string) {
  return invoke("knowledge_export_note_md", { projectPath, entryId, targetPath });
}

export function exportKnowledgeNoteHtml(projectPath: string, entryId: string, targetPath: string) {
  return invoke("knowledge_export_note_html", { projectPath, entryId, targetPath });
}

export function exportKnowledgeWorkspaceMd(projectPath: string, targetPath: string) {
  return invoke("knowledge_export_workspace_md", { projectPath, targetPath });
}

export function exportKnowledgeWorkspaceHtml(projectPath: string, targetDir: string) {
  return invoke("knowledge_export_workspace_html", { projectPath, targetDir });
}

export interface KnowledgeServerExport {
  binaryPath: string;
  noteCount: number;
}

export function exportKnowledgeServer(projectPath: string, targetPath: string) {
  return invoke<KnowledgeServerExport>("knowledge_export_server", { projectPath, targetPath });
}

/** Tolerant reveal — different plugin-opener versions disagree on the
 *  arg shape; the JS wrapper hits a "missing required key paths"
 *  validator error on some installs. Try both via direct invoke and
 *  swallow failure silently. */
export async function revealItemInDir(path: string): Promise<void> {
  try {
    await invoke("plugin:opener|reveal_item_in_dir", { paths: [path] });
  } catch {
    try {
      await invoke("plugin:opener|reveal_item_in_dir", { path });
    } catch {
      // Best-effort. Caller already has the path; reveal is a nicety.
    }
  }
}
