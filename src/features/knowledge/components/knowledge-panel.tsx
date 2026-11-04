import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useScopedHotkeys } from "@/features/keybindings/lib/use-scoped-hotkeys";
import { useKnowledgeStore } from "../stores/knowledge-store";
import { useKnowledgeMetaStore, usePageMeta } from "../stores/knowledge-meta-store";
import {
  useKnowledgeLinksStore,
  useBacklinks,
  useReferencesLabel,
} from "../stores/knowledge-links-store";
import { useAppStore } from "@/features/app/stores/app-store";
import {
  KNOWLEDGE_INSPECTOR_WIDTH,
  KNOWLEDGE_SIDEBAR_WIDTH,
  useLayoutStore,
} from "@/features/layout/stores/layout-store";
import { openFile } from "@/lib/open-file";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { registerFlush } from "@/features/projects/lib/flush-registry";
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
import { KnowledgeInspectorView } from "./views/knowledge-inspector-view";
import { PageProperties } from "./page-properties";
import { PageHeaderWithIcon } from "./page-header-with-icon";
import { ReadmeSkeleton, RepoEmpty, RepoTopbar } from "./views/repo-views";
import { ResizeSeparator } from "./views/resize-separator";
import { BacklinksFooter } from "./views/backlinks-footer";
import { listClonedRepos, readRepoReadme, saveKnowledgeNote } from "../lib/knowledge-api";
import type { KnowledgeClonedRepo } from "../lib/knowledge-api";
import { useKnowledgeResize } from "../lib/use-knowledge-resize";
import { useKnowledgeImports } from "../lib/use-knowledge-imports";
import { copyText } from "@/lib/clipboard";
import { useEditorCounts } from "../lib/use-editor-counts";

const RECENTS_MAX = 5;

/** `tabId` scopes the panel's shortcuts to its own tab — it stays mounted
 *  while hidden (a persistent tab type), so it must not answer ⌘S elsewhere. */
