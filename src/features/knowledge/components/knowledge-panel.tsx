import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useKnowledgeStore } from "../stores/knowledge-store";
import {
  useKnowledgeMetaStore,
  usePageMeta,
} from "../stores/knowledge-meta-store";
import {
  useKnowledgeLinksStore,
  useBacklinks,
  useReferencesLabel,
} from "../stores/knowledge-links-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useWorkspaceStore } from "@/features/workspaces/stores/workspace-store";
import { registerFlush } from "@/features/workspaces/lib/flush-registry";
import {
  TiptapEditor,
  type TiptapEditorHandle,
} from "@/features/editor-notion/components/tiptap-editor";
import { ReadmeView } from "./readme-view";
import { clearDocCache } from "@/features/editor-notion/lib/blocks-cache";
import {
  useEditorOutline,
  useActiveHeading,
  jumpToHeading,
} from "@/features/editor-notion/lib/outline";
import type { Editor } from "@tiptap/core";
import { KnowledgeSidebar } from "./knowledge-sidebar";
import { KnowledgeFinder } from "./knowledge-finder";
import { EditorTopbar } from "./editor-topbar";
import { EditorFooter } from "./editor-footer";
import { KnowledgeInspector } from "./knowledge-inspector";
import { PageProperties } from "./page-properties";
import { IconPicker } from "./icon-picker";
import { CoverPicker, gradientCss } from "./cover-picker";
import {
  Copy,
  ExternalLink,
  GitBranch,
  PanelLeft,
  PanelRight,
} from "lucide-react";

const RECENTS_MAX = 5;

