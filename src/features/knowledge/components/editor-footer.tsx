import { useState } from "react";
import { toast } from "sonner";
import {
  exportKnowledgeNoteHtml,
  exportKnowledgeNoteMd,
  exportKnowledgeServer,
  exportKnowledgeWorkspaceHtml,
  exportKnowledgeWorkspaceMd,
  revealItemInDir,
} from "../lib/knowledge-api";
import { EditorFooterView, type ExportKey } from "./views/editor-footer-view";

interface EditorFooterProps {
  wordCount: number;
  charCount: number;
  projectPath: string;
  entryId: string | null;
}

/** The note footer's export runs; everything it draws is `EditorFooterView`. */
export function EditorFooter({ wordCount, charCount, projectPath, entryId }: EditorFooterProps) {
  // Which export is in-flight, if any. The view renders a spinner and
  // disables the trigger while an export runs.
  const [busy, setBusy] = useState<ExportKey | null>(null);

  const run = async (key: ExportKey, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      console.error(`[export:${key}] failed`, err);
      toast.error(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const pickSavePath = async (defaultName: string, ext: string): Promise<string | null> => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const chosen = await save({
      defaultPath: defaultName,
      title: "Export",
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    return (chosen as string | null) ?? null;
  };

  const pickDirectory = async (defaultName: string): Promise<string | null> => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const chosen = await save({
      defaultPath: defaultName,
      title: "Export to folder",
    });
    return (chosen as string | null) ?? null;
  };

  const exports: Record<ExportKey, () => Promise<void>> = {
    "note-md": async () => {
      if (!entryId) return;
      const target = await pickSavePath(`${entryId.split("/").pop()}.md`, "md");
      if (!target) return;
      await exportKnowledgeNoteMd(projectPath, entryId, target);
    },
    "note-html": async () => {
      if (!entryId) return;
      const target = await pickSavePath(`${entryId.split("/").pop()}.html`, "html");
      if (!target) return;
      await exportKnowledgeNoteHtml(projectPath, entryId, target);
    },
    "project-md": async () => {
      const target = await pickSavePath("knowledge.md", "md");
      if (!target) return;
      await exportKnowledgeWorkspaceMd(projectPath, target);
    },
    "project-html": async () => {
      const target = await pickDirectory("knowledge-site");
      if (!target) return;
      await exportKnowledgeWorkspaceHtml(projectPath, target);
    },
    server: async () => {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const target = (await save({
        defaultPath: "atlas-kb-server",
        title: "Export Knowledge Server (cargo build, ~1 minute)",
      })) as string | null;
      if (!target) return;
      const result = await exportKnowledgeServer(projectPath, target);
      await revealItemInDir(result.binaryPath);
    },
  };

  return (
    <EditorFooterView
      wordCount={wordCount}
      charCount={charCount}
      hasNote={!!entryId}
      busy={busy}
      onExport={(key) => void run(key, exports[key])}
    />
  );
}
