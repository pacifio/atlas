/**
 * A file's text in CodeMirror: the code editor.
 *
 * The UI overhaul (PR 495) replaced this with a view on `@pierre/diffs`, a diff
 * library, and the file tab lost what an editor is for — the default keymap,
 * undo history, Tab indent, bracket matching, folding, ⌘F search. This brings
 * the pre-overhaul editor back (its extensions, change bars and inline blame,
 * `languages.ts`, `diff-gutter.ts`, `blame-inline.ts`, `cm-reveal.ts`), behind
 * the handle the editor panel already drives, so the panel's loading, saving,
 * disk reconciling, previews and breadcrumbs work unchanged around it.
 *
 * CodeMirror owns the document (docs/architecture.md): the panel asks for the
 * text when it needs it and is told of every edit (`onChange`, synchronously —
 * the save coordinator writes the last text it was given, so a debounce here
 * could save a stale document on ⌘S).
 */

import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, indentOnInput } from "@codemirror/language";
import { highlightSelectionMatches, openSearchPanel, searchKeymap } from "@codemirror/search";
import type { DiffLineStatus } from "@/features/git/lib/git-diff-api";
import type { BlameLine } from "@/features/git/lib/git-blame-api";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { editorThemeExtensions } from "../themes/build-cm-theme";
import { applyBlame, blameInline } from "../lib/blame-inline";
import { applyDiffStatus, diffGutter } from "../lib/diff-gutter";
import { detectLanguage, loadLanguageExtension, PLAINTEXT } from "../lib/languages";
import { applyReveal } from "../lib/cm-reveal";
import type { EditorPosition } from "../lib/editor-views";
import type { RevealTarget } from "../lib/reveal";

export interface CodeMirrorFileViewHandle {
  /** The live document, or undefined before the editor attaches. */
  getText: () => string | undefined;
  position: () => EditorPosition | undefined;
  focus: () => void;
  /** Whether ⌘F can open the editor's own search panel. */
  canFind: () => boolean;
  /** Open the editor's search panel. False when there is no editor yet. */
  openFind: () => boolean;
  /** Paint the change bars from git's line status. */
  setDiffStatus: (status: DiffLineStatus) => void;
  /** Hand the inline blame its per-line snapshot. */
  setBlame: (lines: BlameLine[]) => void;
}

export interface CodeMirrorFileViewProps {
  /** Names the file for its language. */
  name: string;
  /** The document as read from disk. */
  contents: string;
  /** Bumped when `contents` replaces the document from outside. */
  version: number;
  wordWrap: boolean;
  /** Read only, and unhighlighted: a file too large to edit safely. */
  readOnly?: boolean;
  /** Inline blame at the end of the cursor's line (`gitBlameInline`). */
  blame: boolean;
  reveal?: (RevealTarget & { nonce: number }) | undefined;
  onRevealed?: (nonce: number) => void;
  onChange: (contents: string) => void;
  /** The view exists: paint what was fetched for it (change bars, blame). */
  onReady?: () => void;
  handleRef?: Ref<CodeMirrorFileViewHandle | null>;
}

