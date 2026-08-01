import { useEffect, useMemo, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useKnowledgeStore } from "../stores/knowledge-store";
import { useKnowledgeMetaStore } from "../stores/knowledge-meta-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { KnowledgeTree, type KnowledgeTreeHandle } from "./knowledge-tree";
import {
  FoldVertical,
  UnfoldVertical,
  Download,
  FileText,
  Globe,
  Server,
  Loader2,
} from "lucide-react";

/**
 * Left-panel "Knowledge" section. Renders the same read-only tree the KB
 * editor's sidebar uses (folder structure, per-note emoji) instead of a
 * flat list, plus header actions (collapse/expand all, export menu) to
 * make the rail useful.
 */
export function KnowledgeList() {
  const entries = useKnowledgeStore.use.entries();
  const metaPages = useKnowledgeMetaStore.use.pages();
  const { loadEntries } = useKnowledgeStore.use.actions();
  const { addTab } = useLayoutStore.use.actions();
  const currentProject = useProjectStore.use.currentProject();

  const treeRef = useRef<KnowledgeTreeHandle>(null);
  const [expandedCount, setExpandedCount] = useState(0);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (currentProject) {
      loadEntries(currentProject.path);
    }
  }, [currentProject?.path, loadEntries]);

  // Compose title + emoji from `_meta.json` (same source the KB editor
  // sidebar uses), so the rail shows real titles and icons, not ids.
  const treeEntries = useMemo(
    () =>
      entries.map((e) => {
        const meta = metaPages[e.id];
        return {
          id: e.id,
          title: meta?.title?.trim() || e.title,
          icon: meta?.icon ?? null,
        };
      }),
    [entries, metaPages],
  );

  const titleById = useMemo(
    () => new Map(treeEntries.map((e) => [e.id, e.title] as const)),
    [treeEntries],
  );

  const handleOpen = (id: string) => {
    // Tell the KB panel which note to open. The knowledge tab dedupes by
    // type, so `addTab` only focuses the (single) KB tab — the actual
    // selection is driven through the store so it opens the RIGHT note,
    // whether the panel is already mounted or about to mount.
    useKnowledgeStore.getState().actions.requestOpen(id);
    addTab({
      id: `knowledge-${id}`,
      type: "knowledge",
      title: titleById.get(id) ?? id,
      closable: true,
      dirty: false,
      data: { entryId: id },
    });
  };

  // Workspace-level exports (the panel isn't note-scoped, so note-only
  // exports live in the KB editor footer). Mirrors editor-footer.tsx.
  const runExport = async (fn: () => Promise<void>) => {
    if (!currentProject || exporting) return;
    setExporting(true);
    try {
      await fn();
    } catch (e) {
      toast.error(`Export failed: ${String(e)}`);
    } finally {
      setExporting(false);
    }
  };

  const exportMarkdown = () =>
    runExport(async () => {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const target = (await save({
        defaultPath: "knowledge.md",
        title: "Export Knowledge",
        filters: [{ name: "Markdown", extensions: ["md"] }],
      })) as string | null;
      if (!target) return;
      await invoke("knowledge_export_workspace_md", {
        projectPath: currentProject!.path,
        targetPath: target,
      });
      toast.success("Exported to Markdown");
    });

  const exportHtmlSite = () =>
    runExport(async () => {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const target = (await save({
        defaultPath: "knowledge-site",
        title: "Export to folder",
      })) as string | null;
      if (!target) return;
      await invoke("knowledge_export_workspace_html", {
        projectPath: currentProject!.path,
        targetDir: target,
      });
      toast.success("Exported HTML site");
    });

  const exportServer = () =>
    runExport(async () => {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const target = (await save({
        defaultPath: "atlas-kb-server",
        title: "Export Knowledge Server (cargo build, ~1 minute)",
      })) as string | null;
      if (!target) return;
      const result = await invoke<{ binaryPath: string; noteCount: number }>(
        "knowledge_export_server",
        { projectPath: currentProject!.path, targetPath: target },
      );
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(result.binaryPath).catch(() => {});
      toast.success("Knowledge server built");
    });

  const EXPORT_ITEMS = [
    { label: "Markdown file", icon: FileText, run: exportMarkdown },
    { label: "HTML site", icon: Globe, run: exportHtmlSite },
    { label: "Standalone server", icon: Server, run: exportServer },
  ];

  const anyExpanded = expandedCount > 0;

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-3 h-[28px] shrink-0">
        <span className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider truncate flex-1">
          Knowledge
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() =>
              anyExpanded
                ? treeRef.current?.collapseAll()
                : treeRef.current?.expandAll()
            }
            className="p-1 rounded hover:bg-bg-hover text-text-tertiary hover:text-text-secondary transition-colors"
            title={anyExpanded ? "Collapse all" : "Expand all"}
          >
            {anyExpanded ? (
              <FoldVertical size={11} />
            ) : (
              <UnfoldVertical size={11} />
            )}
          </button>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                disabled={exporting || entries.length === 0}
                className={cn(
                  "p-1 rounded hover:bg-bg-hover text-text-tertiary hover:text-text-secondary transition-colors outline-none",
                  (exporting || entries.length === 0) &&
                    "opacity-40 pointer-events-none",
                )}
                title="Export knowledge"
              >
                {exporting ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <Download size={11} />
                )}
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={4}
                className="rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] shadow-[var(--shadow-overlay)] py-1 min-w-[160px]"
                style={{ zIndex: 9999 }}
              >
                <DropdownMenu.Label className="px-3 py-1 text-[9px] uppercase tracking-wider text-[var(--text-tertiary)]">
                  Export workspace
                </DropdownMenu.Label>
                {EXPORT_ITEMS.map(({ label, icon: Icon, run }) => (
                  <DropdownMenu.Item
                    key={label}
                    onSelect={() => void run()}
                    className="flex items-center gap-2 px-3 h-[28px] text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-default outline-none"
                  >
                    <Icon size={12} className="text-[var(--text-tertiary)]" />
                    {label}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </div>

      <KnowledgeTree
        ref={treeRef}
        entries={treeEntries}
        // The left-panel list is navigation-only — don't render a
        // (stale) selected-row highlight; selection lives in the KB tab.
        activeEntryId={null}
        onSelect={handleOpen}
        onExpandedCountChange={setExpandedCount}
      />
    </div>
  );
}
