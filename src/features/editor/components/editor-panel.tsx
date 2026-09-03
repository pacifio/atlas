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
import { useProjectStore } from "@/features/project/stores/project-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useActionHandlers } from "@/features/keybindings/hooks/use-action-handlers";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ChevronRight, RefreshCw } from "lucide-react";
import { logEvent } from "@/features/log/lib/log";
import { diffGutter, applyDiffStatus } from "../lib/diff-gutter";
import { gitDiffLineStatus } from "@/features/git/lib/git-diff-api";
import { blameInline, applyBlame } from "../lib/blame-inline";
import { loadLanguageExtension } from "../lib/languages";
import { gitBlameFile } from "@/features/git/lib/git-blame-api";
import { MarkdownFile } from "@/lib/markdown-fileviewer";
import { cn } from "@/lib/utils";

const TOOLBAR_HEIGHT = 32;
const DIRTY_CHECK_DEBOUNCE = 300; // ms — only check dirty state, not sync content

// Editor theme — live-swappable via a Compartment. The concrete colors come
// from the theme registry (src/features/editor/themes), keyed by the persisted
// `settings.codeEditorTheme`.
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
  const projectPath = useProjectStore.use.currentProject()?.path ?? "";
  const layoutActions = useLayoutStore.use.actions();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const refreshGutterRef = useRef<() => void>(() => {});
  const refreshBlameRef = useRef<() => void>(() => {});
  const dirtyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [renderMode, setRenderMode] = useState<"editor" | "preview">("editor");
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
    if (!view) return;
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
        layoutActions.addTab({
          id: `editor-${newPath}`,
          type: "editor",
          title: newPath.split("/").pop() ?? newPath,
          closable: true,
          dirty: false,
          data: { filePath: newPath },
        });
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
      // right now instead of waiting for the workspace fs watcher (FSEvents
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

  // The handler registry keeps the latest closure itself, so this needs no
  // ref of its own.
  useActionHandlers({ "editor-save": handleSave }, tabId);

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
    if (!useProjectStore.getState().settings.gitBlameInline) return;
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
    if (!path || isUntitled) return;
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
    if (!path || isUntitled) return;
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
    if (!buffer || !containerRef.current) return;

    // Seed from the freshest store content — a disk revalidation may have
    // reloaded the buffer between mount and this (async) view creation.
    const originalContent =
      useEditorStore.getState().buffers[path]?.originalContent ?? buffer.originalContent;
    let cancelled = false;

    (async () => {
      const langExt = await loadLanguageExtension(buffer.language);
      if (cancelled) return;

      const view = new EditorView({
        doc: originalContent,
        extensions: [
          themeCompartment.of(
            editorThemeExtensions(useProjectStore.getState().settings.codeEditorTheme),
          ),
          langExt,
          lineNumbers(),
          diffGutter(),
          blameCompartment.of(
            useProjectStore.getState().settings.gitBlameInline ? blameInline() : [],
          ),
          highlightActiveLine(),
          drawSelection(),
          bracketMatching(),
          foldGutter(),
          indentOnInput(),
          history(),
          highlightSelectionMatches(),
          keymap.of([
            // Save is NOT bound here: it is the `editor-save` command, and its
            // chord is the user's to change. CodeMirror keeps only the editing
            // keymaps below, which are the editor's own behaviour rather than
            // Atlas commands.
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
          ]),
          // Debounced dirty check — never sync full content to store on keystroke
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
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
      const latest = useEditorStore.getState().buffers[path]?.originalContent;
      if (latest !== undefined) replaceViewDoc(latest);
      refreshDiffGutter();
      refreshBlameRef.current();
    })();

    return () => {
      cancelled = true;
      if (dirtyTimerRef.current) clearTimeout(dirtyTimerRef.current);
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
    };
  }, [path, !!buffer]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live-reskin the editor when the persisted theme changes — reconfigure the
  // theme compartment in place so the buffer/undo history survive.
  const codeEditorTheme = useProjectStore.use.settings().codeEditorTheme;
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartment.reconfigure(editorThemeExtensions(codeEditorTheme)),
    });
  }, [codeEditorTheme]);

  // Live-toggle inline blame: reconfigure the compartment in place; turning it
  // on also fetches a fresh snapshot (the extension starts empty).
  const gitBlameInline = useProjectStore.use.settings().gitBlameInline;
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
      <div className="h-full flex items-center justify-center text-text-tertiary text-sm">
        Loading...
      </div>
    );
  }

  const editorHeight =
    containerHeight > TOOLBAR_HEIGHT ? containerHeight - TOOLBAR_HEIGHT : window.innerHeight - 140;

  return (
    <div style={{ background: "#000000", height: containerHeight || "100%", overflow: "hidden" }}>
      {/* Breadcrumb toolbar */}
      <div
        className="flex items-center px-3 border-b border-border-default bg-bg-primary overflow-hidden"
        style={{ height: TOOLBAR_HEIGHT }}
      >
        <Breadcrumbs filePath={path} projectPath={projectPath} />
        {buffer.dirty && <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0 ml-2" />}
        {/* Right-hand controls. `ml-auto` on the group (rather than on whichever
            child happens to be present) keeps them pinned right no matter which
            of them render — the reload pill is conditional, and hanging the
            margin off it meant the layout changed shape when a file went stale
            on disk. */}
        <div className="ml-auto flex items-center gap-2 pl-2">
          {buffer.externallyChanged && (
            <button
              type="button"
              onClick={() => void forceReload()}
              title="This file changed on disk. Reload discards your unsaved edits."
              className="inline-flex items-center gap-1 h-[20px] px-2 rounded-full border border-border-default bg-bg-elevated text-[10px] font-medium text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors shrink-0"
            >
              <RefreshCw size={10} /> Disk changed · Reload
            </button>
          )}
          {isMarkdownFile && (
            <div className="inline-flex items-center h-[20px] rounded-full border border-border-default bg-bg-elevated p-[2px] text-[10px] font-medium shrink-0">
              <button
                type="button"
                onClick={() => setRenderMode("editor")}
                className={cn(
                  "px-2 h-full rounded-full transition-colors",
                  renderMode === "editor"
                    ? "bg-bg-hover text-text-primary"
                    : "text-text-secondary hover:text-text-primary",
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
                    ? "bg-bg-hover text-text-primary"
                    : "text-text-secondary hover:text-text-primary",
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
          <div style={{ height: editorHeight }} className="overflow-auto bg-bg-primary px-4 py-3">
            {buffer && (
              <MarkdownFile trusted={true} className="max-w-none">
                {buffer.originalContent}
              </MarkdownFile>
            )}
          </div>
        )}
      </div>
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
            {i > 0 && <ChevronRight size={10} className="text-text-tertiary mx-0.5 shrink-0" />}
            <span
              className={`text-[11px] font-mono ${isLast ? "text-text-primary" : "text-text-tertiary"}`}
            >
              {segment}
            </span>
          </span>
        );
      })}
    </div>
  );
}
