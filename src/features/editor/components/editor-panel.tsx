import { useState, useEffect, useRef, useCallback } from "react";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
} from "@codemirror/view";
import { EditorState, Compartment, Transaction } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, indentOnInput } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { editorThemeExtensions } from "../themes/build-cm-theme";
import { useEditorStore } from "../stores/editor-store";
import { useAppStore } from "@/features/app/stores/app-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ChevronRight, MessageSquare, MessageSquarePlus, RefreshCw } from "lucide-react";
import { logEvent } from "@/features/log/lib/log";
import { diffGutter, applyDiffStatus } from "../lib/diff-gutter";
import { gitDiffLineStatus } from "@/features/git/lib/git-diff-api";
import { blameInline, applyBlame } from "../lib/blame-inline";
import { loadLanguageExtension } from "../lib/languages";
import { applyReveal } from "../lib/reveal";
import { registerEditorView } from "../lib/editor-views";
import { gitBlameFile } from "@/features/git/lib/git-blame-api";
import { MarkdownFile } from "@/lib/markdown-fileviewer";
import { openFileAs } from "@/lib/open-file";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { setRemoteCarets } from "../lib/remote-carets";
import {
  sharedDocExtensions,
  useSharedDoc,
} from "@/features/shared-threads/lib/use-shared-doc";
import { usePeers } from "@/features/shared-threads/stores/shared-threads-store";
import { usePersonName } from "@/features/shared-threads/lib/use-person-name";
import { useLineComments } from "@/features/shared-threads/lib/use-line-comments";
import {
  LineCommentList,
  NewLineComment,
  commentedLines,
  threadsOf,
} from "@/features/shared-threads/components/line-comments";
import { useSharedThreadsStore } from "@/features/shared-threads/stores/shared-threads-store";
import {
  commentLines,
  selectedLines,
  setCommentLines,
  type CommentSpan,
} from "../lib/comment-lines";

const TOOLBAR_HEIGHT = 32;
/** The height of a Shared Thread file's comments pane, when open (ATL-416). */
const COMMENTS_HEIGHT = 240;
const DIRTY_CHECK_DEBOUNCE = 300; // ms — only check dirty state, not sync content

// Theme colours are live-swappable through a compartment; the resolved theme
// is shared with the rest of Atlas rather than selected independently.
const themeCompartment = new Compartment();

// Inline git blame — live-toggleable via a Compartment so flipping the
// `gitBlameInline` setting doesn't rebuild the view (buffer/undo survive).
const blameCompartment = new Compartment();

interface EditorPanelProps {
  tabId: string;
  filePath?: string;
  containerHeight: number;
}

