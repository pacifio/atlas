import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import {
  DEFAULT_TOKENIZE_MAX_LENGTH,
  VirtualizedFile,
  getFiletypeFromFileName,
  type File as FileInstance,
  type FileContents,
  type PostRenderPhase,
  type SelectedLineRange,
} from "@pierre/diffs";
import { Editor, type EditorChangeEvent, type EditorFactory } from "@pierre/diffs/edit";
import type { WorkerPoolManager } from "@pierre/diffs/worker";
import { EditProvider, File, Virtualizer, useWorkerPool } from "@pierre/diffs/react";
import { isMac } from "@/lib/platform";
import { DIFF_THEME_NAMES } from "@/features/git/lib/diff-theme";
import {
  DiffWorkerPoolProvider,
  PREFERRED_HIGHLIGHTER,
  useDiffPoolFailed,
} from "@/features/git/components/diff-viewer/diff-worker-pool";
import {
  DIFF_VIEW_CSS,
  useDiffAppearance,
} from "@/features/git/components/diff-viewer/styled-code-view";
import { positionOfSelection, type EditorPosition } from "../lib/editor-views";
import { clampFileLine, resolveCenteredFileLineScrollTop } from "../lib/file-line-reveal";
import type { FileDecorations } from "../lib/file-decorations";
import type { FileCommentGroup, FileCommentsBinding } from "../lib/use-file-review-comments";
import { fileCacheKey } from "../lib/file-preview-mode";
import { revealSelection, type RevealTarget } from "../lib/reveal";
import {
  loadFirstScreenGrammar,
  missingFirstScreenGrammar,
  releaseFirstScreenCache,
} from "@/features/git/lib/first-screen-highlight";

/**
 * A file's text in `@pierre/diffs`: the `File` component in its virtualizer,
 * edited in place through the editor `EditProvider` attaches.
 *
 * Highlighting is the shared worker pool's: the file renders plain first and
 * fills in tokens as the workers return them, and only the rows near the
 * viewport exist. A long file's first screen is the exception, coloured on this
 * thread so it isn't plain while the workers work (`useFirstScreenRepaint`,
 * `first-screen-highlight.ts`). The editor highlights an active edit
 * session on the main thread, so the file becomes editable once the workers'
 * highlight has painted (`useEditableAfterHighlight`).
 *
 * The editor owns the document. What this component is given is the file as
 * it was read from disk, and a version that changes only when the document is
 * replaced from outside (a reload); edits echo back through `onChange` and
 * never through props, so typing re-renders nothing here or above.
 */

export interface CodeFileViewHandle {
  /** The live document, or undefined before the editor attaches. */
  getText: () => string | undefined;
  position: () => EditorPosition | undefined;
  focus: () => void;
  /** Whether the editor's own find panel can open: there is an editable
   *  editor. Not in read-only mode, nor before the workers' highlight lands. */
  canFind: () => boolean;
  /** Open the editor's find panel. False when there is no editor yet. */
  openFind: () => boolean;
}

export interface CodeFileViewProps {
  /** Names the file for its language. */
  name: string;
  /** The document as read from disk. */
  contents: string;
  /** Bumped when `contents` replaces the document from outside. */
  version: number;
  wordWrap: boolean;
  /** Read only: no editor attaches (a file too large to edit safely). */
  readOnly?: boolean;
  decorations: FileDecorations;
  reveal?: (RevealTarget & { nonce: number }) | undefined;
  onRevealed?: (nonce: number) => void;
  onChange: (
    contents: string,
    event: EditorChangeEvent<"file", FileCommentGroup, undefined>,
  ) => void;
  /** Comments on lines for the session beside the file
   *  (`use-file-review-comments.tsx`): drawn under their lines, and started
   *  from the gutter's `+` beside a line number or a drag down the numbers.
   *  Left out, the gutter has no `+`. */
  comments?: FileCommentsBinding | null;
  handleRef?: Ref<CodeFileViewHandle>;
}