export function KnowledgePanel({ tabId }: { tabId?: string }) {
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
  const currentProject = useAppStore.use.currentProject();

  const editorRef = useRef<TiptapEditorHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [finderOpen, setFinderOpen] = useState(false);
  const [activeRepoName, setActiveRepoName] = useState<string | null>(null);
  const [repoReadme, setRepoReadme] = useState<string | null>(null);
  const [readmeLoading, setReadmeLoading] = useState(false);
  // Each README read takes a ticket; only the latest one may land, so a slow
  // read for the repo you left never overwrites the one you are looking at.
  const readmeTicket = useRef(0);
  const [clonedRepos, setClonedRepos] = useState<KnowledgeClonedRepo[]>([]);
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

  // Drag-resize helpers (see `useKnowledgeResize`).
  const startResize = useKnowledgeResize(
    sidebarWidth,
    inspectorWidth,
    setKnowledgeSidebarWidth,
    setKnowledgeInspectorWidth,
  );
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [editorInstance, setEditorInstance] = useState<Editor | null>(null);
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
      listClonedRepos(currentProject.path)
        .then(setClonedRepos)
        .catch(() => {});
    } else {
      unbindMeta();
      unbindLinks();
    }
  }, [currentProject?.path, loadEntries, bindMeta, unbindMeta, bindLinks, unbindLinks]);

  useEffect(() => {
    setIsDirty(false);
  }, [activeEntryId]);

  // Push every selected entry id onto the recents stack (MRU, capped).
  useEffect(() => {
    if (!activeEntryId) return;
    setRecentIds((prev) => {
      const next = [activeEntryId, ...prev.filter((id) => id !== activeEntryId)];
      return next.slice(0, RECENTS_MAX);
    });
  }, [activeEntryId]);

  const flushAndSave = useCallback(async () => {
    if (!currentProject || !editorRef.current) return;
    // Capture the (project path, note id) this content belongs to BEFORE the
    // async flush. The KB panel is resident across project switches, so a
    // switch (or note change) can land mid-flush; binding the triple here and
    // re-checking it after lets us abort rather than write one project's
    // content into another's file (the cross-project data-loss bug).
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
    // Project switched or the active note changed while flushing → abort.
    const live = useAppStore.getState().currentProject;
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

  // Coordinate with project switching: the switch awaits `flushAll()` BEFORE
  // it snapshots/swaps the active project, so register a flush that writes the
  // editor's current buffer to the OUTGOING project (`ctx.path`) — not the
  // resident React `currentProject`, which may already have flipped. This is
  // what guarantees a note saved in project A is persisted to A's file before
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
  // project switch, each gated on the editor's live dirty ref.
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
  // Bubble phase (not capture) on purpose: a focused terminal with 2+ tabs
  // claims ⌘;/⌘' in the capture phase first, and declines them otherwise.
  useScopedHotkeys({
    capture: false,
    tabId,
    handlers: {
      "kb.toggleSidebar": () => toggleKnowledgeSidebar(),
      "kb.toggleInspector": () => toggleKnowledgeInspector(),
      "kb.save": () => {
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
      },
    },
  });

  // Find — only while this KB tab is the focused one (so it doesn't hijack
  // the shortcut for other tabs / the app).
  useScopedHotkeys({
    rootRef,
    ...(tabId !== undefined ? { tabId } : { requireFocusWithin: true }),
    capture: false,
    handlers: {
      "kb.focusFinder": () => setFinderOpen(true),
    },
  });

  // Open a non-note file (image, code) in the file view rather than the
  // KB note editor.
  const openInFileView = useCallback((filePath: string) => {
    void openFile(filePath);
  }, []);

  const { handleImportFiles, handleImportFolder } = useKnowledgeImports(
    currentProject,
    loadEntries,
    openInFileView,
  );

  const handleSelectEntry = useCallback(
    async (id: string) => {
      // Always flush the outgoing note before swapping — unconditionally, not
      // gated on `isDirty` (which could be a stale `false` and drop the draft).
      // flushAndSave's content check makes the no-change case a cheap no-op.
      // Leave repo mode before the flush, so a repo picked while it runs is
      // not undone when it finishes.
      readmeTicket.current += 1;
      setActiveRepoName(null);
      setRepoReadme(null);
      setReadmeLoading(false);
      if (activeEntryId && id !== activeEntryId) {
        await flushAndSave();
      }
      selectEntry(id);
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
      const ticket = ++readmeTicket.current;
      setActiveRepoName(name);
      selectEntry("");
      setRepoReadme(null);
      setReadmeLoading(true);
      let readme: string | null;
      try {
        readme = await readRepoReadme(currentProject.path, name);
      } catch {
        readme = null;
      }
      if (ticket !== readmeTicket.current) return;
      // A README that is only whitespace has nothing to show: it reads as missing.
      setRepoReadme(readme?.trim() ? readme : null);
      setReadmeLoading(false);
    },
    [currentProject, selectEntry],
  );

  const handleCreateFolder = useCallback(async () => {
    if (!newFolderName.trim() || !currentProject) return;
    const name = newFolderName.trim();
    await createDir(currentProject.path, name);
    await saveKnowledgeNote(currentProject.path, `${name}/note-${Date.now()}`, `# ${name}\n\n`);
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

  // Word/char counts from the live editor (see `useEditorCounts`).
  const { wordCount, charCount } = useEditorCounts(editorInstance);

  const pageStats = useMemo<Array<[string, string | number]>>(() => {
    return [
      ["Words", wordCount.toLocaleString("en-US")],
      ["Characters", charCount.toLocaleString("en-US")],
      ["Headings", outline.length],
      ["Backlinks", "—"],
      ["Forward links", "—"],
    ];
  }, [wordCount, charCount, outline.length]);

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

  if (!currentProject) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
        Open a project first
      </div>
    );
  }

  return (
    <div ref={rootRef} className="relative flex h-full bg-panel">
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
          <ResizeSeparator
            label="Resize sidebar"
            width={sidebarWidth}
            min={KNOWLEDGE_SIDEBAR_WIDTH.min}
            max={KNOWLEDGE_SIDEBAR_WIDTH.max}
            grows="right"
            onResize={setKnowledgeSidebarWidth}
            onMouseDown={(e) => startResize(e, "sidebar")}
          />
        </>
      )}

      {/* Main */}
      <main className="flex min-w-0 flex-1 flex-col bg-background">
        {activeRepoName ? (
          <>
            <RepoTopbar
              name={
                clonedRepos.find((r) => r.name === activeRepoName)?.display_name ?? activeRepoName
              }
              onCopyPath={() =>
                void copyText(clonedRepos.find((r) => r.name === activeRepoName)?.path ?? "")
              }
              onToggleSidebar={toggleKnowledgeSidebar}
              sidebarHidden={!showSidebar}
            />
            {readmeLoading ? (
              <div className="flex-1 min-h-0 overflow-auto">
                <div className="max-w-3xl mx-auto px-8 py-8">
                  <ReadmeSkeleton />
                </div>
              </div>
            ) : repoReadme ? (
              // README is read-only — a full Tiptap instance is wrong here.
              // It mounts the mention extension whose <body>-level popup
              // host leaks into the next note opened. Use the lightweight
              // <Markdown> renderer instead; it's the same one chat /
              // canvas inspectors use. Wrap it in a padded, scrollable
              // viewport so long READMEs scroll cleanly.
              <div className="flex-1 min-h-0 overflow-auto">
                <div className="max-w-3xl mx-auto px-8 py-8">
                  <ReadmeView
                    source={repoReadme}
                    root={clonedRepos.find((r) => r.name === activeRepoName)?.path ?? null}
                  />
                </div>
              </div>
            ) : (
              <RepoEmpty
                onCopyPath={() =>
                  void copyText(clonedRepos.find((r) => r.name === activeRepoName)?.path ?? "")
                }
                onOpen={() => {
                  // Open this repo as a project in the current window (Atlas is
                  // single-window now — was: spawn a new native window).
                  void useProjectStore
                    .getState()
                    .actions.addProject(
                      clonedRepos.find((r) => r.name === activeRepoName)?.path ?? "",
                    );
                }}
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
            <div className="min-h-0 flex-1 overflow-y-auto bg-background">
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
                  <BacklinksFooter
                    backlinks={backlinksFooter}
                    onSelectEntry={(id) => void handleSelectEntry(id)}
                  />
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
          <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
            Select or create a note
          </div>
        )}
      </main>

      {showInspector && activeEntry && !activeRepoName && (
        <>
          <ResizeSeparator
            label="Resize inspector"
            width={inspectorWidth}
            min={KNOWLEDGE_INSPECTOR_WIDTH.min}
            max={KNOWLEDGE_INSPECTOR_WIDTH.max}
            grows="left"
            onResize={setKnowledgeInspectorWidth}
            onMouseDown={(e) => startResize(e, "inspector")}
          />
          <KnowledgeInspectorView
            outline={outline.map((h) => ({ id: h.id, label: h.label, level: h.level }))}
            activeHeadingId={activeHeadingId}
            onJumpToHeading={(id) => {
              if (!editorInstance) return;
              const heading = outline.find((h) => h.id === id);
              if (!heading) return;
              jumpToHeading(editorInstance, heading.pos);
            }}
            pageStats={pageStats}
            backlinks={backlinksFooter}
            onJumpToEntry={(id) => void handleSelectEntry(id)}
            width={inspectorWidth}
          />
        </>
      )}
    </div>
  );
}