export function KnowledgePanel() {
  const entries = useKnowledgeStore.use.entries();
  const activeEntryId = useKnowledgeStore.use.activeEntryId();
  const editContent = useKnowledgeStore.use.editContent();
  const pendingOpenId = useKnowledgeStore.use.pendingOpenId();
  const {
    loadEntries,
    selectEntry,
    consumePendingOpen,
    setEditContent,
    saveEntry,
    createEntry,
    deleteEntry,
    createDir,
  } = useKnowledgeStore.use.actions();
  const currentProject = useProjectStore.use.currentProject();

  const editorRef = useRef<TiptapEditorHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [finderOpen, setFinderOpen] = useState(false);
  const [activeRepoName, setActiveRepoName] = useState<string | null>(null);
  const [repoReadme, setRepoReadme] = useState<string | null>(null);
  const [clonedRepos, setClonedRepos] = useState<
    Array<{
      name: string;
      display_name: string;
      path: string;
      has_readme: boolean;
    }>
  >([]);
  // KB panel layout is hoisted into layout-store so tab switches don't
  // reset sidebar/inspector visibility or column widths — same model the
  // global left/right panels use. All KB tabs share one layout (matches
  // how a user thinks about "did I hide the sidebar?").
  const showSidebar = useLayoutStore((s) => s.knowledgePanel.showSidebar);
  const showInspector = useLayoutStore((s) => s.knowledgePanel.showInspector);
  const sidebarWidth = useLayoutStore((s) => s.knowledgePanel.sidebarWidth);
  const inspectorWidth = useLayoutStore((s) => s.knowledgePanel.inspectorWidth);
  const {
    toggleKnowledgeSidebar,
    toggleKnowledgeInspector,
    setKnowledgeSidebarWidth,
    setKnowledgeInspectorWidth,
  } = useLayoutStore.use.actions();

  // Drag-resize helpers. Each handle is a 4px-wide invisible strip on
  // the panel border; mousedown captures pointer + listens for global
  // mousemove until release. `from` is the side being resized.
  const startResize = useCallback(
    (e: React.MouseEvent, from: "sidebar" | "inspector") => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = from === "sidebar" ? sidebarWidth : inspectorWidth;
      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        if (from === "sidebar") {
          setKnowledgeSidebarWidth(startW + dx);
        } else {
          // Inspector grows when dragged LEFT, so flip the delta.
          setKnowledgeInspectorWidth(startW - dx);
        }
      };
      const onUp = () => {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [
      sidebarWidth,
      inspectorWidth,
      setKnowledgeSidebarWidth,
      setKnowledgeInspectorWidth,
    ],
  );
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [editorInstance, setEditorInstance] = useState<Editor | null>(null);
  const [wordCount, setWordCount] = useState(0);
  const [charCount, setCharCount] = useState(0);
  const [newFolderName, setNewFolderName] = useState("");
  const [showFolderInput, setShowFolderInput] = useState(false);

  // Outline + scroll-spy live off the actual editor instance once it
  // mounts. Replaces the previous markdown-regex walker — much better
  // for documents with rich structure (collapsed toggles, nested
  // headings inside callouts, etc.).
  const outline = useEditorOutline(editorInstance);
  const activeHeadingId = useActiveHeading(editorInstance, outline);

  // Project change: drop the parsed-doc cache. Stale docs from another
  // project would otherwise survive a switch (keys are entry ids alone,
  // which can collide across projects).
  useEffect(() => {
    clearDocCache();
  }, [currentProject?.path]);

  const {
    bind: bindMeta,
    unbind: unbindMeta,
    drop: dropMeta,
  } = useKnowledgeMetaStore.use.actions();
  const {
    bind: bindLinks,
    unbind: unbindLinks,
    invalidate: invalidateLinks,
  } = useKnowledgeLinksStore.use.actions();
  const referencesLabel = useReferencesLabel(activeEntryId);
  const backlinksFooter = useBacklinks(activeEntryId);

  useEffect(() => {
    if (currentProject) {
      loadEntries(currentProject.path);
      void bindMeta(currentProject.path);
      void bindLinks(currentProject.path);
      invoke<
        Array<{
          name: string;
          display_name: string;
          path: string;
          has_readme: boolean;
        }>
      >("list_cloned_repos", { projectPath: currentProject.path })
        .then(setClonedRepos)
        .catch(() => {});
    } else {
      unbindMeta();
      unbindLinks();
    }
  }, [
    currentProject?.path,
    loadEntries,
    bindMeta,
    unbindMeta,
    bindLinks,
    unbindLinks,
  ]);

  useEffect(() => {
    setIsDirty(false);
  }, [activeEntryId]);

  // Push every selected entry id onto the recents stack (MRU, capped).
  useEffect(() => {
    if (!activeEntryId) return;
    setRecentIds((prev) => {
      const next = [
        activeEntryId,
        ...prev.filter((id) => id !== activeEntryId),
      ];
      return next.slice(0, RECENTS_MAX);
    });
  }, [activeEntryId]);

  const flushAndSave = useCallback(async () => {
    if (!currentProject || !editorRef.current) return;
    // Capture the (workspace path, note id) this content belongs to BEFORE the
    // async flush. The KB panel is resident across workspace switches, so a
    // switch (or note change) can land mid-flush; binding the triple here and
    // re-checking it after lets us abort rather than write one workspace's
    // content into another's file (the cross-workspace data-loss bug).
    const proj = currentProject.path;
    const id = useKnowledgeStore.getState().activeEntryId;
    if (!id) return;
    // Gate on the EDITOR's own dirty ref — the single race-free source of truth
    // for "has the body changed since it was loaded / last saved?". We must NOT
    // gate on the store's `editContent`: `selectEntry`/`loadEntries` overwrite
    // that with disk content, so comparing against it skipped real saves (the
    // "content reverts / new note stays Untitled" data-loss bug).
    if (!editorRef.current.isDirty()) return;
    const md = await editorRef.current.flush();
    if (md === null) return;
    // Workspace switched or the active note changed while flushing → abort.
    const live = useProjectStore.getState().currentProject;
    if (!live || live.path !== proj) return;
    if (useKnowledgeStore.getState().activeEntryId !== id) return;
    setEditContent(md);
    await saveEntry(proj, id, md);
    setIsDirty(false);
    // Note bodies may have gained/lost [[wikilinks]] or @page: refs —
    // invalidate Rust's link graph so the inspector + footer reflect
    // the new state.
    void invalidateLinks();
  }, [currentProject, setEditContent, saveEntry, invalidateLinks]);

  // Coordinate with workspace switching: the switch awaits `flushAll()` BEFORE
  // it snapshots/swaps the active workspace, so register a flush that writes the
  // editor's current buffer to the OUTGOING workspace (`ctx.path`) — not the
  // resident React `currentProject`, which may already have flipped. This is
  // what guarantees a note saved in workspace A is persisted to A's file before
  // we leave it, closing the window where a stale save could clobber it.
  useEffect(() => {
    return registerFlush("knowledge", async (ctx) => {
      if (!ctx.path || !editorRef.current) return;
      const id = useKnowledgeStore.getState().activeEntryId;
      if (!id || !editorRef.current.isDirty()) return;
      const md = await editorRef.current.flush();
      if (md === null) return;
      await saveEntry(ctx.path, id, md);
    });
  }, [saveEntry]);

  // Flush on window blur (switching apps) and on unmount (tab close / switch
  // away from the KB tab) so unsaved edits are never stranded. These are
  // boundary flushes, not a timer — autosave was removed (it caused stale,
  // racey writes); saves happen on Cmd+S, note switch, blur, unmount, and
  // workspace switch, each gated on the editor's live dirty ref.
  useEffect(() => {
    const onBlur = () => void flushAndSave();
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("blur", onBlur);
      void flushAndSave();
    };
  }, [flushAndSave]);

  // Cmd+; / Cmd+' — toggle KB sidebar / inspector. Picked over the old
  // Cmd+{ / Cmd+} bindings because those conflicted with the global
  // Cmd+Shift+[ / Cmd+Shift+] tab-cycle shortcut.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.shiftKey || e.altKey) return;
      if (e.key === ";") {
        e.preventDefault();
        toggleKnowledgeSidebar();
      } else if (e.key === "'") {
        e.preventDefault();
        toggleKnowledgeInspector();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleKnowledgeSidebar, toggleKnowledgeInspector]);

  // Cmd+F — open the KB finder, but only when focus is inside this KB panel
  // (so it doesn't hijack the shortcut for other tabs / the app).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key === "f"
      ) {
        if (!rootRef.current?.contains(document.activeElement)) return;
        e.preventDefault();
        setFinderOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Cmd+S
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        // Force-blur the active element first. The page-header title
        // input commits its draft to `_meta.json` on blur — without
        // this, Cmd+S while typing in the title saves the body but
        // leaves the title patch pending until the next outside click,
        // making the sidebar tree appear to lag behind the save.
        const ae = document.activeElement;
        if (ae instanceof HTMLElement && ae !== document.body) {
          ae.blur();
        }
        // Always flush — never gate on the stale `isDirty` flag (the content
        // check inside flushAndSave decides whether a write is needed).
        if (currentProject) {
          void flushAndSave();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [currentProject, flushAndSave]);

  // Open a non-note file (image, code) in the CodeMirror editor rather than the
  // KB note editor.
  const openInCodeMirror = useCallback((filePath: string) => {
    useLayoutStore.getState().actions.addTab({
      id: `editor-${filePath}`,
      type: "editor",
      title: filePath.split("/").pop() ?? "file",
      closable: true,
      dirty: false,
      data: { filePath },
    });
  }, []);

  // Import external .md files (Obsidian-style). .md → KB notes; any non-.md
  // files picked directly open in the CodeMirror editor instead.
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
        const res = await invoke<{
          notes_imported: number;
          files_copied: number;
        }>("import_into_knowledge", {
          projectPath: currentProject.path,
          sources: md,
        });
        await loadEntries(currentProject.path);
        toast.success(
          `Imported ${res.notes_imported} note${res.notes_imported === 1 ? "" : "s"}`,
        );
      } catch (e) {
        toast.error(
          `Import failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    other.forEach(openInCodeMirror);
  }, [currentProject, loadEntries, openInCodeMirror]);

  // Import a whole folder (e.g. an Obsidian vault): .md become notes, other
  // files (images, code, attachments) are copied in so the vault stays intact.
  const handleImportFolder = useCallback(async () => {
    if (!currentProject) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dir = await open({ directory: true });
    if (!dir || Array.isArray(dir)) return;
    try {
      const res = await invoke<{
        notes_imported: number;
        files_copied: number;
      }>("import_into_knowledge", {
        projectPath: currentProject.path,
        sources: [dir],
      });
      await loadEntries(currentProject.path);
      toast.success(
        `Imported ${res.notes_imported} note${res.notes_imported === 1 ? "" : "s"}` +
          (res.files_copied
            ? ` + ${res.files_copied} file${res.files_copied === 1 ? "" : "s"}`
            : ""),
      );
    } catch (e) {
      toast.error(
        `Import failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }, [currentProject, loadEntries]);

  const handleSelectEntry = useCallback(
    async (id: string) => {
      // Always flush the outgoing note before swapping — unconditionally, not
      // gated on `isDirty` (which could be a stale `false` and drop the draft).
      // flushAndSave's content check makes the no-change case a cheap no-op.
      if (activeEntryId && id !== activeEntryId) {
        await flushAndSave();
      }
      selectEntry(id);
      setActiveRepoName(null);
      setRepoReadme(null);
    },
    [activeEntryId, flushAndSave, selectEntry],
  );

  // Honor "open this note" requests from outside the panel (the left-panel
  // quick list). Routed through `handleSelectEntry` so the current note's
  // unsaved edits are flushed first. Works on first mount too, since the
  // request is parked in the store until consumed here.
  useEffect(() => {
    if (!pendingOpenId) return;
    void handleSelectEntry(pendingOpenId);
    consumePendingOpen();
  }, [pendingOpenId, handleSelectEntry, consumePendingOpen]);

  const handleDeleteEntry = useCallback(
    (id: string) => {
      if (!currentProject) return;
      editorRef.current?.evict(id);
      void dropMeta(id);
      deleteEntry(currentProject.path, id);
      void invalidateLinks();
    },
    [currentProject, deleteEntry, dropMeta, invalidateLinks],
  );

  const handleSelectRepo = useCallback(
    async (name: string) => {
      if (!currentProject) return;
      setActiveRepoName(name);
      selectEntry("");
      try {
        const readme = await invoke<string>("read_repo_readme", {
          projectPath: currentProject.path,
          repoName: name,
        });
        setRepoReadme(readme);
      } catch {
        setRepoReadme(null);
      }
    },
    [currentProject, selectEntry],
  );

  const handleCreateFolder = useCallback(async () => {
    if (!newFolderName.trim() || !currentProject) return;
    const name = newFolderName.trim();
    await createDir(currentProject.path, name);
    await invoke("save_knowledge_note", {
      projectPath: currentProject.path,
      id: `${name}/note-${Date.now()}`,
      content: `# ${name}\n\n`,
    });
    await loadEntries(currentProject.path);
    setNewFolderName("");
    setShowFolderInput(false);
  }, [newFolderName, currentProject, createDir, loadEntries]);

  // Title is now owned by page metadata (set via the input next to
  // the icon), not derived from the body. Falls back to the filename
  // stem so legacy notes without metadata still display a sensible
  // label. Breadcrumbs are just folder segments of the entry id.
  const activeEntry = entries.find((e) => e.id === activeEntryId);
  const activeMeta = usePageMeta(activeEntryId ?? null);
  const breadcrumbs = useMemo<string[]>(() => {
    if (!activeEntry) return [];
    const parts = activeEntry.id.split("/");
    return parts.length > 1 ? parts.slice(0, -1) : [];
  }, [activeEntry]);

  const pageTitle = useMemo(() => {
    if (activeMeta.title && activeMeta.title.trim()) return activeMeta.title;
    if (!activeEntry) return "";
    const parts = activeEntry.id.split("/");
    return parts[parts.length - 1] ?? activeEntry.id;
  }, [activeEntry, activeMeta.title]);

  // Word/char counts come straight from the live editor JSON so they
  // stay in sync with every keystroke without round-tripping markdown.
  useEffect(() => {
    if (!editorInstance) {
      setWordCount(0);
      setCharCount(0);
      return;
    }
    const update = () => {
      const text = editorInstance.state.doc.textBetween(
        0,
        editorInstance.state.doc.content.size,
        " ",
        " ",
      );
      const trimmed = text.trim();
      setWordCount(trimmed ? trimmed.split(/\s+/).length : 0);
      setCharCount(text.length);
    };
    update();
    editorInstance.on("update", update);
    return () => {
      editorInstance.off("update", update);
    };
  }, [editorInstance]);

  const pageStats = useMemo<Array<[string, string | number]>>(() => {
    return [
      ["Words", wordCount.toLocaleString("en-US")],
      ["Characters", charCount.toLocaleString("en-US")],
      ["Headings", outline.length],
      ["Backlinks", "—"],
      ["Forward links", "—"],
    ];
  }, [wordCount, charCount, outline.length]);

  if (!currentProject) {
    return (
      <div className="h-full flex items-center justify-center text-text-tertiary text-sm">
        Open a project first
      </div>
    );
  }

  // Sidebar uses meta.title when set so the tree reflects the user's
  // explicit title input. Falls back to the Rust-derived title (which
  // is either the first `#` line or filename) for legacy entries.
  const metaPages = useKnowledgeMetaStore.use.pages();
  const sidebarEntries = useMemo(
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

  return (
    <div
      ref={rootRef}
      className="relative h-full flex"
      style={{ background: "var(--bg-canvas)" }}
    >
      {finderOpen && (
        <KnowledgeFinder
          entries={sidebarEntries}
          onSelect={(id) => void handleSelectEntry(id)}
          onClose={() => setFinderOpen(false)}
        />
      )}
      {showSidebar && (
        <>
          <KnowledgeSidebar
            projectPath={currentProject.path}
            entries={sidebarEntries}
            activeEntryId={activeEntryId}
            activeRepoName={activeRepoName}
            recentIds={recentIds}
            onClearRecents={() => setRecentIds([])}
            onSelectEntry={handleSelectEntry}
            onDeleteEntry={handleDeleteEntry}
            onNewFolder={() => setShowFolderInput((v) => !v)}
            onNewNote={() => createEntry(currentProject.path)}
            onImportFiles={handleImportFiles}
            onImportFolder={handleImportFolder}
            onOpenGraph={() =>
              useLayoutStore.getState().actions.addTab({
                id: "knowledge-graph",
                type: "knowledge-graph",
                title: "Graph",
                closable: true,
                dirty: false,
                data: {},
              })
            }
            onSelectRepo={handleSelectRepo}
            folderInputOpen={showFolderInput}
            folderInputValue={newFolderName}
            onFolderInputChange={setNewFolderName}
            onFolderInputCommit={handleCreateFolder}
            onFolderInputCancel={() => {
              setShowFolderInput(false);
              setNewFolderName("");
            }}
            width={sidebarWidth}
          />
          {/* 4px col-resize hit area; invisible until hover. */}
          <div
            onMouseDown={(e) => startResize(e, "sidebar")}
            className="shrink-0 cursor-col-resize hover:bg-border-focus/60 transition-colors"
            style={{ width: 4, marginLeft: -2, marginRight: -2, zIndex: 5 }}
          />
        </>
      )}

      {/* Main */}
      <main
        className="flex-1 flex flex-col min-w-0"
        style={{ background: "var(--bg-base)" }}
      >
        {activeRepoName ? (
          <>
            <RepoTopbar
              name={
                clonedRepos.find((r) => r.name === activeRepoName)
                  ?.display_name ?? activeRepoName
              }
              path={
                clonedRepos.find((r) => r.name === activeRepoName)?.path ?? ""
              }
              onToggleSidebar={toggleKnowledgeSidebar}
              sidebarHidden={!showSidebar}
              onToggleInspector={toggleKnowledgeInspector}
            />
            {repoReadme ? (
              // README is read-only — a full Tiptap instance is wrong here.
              // It mounts the mention extension whose <body>-level popup
              // host leaks into the next note opened. Use the lightweight
              // <Markdown> renderer instead; it's the same one chat /
              // canvas inspectors use. Wrap it in a padded, scrollable
              // viewport so long READMEs scroll cleanly.
              <div className="flex-1 min-h-0 overflow-auto">
                <div className="max-w-3xl mx-auto px-8 py-8">
                  <ReadmeView source={repoReadme} />
                </div>
              </div>
            ) : (
              <RepoEmpty
                path={
                  clonedRepos.find((r) => r.name === activeRepoName)?.path ?? ""
                }
              />
            )}
          </>
        ) : activeEntry ? (
          <>
            <EditorTopbar
              breadcrumbs={breadcrumbs}
              title={pageTitle}
              icon={activeMeta.icon ?? "📄"}
              kind="NOTE"
              isDirty={isDirty}
              onToggleSidebar={toggleKnowledgeSidebar}
              sidebarHidden={!showSidebar}
              onToggleInspector={toggleKnowledgeInspector}
            />
            {/* One scroller wraps cover + page header + properties + editor +
                backlinks footer so they all share the 780/72 alignment column
                like Notion. The Tiptap surface inside drops its horizontal
                padding (see tiptap.css) and inherits the column gutter from
                this parent. */}
            <div
              className="flex-1 min-h-0 overflow-y-auto"
              style={{ background: "var(--bg-base)" }}
            >
              <div
                style={{
                  maxWidth: 780,
                  margin: "0 auto",
                  padding: "18px 72px 48px",
                  minHeight: "100%",
                }}
              >
                <PageHeaderWithIcon
                  entryId={activeEntryId ?? ""}
                  projectPath={currentProject.path}
                  title={pageTitle}
                />
                {activeEntryId && (
                  <PageProperties
                    entryId={activeEntryId}
                    fallbackUpdatedAt={activeEntry?.updated_at ?? null}
                    referencesLabel={referencesLabel}
                  />
                )}
                <TiptapEditor
                  ref={(handle) => {
                    editorRef.current = handle;
                    setEditorInstance(handle?.getEditor() ?? null);
                  }}
                  documentId={`note:${activeEntryId}`}
                  initialMarkdown={editContent}
                  onDirty={() => {
                    setIsDirty(true);
                  }}
                />
                {backlinksFooter.length > 0 && (
                  <div
                    style={{
                      marginTop: 32,
                      padding: "14px 16px",
                      background: "var(--bg-elevated-2)",
                      border: "1px solid var(--border-subtle)",
                      borderRadius: 10,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        marginBottom: 10,
                      }}
                    >
                      <span className="eyebrow" style={{ flex: 1 }}>
                        Mentioned in · {backlinksFooter.length}{" "}
                        {backlinksFooter.length === 1 ? "place" : "places"}
                      </span>
                    </div>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 1fr",
                        gap: 8,
                      }}
                    >
                      {backlinksFooter.slice(0, 4).map((b, idx) => (
                        <button
                          key={`${b.fromEntryId}-${idx}`}
                          type="button"
                          onClick={() => void handleSelectEntry(b.fromEntryId)}
                          style={{
                            padding: "8px 10px",
                            borderRadius: 7,
                            background: "var(--bg-base)",
                            border: "1px solid var(--border-subtle)",
                            textAlign: "left",
                            cursor: "pointer",
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background =
                              "var(--bg-hover)";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = "var(--bg-base)";
                          }}
                        >
                          <div
                            style={{
                              fontSize: 12,
                              color: "var(--text-primary)",
                              fontWeight: 500,
                              marginBottom: 4,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {b.fromTitle}
                          </div>
                          <div
                            style={{
                              fontSize: 11.5,
                              color: "var(--text-tertiary)",
                              lineHeight: 1.5,
                              display: "-webkit-box",
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: "vertical" as const,
                              overflow: "hidden",
                            }}
                          >
                            {b.snippet}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
            <EditorFooter
              wordCount={wordCount}
              charCount={charCount}
              projectPath={currentProject.path}
              entryId={activeEntryId}
            />
          </>
        ) : (
          <div className="h-full flex items-center justify-center text-text-tertiary text-sm">
            Select or create a note
          </div>
        )}
      </main>

      {showInspector && activeEntry && !activeRepoName && (
        <>
          <div
            onMouseDown={(e) => startResize(e, "inspector")}
            className="shrink-0 cursor-col-resize hover:bg-border-focus/60 transition-colors"
            style={{ width: 4, marginLeft: -2, marginRight: -2, zIndex: 5 }}
          />
          <KnowledgeInspector
            outline={outline.map((h) => ({
              id: h.id,
              label: h.label,
              level: h.level,
            }))}
            activeHeadingId={activeHeadingId}
            onJumpToHeading={(id) => {
              if (!editorInstance) return;
              const heading = outline.find((h) => h.id === id);
              if (!heading) return;
              jumpToHeading(editorInstance, heading.pos);
            }}
            pageStats={pageStats}
            entryId={activeEntryId}
            onJumpToEntry={(id) => void handleSelectEntry(id)}
            width={inspectorWidth}
          />
        </>
      )}
    </div>
  );
}

/* ── Sub-components kept local since they're presentational glue ─── */

function PageHeaderWithIcon({
  entryId,
  projectPath,
  title,
}: {
  entryId: string;
  projectPath: string;
  /** Resolved display title (meta.title ?? filename fallback). The
   *  input below is treated as a controlled-with-debounce field; the
   *  parent rebuilds this prop when meta changes. */
  title: string;
}) {
  const meta = usePageMeta(entryId);
  const { patch } = useKnowledgeMetaStore.use.actions();
  const icon = meta.icon || "📄";
  const cover = meta.cover ?? null;
  const [iconAnchor, setIconAnchor] = useState<DOMRect | null>(null);
  const [coverAnchor, setCoverAnchor] = useState<DOMRect | null>(null);

  // Local draft so typing into the title input doesn't fire a Rust
  // patch on every keystroke. We commit on blur + Enter.
  const [titleDraft, setTitleDraft] = useState(title);
  useEffect(() => {
    setTitleDraft(title);
  }, [title, entryId]);

  const commitTitle = () => {
    const next = titleDraft.trim();
    if (!entryId) return;
    if (!next) {
      // Empty draft → clear the override so the filename fallback wins
      // again.
      if (meta.title !== null && meta.title !== undefined) {
        void patch(entryId, { title: null });
      }
      return;
    }
    if (next !== (meta.title ?? "")) {
      void patch(entryId, { title: next });
    }
  };

  const isGradientCover = cover?.startsWith("gradient:");
  const gradient = isGradientCover ? gradientCss(cover!) : null;

  // Covers are stored under the hidden `.atlas/` directory, which Tauri's
  // asset protocol refuses to serve (the webview 403s the asset:// request).
  // Fetch the image as a base64 `data:` URL instead — it embeds the bytes
  // directly, so the cover renders identically in dev and bundled builds
  // without depending on the asset protocol or its scope globs.
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!cover || isGradientCover) {
      setCoverUrl(null);
      return;
    }
    let alive = true;
    void invoke<string>("knowledge_cover_data_url", { projectPath, cover })
      .then((url) => {
        if (alive) setCoverUrl(url);
      })
      .catch(() => {
        if (alive) setCoverUrl(null);
      });
    return () => {
      alive = false;
    };
  }, [cover, isGradientCover, projectPath]);

  return (
    <div style={{ marginBottom: 14 }}>
      {/* Cover strip — 180px, hidden when not set. Add-cover button
          appears just above the title when none exists. */}
      {cover ? (
        <div
          // Key on the resolved cover ref so React fully remounts the
          // element when it flips between gradient ↔ image ↔ absent —
          // belt-and-braces against any background-image cache holding
          // a stale URL after a cover swap or remove.
          key={cover}
          style={{
            height: 180,
            borderRadius: 10,
            border: "1px solid var(--border-subtle)",
            margin: "0 0 14px",
            background:
              gradient ??
              (coverUrl
                ? `center / cover no-repeat url("${coverUrl}")`
                : "var(--bg-elevated)"),
            position: "relative",
            cursor: "pointer",
          }}
          onClick={(e) =>
            setCoverAnchor(e.currentTarget.getBoundingClientRect())
          }
          title="Click to change cover"
        />
      ) : null}

      <div
        style={{
          display: "flex",
          gap: 12,
          color: "var(--text-muted)",
          fontSize: 11.5,
          opacity: 0.85,
          marginBottom: 4,
        }}
      >
        {!cover && (
          <button
            type="button"
            onClick={(e) =>
              setCoverAnchor(e.currentTarget.getBoundingClientRect())
            }
            style={{
              background: "transparent",
              border: 0,
              padding: 0,
              color: "var(--text-muted)",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              fontSize: 11.5,
            }}
          >
            Add cover
          </button>
        )}
      </div>

      <div className="flex items-start" style={{ gap: 14, marginTop: 10 }}>
        <button
          title="Change icon"
          onClick={(e) =>
            setIconAnchor(e.currentTarget.getBoundingClientRect())
          }
          style={{
            width: 44,
            height: 44,
            borderRadius: 9,
            background: "var(--bg-elevated-2)",
            border: "1px solid var(--border-subtle)",
            fontSize: 24,
            lineHeight: 1,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            flex: "none",
            cursor: "pointer",
          }}
        >
          {icon}
        </button>
        <div className="flex-1 min-w-0">
          <input
            value={titleDraft}
            placeholder="Untitled"
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitTitle();
                (e.currentTarget as HTMLInputElement).blur();
              } else if (e.key === "Escape") {
                setTitleDraft(title);
                (e.currentTarget as HTMLInputElement).blur();
              }
            }}
            style={{
              display: "block",
              width: "100%",
              fontSize: 28,
              lineHeight: 1.15,
              margin: "2px 0 0",
              letterSpacing: "-0.03em",
              color: "var(--text-primary)",
              fontWeight: 600,
              fontFamily: "var(--font-display)",
              background: "transparent",
              border: 0,
              padding: 0,
              outline: "none",
            }}
          />
        </div>
      </div>

      {iconAnchor && (
        <IconPicker
          value={meta.icon ?? null}
          anchorRect={iconAnchor}
          onPick={(v) => entryId && void patch(entryId, { icon: v })}
          onClose={() => setIconAnchor(null)}
        />
      )}
      {coverAnchor && entryId && (
        <CoverPicker
          value={cover}
          projectPath={projectPath}
          entryId={entryId}
          anchorRect={coverAnchor}
          onPick={(v) => void patch(entryId, { cover: v })}
          onClose={() => setCoverAnchor(null)}
        />
      )}
    </div>
  );
}

