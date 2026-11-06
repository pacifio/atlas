import { useCallback } from "react";
import { toast } from "sonner";
import { importIntoKnowledge } from "./knowledge-api";

/** The sidebar's two import actions. `.md` sources become KB notes;
 *  `openInFileView` takes any non-.md file picked directly. */
export function useKnowledgeImports(
  currentProject: { path: string } | null,
  loadEntries: (projectPath: string) => unknown,
  openInFileView: (filePath: string) => void,
) {
  // Import external .md files (Obsidian-style). .md → KB notes; any non-.md
  // files picked directly open in the file view instead.
  const handleImportFiles = useCallback(async () => {
    if (!currentProject) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const sel = await open({ multiple: true });
    const paths = Array.isArray(sel) ? sel : sel ? [sel] : [];
    if (!paths.length) return;
    const md = paths.filter((p) => /\.(md|markdown)$/i.test(p));
    const other = paths.filter((p) => !/\.(md|markdown)$/i.test(p));
    if (md.length) {
      try {
        const res = await importIntoKnowledge(currentProject.path, md);
        await loadEntries(currentProject.path);
        toast.success(`Imported ${res.notes_imported} note${res.notes_imported === 1 ? "" : "s"}`);
      } catch (e) {
        toast.error(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    other.forEach(openInFileView);
  }, [currentProject, loadEntries, openInFileView]);

  // Import a whole folder (e.g. an Obsidian vault): .md become notes, other
  // files (images, code, attachments) are copied in so the vault stays intact.
  const handleImportFolder = useCallback(async () => {
    if (!currentProject) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dir = await open({ directory: true });
    if (!dir || Array.isArray(dir)) return;
    try {
      const res = await importIntoKnowledge(currentProject.path, [dir]);
      await loadEntries(currentProject.path);
      toast.success(
        `Imported ${res.notes_imported} note${res.notes_imported === 1 ? "" : "s"}` +
          (res.files_copied
            ? ` + ${res.files_copied} file${res.files_copied === 1 ? "" : "s"}`
            : ""),
      );
    } catch (e) {
      toast.error(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [currentProject, loadEntries]);

  return { handleImportFiles, handleImportFolder };
}