type FilePostRender = (
  fileContainer: HTMLElement,
  instance: FileInstance<FileCommentGroup, undefined>,
  phase: PostRenderPhase,
) => void;

/** The virtualizer's own config: rows rendered past the viewport each way. */
const VIRTUALIZER_CONFIG = { overscrollSize: 600, intersectionObserverMargin: 1200 };

const REVEAL_MAX_ATTEMPTS = 30;
/**
 * After scrolling to the target, hold it for a short window so late
 * programmatic scroll resets (editable-editor focus and state restoration)
 * cannot silently snap the file back to the top.
 */
const REVEAL_GUARD_FRAMES = 20;
const REVEAL_GUARD_TOLERANCE_PX = 2;

interface FileRevealState {
  frameId: number | null;
  cancelGuard: (() => void) | null;
  handledNonce: number | null;
  latestNonce: number | null;
}

function useFileLineReveal(
  reveal: CodeFileViewProps["reveal"],
  onRevealed: (line: number, target: RevealTarget & { nonce: number }) => void,
): FilePostRender {
  const [state] = useState<FileRevealState>(() => ({
    frameId: null,
    cancelGuard: null,
    handledNonce: null,
    latestNonce: null,
  }));
  const latest = useRef({ reveal, onRevealed });
  latest.current = { reveal, onRevealed };

  return (fileContainer, instance, phase) => {
    const cancelPendingReveal = () => {
      if (state.frameId !== null) {
        cancelAnimationFrame(state.frameId);
        state.frameId = null;
      }
      state.cancelGuard?.();
    };

    if (phase === "unmount") {
      cancelPendingReveal();
      return;
    }
    if (!(instance instanceof VirtualizedFile)) return;

    const target = latest.current.reveal;
    if (target === undefined) {
      fileContainer.style.minHeight = "";
      return;
    }
    if (state.latestNonce !== target.nonce) {
      cancelPendingReveal();
      state.latestNonce = target.nonce;
      state.handledNonce = null;
    }

    // The virtualizer's root is the scroller, the surface's only child.
    const scrollContainer = fileContainer.closest<HTMLElement>("[data-file-view] > *");
    if (!scrollContainer) return;
    fileContainer.style.minHeight = `${Math.ceil(
      Math.max(instance.height, scrollContainer.clientHeight),
    )}px`;

    if (state.handledNonce === target.nonce || state.frameId !== null) return;

    const resolveScrollTarget = (line: number): number | null => {
      const linePosition = instance.getLinePosition(line);
      if (!linePosition) return null;

      const scrollContainerRect = scrollContainer.getBoundingClientRect();
      const fileTop =
        scrollContainer.scrollTop +
        fileContainer.getBoundingClientRect().top -
        scrollContainerRect.top;
      const root = fileContainer.shadowRoot ?? fileContainer;
      const renderedLineElement = root.querySelector<HTMLElement>(`[data-line="${line}"]`);
      const renderedLineRect = renderedLineElement?.getBoundingClientRect();

      return resolveCenteredFileLineScrollTop({
        scrollTop: scrollContainer.scrollTop,
        scrollHeight: scrollContainer.scrollHeight,
        viewportTop: scrollContainerRect.top,
        viewportHeight: scrollContainer.clientHeight,
        fileTop,
        estimatedLine: linePosition,
        ...(renderedLineRect && renderedLineRect.height > 0
          ? { renderedLine: { top: renderedLineRect.top, height: renderedLineRect.height } }
          : {}),
      });
    };

    const guardScrollTarget = (line: number) => {
      let framesLeft = REVEAL_GUARD_FRAMES;
      let guardFrameId: number | null = null;
      const cancelGuard = () => {
        if (guardFrameId !== null) {
          cancelAnimationFrame(guardFrameId);
          guardFrameId = null;
        }
        scrollContainer.removeEventListener("wheel", cancelGuard);
        scrollContainer.removeEventListener("touchstart", cancelGuard);
        scrollContainer.removeEventListener("pointerdown", cancelGuard, true);
        window.removeEventListener("keydown", cancelGuard, true);
        if (state.cancelGuard === cancelGuard) state.cancelGuard = null;
      };
      scrollContainer.addEventListener("wheel", cancelGuard, { passive: true });
      scrollContainer.addEventListener("touchstart", cancelGuard, { passive: true });
      // The viewer stops gutter pointer events from bubbling; listen in capture
      // so a click cancels the guard before anything else moves.
      scrollContainer.addEventListener("pointerdown", cancelGuard, {
        passive: true,
        capture: true,
      });
      window.addEventListener("keydown", cancelGuard, true);
      const holdTarget = () => {
        guardFrameId = null;
        framesLeft -= 1;
        if (framesLeft <= 0 || !scrollContainer.isConnected) {
          cancelGuard();
          return;
        }
        const targetTop = resolveScrollTarget(line);
        if (
          targetTop !== null &&
          Math.abs(scrollContainer.scrollTop - targetTop) > REVEAL_GUARD_TOLERANCE_PX
        ) {
          scrollContainer.scrollTop = targetTop;
        }
        guardFrameId = requestAnimationFrame(holdTarget);
      };
      guardFrameId = requestAnimationFrame(holdTarget);
      state.cancelGuard = cancelGuard;
    };

    const scheduleReveal = (attempt: number) => {
      state.frameId = requestAnimationFrame(() => {
        state.frameId = null;
        if (state.latestNonce !== target.nonce || !fileContainer.isConnected) return;

        // Contents and line metrics can lag the first post-render on fresh
        // mounts; clamping against missing contents would scroll to line 1
        // and wrongly mark the request handled.
        const currentContents = instance.file?.contents;
        const line =
          currentContents === undefined ? null : clampFileLine(currentContents, target.line);
        const targetTop = line === null ? null : resolveScrollTarget(line);
        if (line === null || targetTop === null) {
          if (attempt < REVEAL_MAX_ATTEMPTS) scheduleReveal(attempt + 1);
          return;
        }

        scrollContainer.scrollTop = targetTop;
        state.handledNonce = target.nonce;
        guardScrollTarget(line);
        latest.current.onRevealed(line, target);
      });
    };

    scheduleReveal(0);
  };
}