export function CodeMirrorFileView({
  name,
  contents,
  version,
  wordWrap,
  readOnly = false,
  blame,
  reveal,
  onRevealed,
  onChange,
  onReady,
  handleRef,
}: CodeMirrorFileViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Per view, so two open files never share a compartment.
  const compartments = useRef({
    theme: new Compartment(),
    wrap: new Compartment(),
    blame: new Compartment(),
    readOnly: new Compartment(),
  }).current;
  // Bumped when the view is built, so the effects waiting on it run then.
  const [viewReady, setViewReady] = useState(0);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  // What the latest props asked for, read when the (async) view is built.
  const latest = useRef({ contents, wordWrap, blame, readOnly });
  latest.current = { contents, wordWrap, blame, readOnly };

  useImperativeHandle(
    handleRef,
    () => ({
      getText: () => viewRef.current?.state.doc.toString(),
      position: () => {
        const view = viewRef.current;
        if (!view) return undefined;
        const { main } = view.state.selection;
        const at = (pos: number) => {
          const line = view.state.doc.lineAt(pos);
          return { line: line.number, col: pos - line.from + 1 };
        };
        const cursor = at(main.head);
        return main.empty
          ? { cursor }
          : { cursor, selection: { from: at(main.from), to: at(main.to) } };
      },
      focus: () => viewRef.current?.focus(),
      canFind: () => viewRef.current !== null,
      openFind: () => {
        const view = viewRef.current;
        if (!view) return false;
        openSearchPanel(view);
        return true;
      },
      setDiffStatus: (status) => {
        if (viewRef.current) applyDiffStatus(viewRef.current, status);
      },
      setBlame: (lines) => {
        if (viewRef.current) applyBlame(viewRef.current, lines);
      },
    }),
    [],
  );

  // Build the view once per file. The language loads first (each grammar is
  // its own lazy chunk); a large file skips it and opens read-only.
  useLayoutEffect(() => {
    const parent = containerRef.current;
    if (!parent) return;
    let cancelled = false;
    void (async () => {
      const seed = latest.current;
      const language = seed.readOnly ? PLAINTEXT : detectLanguage(name);
      const langExt = await loadLanguageExtension(language);
      if (cancelled) return;
      const now = latest.current;
      const view = new EditorView({
        doc: now.contents,
        parent,
        extensions: [
          compartments.theme.of(editorThemeExtensions()),
          langExt,
          lineNumbers(),
          highlightActiveLineGutter(),
          diffGutter(),
          compartments.blame.of(now.blame ? blameInline() : []),
          highlightActiveLine(),
          drawSelection(),
          bracketMatching(),
          foldGutter(),
          indentOnInput(),
          history(),
          highlightSelectionMatches(),
          compartments.wrap.of(now.wordWrap ? EditorView.lineWrapping : []),
          compartments.readOnly.of(
            now.readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [],
          ),
          keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
          EditorState.tabSize.of(2),
        ],
      });
      viewRef.current = view;
      setViewReady((n) => n + 1);
      onReadyRef.current?.();
    })();
    return () => {
      cancelled = true;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
    // One view per file: the panel keys this component by path.
  }, [name]);

  // A document replaced from outside (a reload from disk): swapped in without
  // an undo step, so ⌘Z cannot "undo" the file back to what it no longer is.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (view.state.doc.toString() === contents) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: contents },
      annotations: Transaction.addToHistory.of(false),
    });
    // `contents` is the panel's buffer, which only changes with `version`.
  }, [version, viewReady]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.wrap.reconfigure(wordWrap ? EditorView.lineWrapping : []),
    });
  }, [wordWrap, viewReady, compartments]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.blame.reconfigure(blame ? blameInline() : []),
    });
  }, [blame, viewReady, compartments]);

  // Open at a line: once the view exists, select the target and centre it.
  useEffect(() => {
    const view = viewRef.current;
    if (!reveal || !view) return;
    applyReveal(view, reveal);
    onRevealed?.(reveal.nonce);
  }, [reveal, viewReady, onRevealed]);

  // Re-skin in place when the theme changes, so the document and its undo
  // history survive.
  const themeLight = useSettingsStore.use.settings().themeLight;
  const themeDark = useSettingsStore.use.settings().themeDark;
  useEffect(() => {
    const refresh = () =>
      viewRef.current?.dispatch({
        effects: compartments.theme.reconfigure(editorThemeExtensions()),
      });
    refresh();
    window.addEventListener("atlas:theme-applied", refresh);
    return () => window.removeEventListener("atlas:theme-applied", refresh);
  }, [themeLight, themeDark, viewReady, compartments]);

  return (
    <div
      ref={containerRef}
      // The panel's ⌘F handler leaves the key to the editor's own search while
      // focus is in here.
      data-file-view
      className="relative min-h-0 min-w-0 flex-1 overflow-hidden [&_.cm-editor]:h-full [&_.cm-scroller]:overflow-auto"
    />
  );
}