function RepoTopbar({
  name,
  path,
  onToggleSidebar,
  sidebarHidden,
  onToggleInspector,
}: {
  name: string;
  path: string;
  onToggleSidebar?: () => void;
  sidebarHidden?: boolean;
  onToggleInspector: () => void;
}) {
  return (
    <div
      className="flex items-center shrink-0 border-b border-border-subtle"
      style={{
        height: 36,
        gap: 8,
        padding: "0 14px",
        background: "var(--bg-canvas)",
      }}
    >
      {onToggleSidebar && (
        <button
          onClick={onToggleSidebar}
          className="p-1 rounded text-text-tertiary hover:bg-bg-hover hover:text-text-secondary transition-colors"
          title={sidebarHidden ? "Show sidebar" : "Hide sidebar"}
          style={{ width: 22, height: 22, marginLeft: -6 }}
        >
          <PanelLeft size={12} />
        </button>
      )}
      <GitBranch size={12} className="text-text-tertiary shrink-0" />
      <span
        className="font-mono text-text-secondary truncate flex-1 min-w-0"
        style={{ fontSize: 12 }}
      >
        {name}
      </span>
      <span
        className="pill pill-bare"
        style={{ height: 18, fontSize: 9.5, padding: "0 6px" }}
      >
        REPO
      </span>
      <button
        onClick={() => navigator.clipboard.writeText(path)}
        className="p-1 rounded text-text-tertiary hover:bg-bg-hover hover:text-text-secondary transition-colors cursor-pointer"
        title="Copy path"
        style={{ width: 22, height: 22 }}
      >
        <Copy size={11} />
      </button>
      <button
        onClick={onToggleInspector}
        className="p-1 rounded text-text-tertiary hover:bg-bg-hover hover:text-text-secondary transition-colors"
        title="Toggle inspector"
        style={{ width: 22, height: 22 }}
      >
        <PanelRight size={12} />
      </button>
    </div>
  );
}

function RepoEmpty({ path }: { path: string }) {
  // Open this repo as a workspace in the current window (Atlas is
  // single-window now — was: spawn a new native window).
  const open = () => {
    void useWorkspaceStore.getState().actions.addWorkspace(path);
  };
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 text-text-tertiary">
      <p className="text-[12px]">No README.md found</p>
      <div className="flex items-center gap-2">
        <button
          onClick={open}
          className={cn(
            "flex items-center gap-1 px-2 py-1 rounded border border-border-default",
            "text-[10px] text-text-secondary hover:bg-bg-hover cursor-pointer",
          )}
        >
          <ExternalLink size={10} /> Open in new window
        </button>
        <button
          onClick={() => navigator.clipboard.writeText(path)}
          className={cn(
            "flex items-center gap-1 px-2 py-1 rounded border border-border-default",
            "text-[10px] text-text-secondary hover:bg-bg-hover cursor-pointer",
          )}
        >
          <Copy size={10} /> Copy path
        </button>
      </div>
    </div>
  );
}