const createFileEditor: EditorFactory<FileCommentGroup, undefined> = (
  editorType,
  options,
  editStateKey,
) => new Editor(editorType, options, editStateKey);

/** Whether `contents` is short enough for the workers to tokenize. Counting
 *  stops at the limit, so a long file costs only that many `indexOf`s. */
function withinTokenizeLimit(contents: string): boolean {
  let lines = 1;
  for (
    let index = contents.indexOf("\n");
    index !== -1 && lines <= DEFAULT_TOKENIZE_MAX_LENGTH;
    index = contents.indexOf("\n", index + 1)
  ) {
    lines += 1;
  }
  return lines <= DEFAULT_TOKENIZE_MAX_LENGTH;
}

function needsWorkerHighlight(
  workerPool: WorkerPoolManager | undefined,
  file: FileContents,
  tokenizable: boolean,
) {
  if (workerPool?.isWorkingPool() !== true) return false;
  if ((file.lang ?? getFiletypeFromFileName(file.name)) === "text") return false;
  return tokenizable;
}

/**
 * The editor highlights an active edit session on the main thread, so each
 * version of the file becomes editable only once it has rendered the workers'
 * highlight.
 */
function useEditableAfterHighlight(file: FileContents) {
  const workerPool = useWorkerPool();
  const [highlightedFile, setHighlightedFile] = useState<FileContents | null>(null);
  // Once per version of the file, not on every render.
  const tokenizable = useMemo(() => withinTokenizeLimit(file.contents), [file.contents]);
  const needsHighlight = needsWorkerHighlight(workerPool, file, tokenizable);
  const ready = !needsHighlight || highlightedFile === file;

  useEffect(() => {
    if (ready || workerPool === undefined) return;
    workerPool.primeFileHighlightCache(file).catch(() => setHighlightedFile(file));
  }, [file, ready, workerPool]);

  const onPostRender = (renderedFile: FileContents | undefined, phase: PostRenderPhase) => {
    if (ready || phase === "unmount" || renderedFile?.cacheKey !== file.cacheKey) return;
    // The pool caches a result just before the instance renders it, so a
    // render that sees the cache has painted highlighted rows.
    if (workerPool?.getFileResultCache(file) !== undefined) setHighlightedFile(file);
  };
  return { ready, onPostRender };
}