export function EditorPanel({ tabId, filePath, containerHeight }: EditorPanelProps) {
  const path = filePath ?? "";
  const isUntitled = path.startsWith("untitled:");
  const buffer = useEditorStore((s) => s.buffers[path]);
  const { openBuffer, setDirty, markSaved, reloadBuffer, markExternallyChanged } =
    useEditorStore.use.actions();
  const projectPath = useAppStore.use.currentProject()?.path ?? "";
  const layoutActions = useLayoutStore.use.actions();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onSaveRef = useRef<() => void>(() => {});
  const refreshGutterRef = useRef<() => void>(() => {});
  const refreshBlameRef = useRef<() => void>(() => {});
  const dirtyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A file of a joined Shared Thread's replica is edited live (ATL-407): the
  // view binds to the file's document, keystrokes sync as they are typed and
  // the replica writes the file. If they may not sync, the text is saved to
  // disk instead and the view goes back to the usual open-edit-save.
  const shared = useSharedDoc(isUntitled ? "" : path, (text) => {
    void invoke("write_file_content", { path, content: text }).catch((e: unknown) =>
      logEvent({
        source: "editor",
        kind: "save",
        status: "failure",
        summary: path.split("/").pop() ?? path,
        payload: { path, error: String(e), sharedThread: true },
      }),
    );
  });
  const sharedRef = useRef(shared.binding);
  sharedRef.current = shared.binding;
  const peers = usePeers(shared.binding?.doc.sharedThreadId);
  const nameOf = usePersonName();

  // Comments on this file's lines (ATL-416): marked in the text, and listed —
  // with a new one on the selected lines — in a pane under it.
  const lineComments = useLineComments(shared.binding?.doc.sharedThreadId ?? null);
  const [selection, setSelection] = useState<CommentSpan | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [composing, setComposing] = useState<CommentSpan | null>(null);
  const me = useSharedThreadsStore(
    (s) =>
      s.threads.find((t) => t.sharedThreadId === shared.binding?.doc.sharedThreadId)?.status.remote?.userId ??
      null,
  );
  const fileThreads = shared.binding
    ? threadsOf(lineComments.comments, shared.binding.doc.fileId)
    : [];

  const [renderMode, setRenderMode] = useState<"editor" | "preview">("editor");
  // Bumped when a view is built, so a reveal that arrived before the view
  // existed (a file opened at a line) is applied the moment it does.
  const [viewGen, setViewGen] = useState(0);
  const unregisterViewRef = useRef<(() => void) | null>(null);
  const pendingReveal = useEditorStore((s) => s.pendingReveals[path]);
  const consumeReveal = useEditorStore.use.actions().consumeReveal;
  const resolvedFileType = (
    buffer?.language ??
    path.split(".").pop()?.toLowerCase() ??
    ""
  ).toLowerCase();
  const isMarkdownFile = resolvedFileType === "markdown";
  // Preview is a markdown-only concept. Deriving (not just gating the toggle)
  // matters twice over: a stale "preview" renderMode from a previous markdown
  // file must not blank the editor for the next file, and the preview pane
  // must never MOUNT for other file types — react-markdown with rehypeRaw
  // parses arbitrary source text as HTML, and any literal `<input ref={…}>`
  // in a .tsx file is a fatal React error (string refs), which is exactly how
  // opening files used to crash the app.
  const effectiveMode = isMarkdownFile ? renderMode : "editor";
  // A tab can be reused for another file; each file starts in the editor.
  useEffect(() => {
    setRenderMode("editor");
  }, [path]);

  // Load file content from disk — unless this is an untitled scratch
  // buffer (Cmd+N), in which case we seed an empty buffer in-memory
  // and skip the IPC. The synthetic `untitled:<ts>` key keeps each
  // unsaved tab's buffer separate in the store.
  useEffect(() => {
    if (!path || buffer) return;
    if (isUntitled) {
      openBuffer(path, "");
      return;
    }
    void (async () => {
      try {
        const content = await invoke<string>("read_file_content", { path });
        const mtime = await invoke<number>("file_mtime_ms", { path }).catch(() => 0);
        openBuffer(path, content, mtime);
      } catch {
        openBuffer(path, `// Failed to read: ${path}`);
      }
    })();
  }, [path, buffer, openBuffer, isUntitled]);

  // Save: read content directly from CodeMirror, not from store.
  // Untitled buffers open the OS save dialog first; on commit we
  // write the file, replace the untitled tab with a real-path tab,
  // and migrate the buffer key so the new tab picks up the content
  // immediately without a disk round-trip.
  const handleSave = useCallback(async () => {
    const view = viewRef.current;
    // A Shared Thread's file is saved as it is typed; writing the view over it
    // could race a batch still on its way and land the same text twice.
    if (!view || sharedRef.current) return;
    const content = view.state.doc.toString();
    if (isUntitled) {
      try {
        const { save: saveDialog } = await import("@tauri-apps/plugin-dialog");
        const chosen = await saveDialog({
          defaultPath: projectPath || undefined,
          title: "Save File",
        });
        if (!chosen) return; // user cancelled
        const newPath = chosen as string;
        await invoke("write_file_content", { path: newPath, content });
        const mtime = await invoke<number>("file_mtime_ms", { path: newPath }).catch(() => 0);
        // Carry the freshly-saved content over to the new buffer key.
        openBuffer(newPath, content, mtime);
        markSaved(newPath, content, mtime);
        // Swap the tab in place: close untitled, open real-path tab
        // with the same activation behavior addTab gives.
        layoutActions.closeTab(tabId);
        openFileAs(newPath, "text");
        logEvent({
          source: "editor",
          kind: "save",
          summary: newPath.split("/").pop() ?? newPath,
          payload: { path: newPath, bytes: content.length },
        });
      } catch (err) {
        console.error("Save-as failed:", err);
      }
      return;
    }
    try {
      await invoke("write_file_content", { path, content });
      const mtime = await invoke<number>("file_mtime_ms", { path }).catch(() => 0);
      markSaved(path, content, mtime);
      logEvent({
        source: "editor",
        kind: "save",
        summary: path.split("/").pop() ?? path,
        payload: { path, bytes: content.length },
      });
      // A save mutates the working tree — refresh git status/dots + diff
      // right now instead of waiting for the project fs watcher (FSEvents
      // latency + fileindex 150 ms + git-store debounce). Lazy-imported to
      // keep the editor decoupled from the git store.
      void import("@/features/git/stores/git-store").then(({ useGitStore }) => {
        const git = useGitStore.getState();
        if (git.repoPath) {
          void git.actions.refreshStatusNow(git.repoPath);
          void git.actions.loadDiff();
        }
      });
      // Repaint this editor's diff gutter against the just-saved content.
      refreshGutterRef.current();
      // Buffer and disk agree again — refresh the inline blame snapshot.
      refreshBlameRef.current();
    } catch (err) {
      console.error("Save failed:", err);
    }
  }, [path, markSaved, isUntitled, projectPath, openBuffer, layoutActions, tabId]);

  onSaveRef.current = handleSave;

  // Fetch this file's git diff vs HEAD and paint the gutter (added/changed/
  // deleted bars). No-op for untitled scratch buffers or files outside the repo.
  const refreshDiffGutter = useCallback(() => {
    const view = viewRef.current;
    if (!view || isUntitled || !projectPath) return;
    if (!path.startsWith(projectPath + "/")) return;
    const rel = path.slice(projectPath.length + 1);
    void gitDiffLineStatus(projectPath, rel, false)
      .then((status) => {
        if (viewRef.current) applyDiffStatus(viewRef.current, status);
      })
      .catch(() => {});
  }, [path, projectPath, isUntitled]);
  refreshGutterRef.current = refreshDiffGutter;

  // Fetch this file's per-line blame and hand it to the inline-blame
  // extension. Blame is computed against the file on disk, so we skip the
  // fetch while the buffer is dirty (line numbers would misalign) — the
  // extension keeps showing the last snapshot, degrading edited lines to
  // "Uncommitted changes" on its own. No-op for untitled buffers, files
  // outside the project, or when the setting is off.
  const refreshBlame = useCallback(() => {
    const view = viewRef.current;
    if (!view || isUntitled || !projectPath) return;
    if (!useSettingsStore.getState().settings.gitBlameInline) return;
    if (!path.startsWith(projectPath + "/")) return;
    if (useEditorStore.getState().buffers[path]?.dirty) return;
    const rel = path.slice(projectPath.length + 1);
    void gitBlameFile(projectPath, rel)
      .then((lines) => {
        // Ignore late results after the view was destroyed or swapped.
        if (viewRef.current === view) applyBlame(view, lines);
      })
      .catch(() => {});
  }, [path, projectPath, isUntitled]);
  refreshBlameRef.current = refreshBlame;

  // Re-seed the live CodeMirror view from a string without polluting undo
  // history (external reload, not a user edit).
  const replaceViewDoc = useCallback((content: string) => {
    const view = viewRef.current;
    if (!view) return;
    if (view.state.doc.toString() === content) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
      annotations: Transaction.addToHistory.of(false),
    });
  }, []);

  // Reconcile this buffer with disk when the file may have changed externally
  // (agent/CLI edits). mtime-gated so unchanged files cost one cheap IPC. When
  // the buffer is clean we reload silently; when it has unsaved edits we only
  // flag it (`externallyChanged`) so the user can reload via the toolbar.
  const revalidate = useCallback(async () => {
    // Bound to a Shared Thread's document, which owns the text: the replica
    // writes disk from it, never the other way.
    if (!path || isUntitled || sharedRef.current) return;
    const buf = useEditorStore.getState().buffers[path];
    if (!buf) return;
    const mtime = await invoke<number>("file_mtime_ms", { path }).catch(() => 0);
    if (!mtime || mtime <= buf.diskMtimeMs) return;
    let content: string;
    try {
      content = await invoke<string>("read_file_content", { path });
    } catch {
      return;
    }
    // Re-read the buffer: it may have changed (dirty/gone) during the awaits.
    const cur = useEditorStore.getState().buffers[path];
    if (!cur) return;
    const liveDoc = viewRef.current?.state.doc.toString() ?? cur.originalContent;
    if (content === liveDoc) {
      // Content matches what's shown (e.g. our own save) — just record mtime.
      reloadBuffer(path, content, mtime);
      return;
    }
    if (cur.dirty) {
      markExternallyChanged(path, mtime);
      return;
    }
    reloadBuffer(path, content, mtime);
    replaceViewDoc(content);
    refreshDiffGutter();
    refreshBlameRef.current();
  }, [path, isUntitled, reloadBuffer, markExternallyChanged, replaceViewDoc, refreshDiffGutter]);
  const revalidateRef = useRef(revalidate);
  revalidateRef.current = revalidate;

  // User-initiated reload from the "changed on disk" toolbar affordance —
  // discards unsaved edits (the user explicitly chose disk).
  const forceReload = useCallback(async () => {
    if (!path || isUntitled || sharedRef.current) return;
    let content: string;
    try {
      content = await invoke<string>("read_file_content", { path });
    } catch {
      return;
    }
    const mtime = await invoke<number>("file_mtime_ms", { path }).catch(() => 0);
    reloadBuffer(path, content, mtime);
    replaceViewDoc(content);
    refreshDiffGutter();
    refreshBlameRef.current();
  }, [path, isUntitled, reloadBuffer, replaceViewDoc, refreshDiffGutter]);

  // Repaint the gutter when the working tree changes elsewhere (commits,
  // stage/unstage, external edits) — same event the git store listens to.
  useEffect(() => {
    const un = listen("atlas:git-changed", () => {
      refreshDiffGutter();
      refreshBlame();
    });
    return () => {
      un.then((u) => u());
    };
  }, [refreshDiffGutter, refreshBlame]);

  // Reconcile with disk on the signals that indicate an external edit:
  //  • buffer mount (fixes close-then-reopen showing a stale cached buffer),
  //  • the recursive working-tree watcher (`atlas:explorer:changed`) for live
  //    updates while the tab is open,
  //  • native window focus regain (`atlas:window-active`) — the reported flow
  //    of editing in the Claude Code CLI and switching back to Atlas.
  useEffect(() => {
    if (!buffer || isUntitled) return;
    void revalidateRef.current();
    const un = listen("atlas:explorer:changed", () => void revalidateRef.current());
    const onActive = () => void revalidateRef.current();
    window.addEventListener("atlas:window-active", onActive);
    return () => {
      un.then((u) => u());
      window.removeEventListener("atlas:window-active", onActive);
    };
  }, [path, !!buffer, isUntitled]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-paint when inputs settle (e.g. the project path resolves AFTER the view
  // was created, or the buffer swaps). The in-view-creation call covers the
  // common case; this covers the late-projectPath race.
  useEffect(() => {
    refreshDiffGutter();
    refreshBlame();
  }, [refreshDiffGutter, refreshBlame, buffer]);

  // Create/destroy CodeMirror view
  useEffect(() => {
    if (!buffer || !containerRef.current || shared.pending) return;
    const binding = shared.binding;

    // Seed from the freshest store content — a disk revalidation may have
    // reloaded the buffer between mount and this (async) view creation. A
    // Shared Thread's file starts from its document instead.
    const originalContent = binding
      ? binding.ytext.toString()
      : (useEditorStore.getState().buffers[path]?.originalContent ?? buffer.originalContent);
    let cancelled = false;

    (async () => {
      const langExt = await loadLanguageExtension(buffer.language);
      if (cancelled) return;

      const view = new EditorView({
        doc: originalContent,
        extensions: [
          themeCompartment.of(editorThemeExtensions()),
          langExt,
          lineNumbers(),
          diffGutter(),
          blameCompartment.of(
            useSettingsStore.getState().settings.gitBlameInline ? blameInline() : [],
          ),
          highlightActiveLine(),
          drawSelection(),
          bracketMatching(),
          foldGutter(),
          indentOnInput(),
          history(),
          highlightSelectionMatches(),
          keymap.of([
            {
              key: "Mod-s",
              run: () => {
                onSaveRef.current();
                return true;
              },
            },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
          ]),
          ...(binding
            ? [
                ...sharedDocExtensions(binding),
                commentLines,
                EditorView.updateListener.of((u) => {
                  if (u.selectionSet) setSelection(selectedLines(u.state));
                }),
              ]
            : []),
          // Debounced dirty check — never sync full content to store on keystroke.
          // A Shared Thread's file is never dirty: every keystroke is saved.
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !binding) {
              if (dirtyTimerRef.current) clearTimeout(dirtyTimerRef.current);
              dirtyTimerRef.current = setTimeout(() => {
                const current = update.view.state.doc.toString();
                const orig = useEditorStore.getState().buffers[path]?.originalContent ?? "";
                setDirty(path, current !== orig);
              }, DIRTY_CHECK_DEBOUNCE);
            }
          }),
          EditorState.tabSize.of(2),
        ],
        parent: containerRef.current!,
      });

      if (cancelled) {
        view.destroy();
        return;
      }

      viewRef.current = view;
      // A revalidation that landed while the view was being built updates only
      // the store; sync the view to it now (idempotent — no-op when equal).
      // Never for a Shared Thread's file: the document owns that text.
      const latest = useEditorStore.getState().buffers[path]?.originalContent;
      if (latest !== undefined && !binding) replaceViewDoc(latest);
      refreshDiffGutter();
      refreshBlameRef.current();
      unregisterViewRef.current = registerEditorView(tabId, view);
      setViewGen((g) => g + 1);
    })();

    return () => {
      cancelled = true;
      if (dirtyTimerRef.current) clearTimeout(dirtyTimerRef.current);
      unregisterViewRef.current?.();
      unregisterViewRef.current = null;
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
    };
  }, [path, !!buffer, shared.pending, shared.binding]); // eslint-disable-line react-hooks/exhaustive-deps

  // Where this file's open discussions are now (ATL-416).
  useEffect(() => {
    const view = viewRef.current;
    const binding = shared.binding;
    if (!view || !binding) return;
    view.dispatch({ effects: setCommentLines.of(commentedLines(lineComments.comments, binding.doc.fileId)) });
  }, [lineComments.comments, shared.binding, viewGen]);

  // Everybody else's carets in this file (ATL-407).
  useEffect(() => {
    const view = viewRef.current;
    const binding = shared.binding;
    if (!view || !binding) return;
    const carets = peers.flatMap((p) =>
      p.cursors
        .filter((c) => c.fileId === binding.doc.fileId)
        .map((c) => ({ userId: p.userId, cursor: c.head, name: nameOf(p.userId) })),
    );
    view.dispatch({ effects: setRemoteCarets.of(carets) });
  }, [peers, shared.binding, viewGen, nameOf]);

  // Apply a pending reveal ("open at line") once the view exists. Editor tabs
  // stay mounted while hidden, so a reveal on an open tab lands at once; one
  // for a file still loading waits for `viewGen`. Markdown preview hides the
  // view, so it switches to the editor first and applies on the next render.
  useEffect(() => {
    const view = viewRef.current;
    if (!pendingReveal || !view) return;
    if (effectiveMode !== "editor") {
      setRenderMode("editor");
      return;
    }
    applyReveal(view, pendingReveal);
    consumeReveal(path, pendingReveal.nonce);
  }, [pendingReveal, viewGen, effectiveMode, path, consumeReveal]);

  // Live-reskin the editor when the persisted theme changes — reconfigure the
  // theme compartment in place so the buffer/undo history survive.
  const theme = useSettingsStore.use.settings().theme;
  useEffect(() => {
    const refreshTheme = () => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({ effects: themeCompartment.reconfigure(editorThemeExtensions()) });
    };
    refreshTheme();
    window.addEventListener("atlas:theme-applied", refreshTheme);
    return () => window.removeEventListener("atlas:theme-applied", refreshTheme);
  }, [theme]);

  // Live-toggle inline blame: reconfigure the compartment in place; turning it
  // on also fetches a fresh snapshot (the extension starts empty).
  const gitBlameInline = useSettingsStore.use.settings().gitBlameInline;
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: blameCompartment.reconfigure(gitBlameInline ? blameInline() : []),
    });
    if (gitBlameInline) refreshBlameRef.current();
  }, [gitBlameInline]);

  if (!buffer) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
        Loading...
      </div>
    );
  }

  const paneOpen = commentsOpen && shared.binding !== null;
  const editorHeight =
    (containerHeight > TOOLBAR_HEIGHT ? containerHeight - TOOLBAR_HEIGHT : window.innerHeight - 140) -
    (paneOpen ? COMMENTS_HEIGHT : 0);

  return (
    <div
      className="bg-background"
      style={{ height: containerHeight || "100%", overflow: "hidden" }}
    >
      {/* Breadcrumb toolbar */}
      <div
        className="flex items-center px-3 border-b border-border bg-background overflow-hidden"
        style={{ height: TOOLBAR_HEIGHT }}
      >
        <Breadcrumbs filePath={path} projectPath={projectPath} />
        {buffer.dirty && <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0 ml-2" />}
        {/* Right-hand controls. `ml-auto` on the group (rather than on whichever
            child happens to be present) keeps them pinned right no matter which
            of them render — the reload pill is conditional, and hanging the
            margin off it meant the layout changed shape when a file went stale
            on disk. */}
        <div className="ml-auto flex items-center gap-2 pl-2">
          {shared.binding && (
            <>
              <button
                type="button"
                disabled={selection === null}
                onClick={() => {
                  setComposing(selection);
                  setCommentsOpen(true);
                }}
                title="Comment on the selected lines — teammates see it here and on the web"
                className="inline-flex items-center gap-1 h-control-xs px-2 rounded-full border border-border bg-card text-2xs font-medium text-secondary-foreground hover:text-foreground hover:bg-element-hover transition-colors shrink-0 disabled:opacity-40 disabled:pointer-events-none"
              >
                <MessageSquarePlus size={10} /> Comment
              </button>
              <button
                type="button"
                aria-pressed={commentsOpen}
                onClick={() => setCommentsOpen((o) => !o)}
                className={cn(
                  "inline-flex items-center gap-1 h-control-xs px-2 rounded-full border border-border text-2xs font-medium transition-colors shrink-0",
                  commentsOpen
                    ? "bg-element-hover text-foreground"
                    : "bg-card text-secondary-foreground hover:text-foreground hover:bg-element-hover",
                )}
              >
                <MessageSquare size={10} /> {fileThreads.length}
              </button>
            </>
          )}
          {buffer.externallyChanged && (
            <button
              type="button"
              onClick={() => void forceReload()}
              title="This file changed on disk. Reload discards your unsaved edits."
              className="inline-flex items-center gap-1 h-control-xs px-2 rounded-full border border-border bg-card text-2xs font-medium text-secondary-foreground hover:text-foreground hover:bg-element-hover transition-colors shrink-0"
            >
              <RefreshCw size={10} /> Disk changed · Reload
            </button>
          )}
          {isMarkdownFile && (
            <div className="inline-flex items-center h-control-xs rounded-full border border-border bg-card p-[2px] text-2xs font-medium shrink-0">
              <button
                type="button"
                onClick={() => setRenderMode("editor")}
                className={cn(
                  "px-2 h-full rounded-full transition-colors",
                  renderMode === "editor"
                    ? "bg-element-hover text-foreground"
                    : "text-secondary-foreground hover:text-foreground",
                )}
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => setRenderMode("preview")}
                className={cn(
                  "px-2 h-full rounded-full transition-colors",
                  renderMode === "preview"
                    ? "bg-element-hover text-foreground"
                    : "text-secondary-foreground hover:text-foreground",
                )}
              >
                Preview
              </button>
            </div>
          )}
        </div>
      </div>

      {/* CodeMirror container */}
      <div style={{ height: editorHeight, overflow: "hidden" }}>
        <div
          ref={containerRef}
          style={{
            display: effectiveMode === "editor" ? "block" : "none",
            height: editorHeight,
            overflow: "hidden",
          }}
        />
        {/* Mounted on demand, not display:none — a hidden mount would still
            markdown-parse every non-markdown buffer on open (see above). */}
        {effectiveMode === "preview" && (
          <div style={{ height: editorHeight }} className="overflow-auto bg-background px-4 py-3">
            {buffer && (
              <MarkdownFile trusted={true} className="max-w-none">
                {buffer.originalContent}
              </MarkdownFile>
            )}
          </div>
        )}
      </div>
      {paneOpen && shared.binding && (
        <div
          style={{ height: COMMENTS_HEIGHT }}
          className="flex flex-col gap-2 overflow-auto border-t border-border bg-background px-3 py-2 text-xs"
          aria-label="Comments on this file"
        >
          {composing && (
            <NewLineComment
              path={path.split("/").pop() ?? path}
              lines={composing}
              onSubmit={(body) => lineComments.comment({ fileId: shared.binding!.doc.fileId }, composing, body)}
              onCancel={() => setComposing(null)}
            />
          )}
          {fileThreads.length === 0 && !composing && (
            <p className="text-muted-foreground">
              No comments on this file. Select lines and choose Comment.
            </p>
          )}
          <LineCommentList
            threads={fileThreads}
            me={me}
            nameOf={nameOf}
            canWrite
            onReply={lineComments.reply}
            onResolve={lineComments.resolve}
            onVote={lineComments.vote}
          />
          {lineComments.error && <p className="text-error">{lineComments.error.message}</p>}
        </div>
      )}
    </div>
  );
}

function Breadcrumbs({ filePath, projectPath }: { filePath: string; projectPath: string }) {
  const relative =
    projectPath && filePath.startsWith(projectPath)
      ? filePath.slice(projectPath.length + 1)
      : filePath;
  const segments = relative.split("/").filter(Boolean);

  return (
    <div className="flex items-center min-w-0 overflow-hidden">
      {segments.map((segment, i) => {
        const isLast = i === segments.length - 1;
        return (
          <span key={i} className="flex items-center shrink-0">
            {i > 0 && <ChevronRight size={10} className="text-muted-foreground mx-0.5 shrink-0" />}
            <span
              className={`text-xs font-mono ${isLast ? "text-foreground" : "text-muted-foreground"}`}
            >
              {segment}
            </span>
          </span>
        );
      })}
    </div>
  );
}