/**
 * A long file's first screen is coloured on the main thread
 * (`first-screen-highlight.ts`), which needs the file's grammar loaded there.
 * When it isn't yet, the file renders plain at once and loads it. Once it
 * lands, if the workers' highlight hasn't, the rows on screen are drawn again,
 * coloured: `onThemeChange` drops the render cache and renders, which asks the
 * pool for the window afresh. Short files, and grammars already loaded, skip
 * all of this.
 */
function useFirstScreenRepaint(file: FileContents) {
  const workerPool = useWorkerPool();
  const instanceRef = useRef<FileInstance<FileCommentGroup, undefined> | null>(null);
  const [missing] = useState(() => ({ file, lang: missingFirstScreenGrammar(file) }));
  const lang = missing.file === file ? missing.lang : null;

  useEffect(() => {
    if (lang === null) return;
    let live = true;
    const repaint = () => {
      const instance = instanceRef.current;
      if (!live || !instance || instance.file?.cacheKey !== file.cacheKey) return;
      if (workerPool?.getFileResultCache(file) !== undefined) return;
      instance.onThemeChange();
    };
    loadFirstScreenGrammar(lang, DIFF_THEME_NAMES, PREFERRED_HIGHLIGHTER).then(repaint, () => {});
    return () => {
      live = false;
    };
  }, [file, lang, workerPool]);

  // The first-screen cache holds the whole text of the last long file it
  // coloured; a closed tab (or a replaced version) must not keep that alive.
  useEffect(() => () => releaseFirstScreenCache(file.cacheKey), [file]);

  return (instance: FileInstance<FileCommentGroup, undefined>, phase: PostRenderPhase) => {
    instanceRef.current = phase === "unmount" ? null : instance;
  };
}

/** The `<style>` the decorations are written into, in one viewer's root. */
const DECORATION_STYLE_ATTR = "data-atlas-file-decorations";

function decorationStyle(root: ShadowRoot | HTMLElement): HTMLStyleElement {
  let style = root.querySelector<HTMLStyleElement>(`style[${DECORATION_STYLE_ATTR}]`);
  if (!style) {
    style = document.createElement("style");
    style.setAttribute(DECORATION_STYLE_ATTR, "");
    root.appendChild(style);
  }
  return style;
}

/** A keydown the editor reads as "open find", for opening it from outside. */
function findKeyEvent(): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key: "f",
    code: "KeyF",
    metaKey: isMac,
    ctrlKey: !isMac,
    bubbles: true,
    composed: true,
    cancelable: true,
  });
}

export function CodeFileView(props: CodeFileViewProps) {
  return (
    <DiffWorkerPoolProvider>
      <EditableFileSurface {...props} />
    </DiffWorkerPoolProvider>
  );
}

function EditableFileSurface({
  name,
  contents,
  version,
  wordWrap,
  readOnly = false,
  decorations,
  reveal,
  onRevealed,
  onChange,
  comments = null,
  handleRef,
}: CodeFileViewProps) {
  const appearance = useDiffAppearance();
  // Plain text when the workers are down, or for a file too large to edit.
  const poolFailed = useDiffPoolFailed() || readOnly;
  const surfaceRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor<"file", FileCommentGroup, undefined> | null>(null);
  /** The viewer's container, for the decoration sheet and the find key. */
  const containerRef = useRef<HTMLElement | null>(null);

  // The editor owns the draft, so the file identity changes only when the
  // document is replaced from outside (`version`), never for its own edits.
  const [external, setExternal] = useState(() => ({
    version,
    poolFailed,
    file: fileContents(name, contents, poolFailed),
  }));
  if (external.version !== version || external.poolFailed !== poolFailed) {
    setExternal({ version, poolFailed, file: fileContents(name, contents, poolFailed) });
  }
  const file = external.file;
  const onFirstScreenPostRender = useFirstScreenRepaint(file);
  const { ready, onPostRender: onEditablePostRender } = useEditableAfterHighlight(file);
  const editable = ready && !readOnly;

  const latest = useRef({ onChange, onRevealed, decorations, comments });
  latest.current = { onChange, onRevealed, decorations, comments };
  // The lines a press or a drag on the numbers picked, drawn as picked
  // while the box under them is open.
  const [picked, setPicked] = useState<SelectedLineRange | null>(null);
  const writing = comments?.writing ?? false;
  const beginComment = (range: SelectedLineRange | null) => {
    if (!range || !latest.current.comments) return;
    // The box takes the keyboard: the editor's caret would otherwise stay
    // live under it.
    editorRef.current?.setSelections([]);
    setPicked(range);
    latest.current.comments.begin(range);
  };

  // ── Decorations: one stylesheet in the viewer's root, repainted per frame ──
  const paintFrame = useRef(0);
  useEffect(() => {
    const paint = () => {
      paintFrame.current = 0;
      const container = containerRef.current;
      if (!container) return;
      const style = decorationStyle(container.shadowRoot ?? container);
      const css = decorations.css();
      if (style.textContent !== css) style.textContent = css;
    };
    const schedule = () => {
      if (!paintFrame.current) paintFrame.current = requestAnimationFrame(paint);
    };
    schedule();
    const unsubscribe = decorations.subscribe(schedule);
    return () => {
      unsubscribe();
      if (paintFrame.current) cancelAnimationFrame(paintFrame.current);
      paintFrame.current = 0;
    };
  }, [decorations]);

  // ── The cursor line, for blame: read off the editor after input, per frame ──
  const cursorFrame = useRef(0);
  const readCursor = () => {
    if (cursorFrame.current) return;
    cursorFrame.current = requestAnimationFrame(() => {
      cursorFrame.current = 0;
      const selection = lastOf(editorRef.current?.getViewState().selections);
      latest.current.decorations.setCursorLine(
        selection ? positionOfSelection(selection).cursor.line : null,
      );
    });
  };
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    surface.addEventListener("keyup", readCursor);
    surface.addEventListener("pointerup", readCursor);
    return () => {
      surface.removeEventListener("keyup", readCursor);
      surface.removeEventListener("pointerup", readCursor);
      if (cursorFrame.current) cancelAnimationFrame(cursorFrame.current);
      cursorFrame.current = 0;
    };
    // `readCursor` reads everything through refs.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A pending reveal selects its target once the editor is there to hold it.
  const revealed = useRef<{ nonce: number; target: RevealTarget } | null>(null);
  const selectRevealed = () => {
    const editor = editorRef.current;
    const pending = revealed.current;
    if (!editor || !pending) return;
    revealed.current = null;
    editor.setSelections([revealSelection(pending.target)]);
    editor.focus({ preventScroll: true });
    readCursor();
  };

  const onFilePostRender = useFileLineReveal(reveal, (line, target) => {
    latest.current.decorations.setRevealLine(line);
    revealed.current = { nonce: target.nonce, target };
    selectRevealed();
    latest.current.onRevealed?.(target.nonce);
  });

  // The tint marks where a reveal landed until the reader moves on.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const clear = () => latest.current.decorations.setRevealLine(null);
    surface.addEventListener("pointerdown", clear, { capture: true });
    surface.addEventListener("keydown", clear, { capture: true });
    return () => {
      surface.removeEventListener("pointerdown", clear, { capture: true });
      surface.removeEventListener("keydown", clear, { capture: true });
    };
  }, []);

  useImperativeHandle(
    handleRef,
    () => ({
      getText: () => editorRef.current?.getText(),
      position: () => {
        const selection = lastOf(editorRef.current?.getViewState().selections);
        return selection ? positionOfSelection(selection) : undefined;
      },
      focus: () => editorRef.current?.focus({ preventScroll: true }),
      canFind: () =>
        !!editorRef.current &&
        !!containerRef.current?.shadowRoot?.querySelector("[contenteditable]"),
      openFind: () => {
        const editor = editorRef.current;
        const root = containerRef.current?.shadowRoot;
        const content = root?.querySelector<HTMLElement>("[contenteditable]");
        if (!editor || !content) return false;
        editor.focus({ preventScroll: true });
        content.dispatchEvent(findKeyEvent());
        return true;
      },
    }),
    [],
  );

  const handlePostRender: FilePostRender = (fileContainer, instance, phase) => {
    if (phase !== "unmount") {
      if (containerRef.current !== fileContainer) {
        containerRef.current = fileContainer;
        const style = decorationStyle(fileContainer.shadowRoot ?? fileContainer);
        style.textContent = latest.current.decorations.css();
      } else if (
        !(fileContainer.shadowRoot ?? fileContainer).querySelector(
          `style[${DECORATION_STYLE_ATTR}]`,
        )
      ) {
        decorationStyle(fileContainer.shadowRoot ?? fileContainer).textContent =
          latest.current.decorations.css();
      }
    }
    onFilePostRender(fileContainer, instance, phase);
    onEditablePostRender(instance.file, phase);
    onFirstScreenPostRender(instance, phase);
  };

  return (
    <EditProvider createEditor={createFileEditor}>
      <div ref={surfaceRef} className="flex min-h-0 flex-1" data-file-view>
        <Virtualizer
          className="min-h-0 flex-1 overflow-auto outline-none"
          config={VIRTUALIZER_CONFIG}
        >
          <File<FileCommentGroup>
            file={file}
            edit={editable}
            editorOptions={{
              onAttach: (editor) => {
                editorRef.current = editor;
                selectRevealed();
                readCursor();
              },
              onComplete: () => {
                editorRef.current = null;
              },
            }}
            onEditChange={(event) => {
              latest.current.decorations.applyChanges(event.changes);
              latest.current.onChange(event.file.contents, event);
              if (event.lineAnnotations) latest.current.comments?.onMoved(event.lineAnnotations);
              readCursor();
            }}
            options={{
              disableFileHeader: true,
              overflow: wordWrap ? "wrap" : "scroll",
              theme: DIFF_THEME_NAMES,
              themeType: appearance,
              preferredHighlighter: PREFERRED_HIGHLIGHTER,
              unsafeCSS: DIFF_VIEW_CSS,
              onPostRender: handlePostRender,
              enableGutterUtility: !!comments && !writing,
              enableLineSelection: !!comments && !writing,
              onGutterUtilityClick: beginComment,
              onLineSelectionEnd: beginComment,
            }}
            selectedLines={writing ? picked : null}
            lineAnnotations={comments?.lineAnnotations}
            renderAnnotation={comments?.renderAnnotation}
            className="min-h-full"
          />
        </Virtualizer>
      </div>
    </EditProvider>
  );
}

/** The primary selection: the editor keeps it last. */
function lastOf<T>(items: readonly T[] | undefined): T | undefined {
  return items && items.length > 0 ? items[items.length - 1] : undefined;
}

/** One version of the file for the viewer. A pool that failed to start means
 *  plain text: highlighting here would put every grammar on the UI thread. */
function fileContents(name: string, contents: string, plain: boolean): FileContents {
  return {
    name,
    contents,
    cacheKey: fileCacheKey(name, contents),
    ...(plain ? { lang: "text" as const } : {}),
  };
}
