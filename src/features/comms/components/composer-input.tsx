// The composer's text surface.
//
// A CodeMirror editor rather than the `<textarea>` this used to be, for exactly
// one reason: a mention has to look like a pill while the DOCUMENT still holds
// the `<@user_id>` token the server expects. A textarea's text is its display,
// so it could only ever show the raw id. See `../lib/cm-comms-mention`.
//
// Everything above this component is unchanged. It exposes the same three
// primitives the textarea did — `focus`, `getSelection`, `applyEdit` — so the
// markdown toolbar, the emoji picker and the mention picker keep working
// through the pure `{value, start, end}` helpers in `../lib/markdown-insert`
// and never learn that CodeMirror is here.
//
// Deliberately NOT loaded with the editor's language modes or theme: this is a
// chat input, not a code editor. No markdown highlighting, because the toolbar
// already shows what formatting is applied and colouring the source would make
// a two-line message look like a diff.

import { useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import { Annotation, EditorState, Prec } from "@codemirror/state";
import { history, historyKeymap } from "@codemirror/commands";
import { commsMentionExtension, setMentionDirectory } from "../lib/cm-comms-mention";
import type { OrgMemberProfile } from "../types";

/* Marks a dispatch the component made itself. The textarea only ran the
   change handler for real typing — a programmatic `value =` never did — and
   the mention picker depends on that: re-running detection after, say, a ⌘B
   wrap could pop the picker open around an `@` the user was not typing. */
const programmatic = Annotation.define<boolean>();

export interface ComposerInputHandle {
  focus: () => void;
  /** The shape every helper in `markdown-insert` takes. */
  getSelection: () => { value: string; start: number; end: number };
  /** Replace the whole document and place the caret, as setting
   *  `textarea.value` + `setSelectionRange` used to. */
  applyEdit: (edit: { value: string; start: number; end: number }) => void;
}

interface ComposerInputProps {
  value: string;
  placeholder: string;
  members: Map<string, OrgMemberProfile>;
  me: string;
  onChange: (value: string, caret: number) => void;
  /**
   * Every keydown, before CodeMirror sees it. Return true to consume it — the
   * mention picker and the formatting shortcuts do. Kept as one callback so
   * the parent's key handling stays in one readable block instead of being
   * scattered across keymap entries.
   */
  onKeyDown: (event: KeyboardEvent) => boolean;
  /** Return true if the paste was handled (a file, an image). */
  onPaste: (event: ClipboardEvent) => boolean;
  handle: React.RefObject<ComposerInputHandle | null>;
}

/* No `EditorView.theme` here on purpose.
 *
 * Every visual rule for this editor lives in `styles/globals.css` under
 * `.atlas-comms-cm-host`. Two reasons, both learned the hard way elsewhere in
 * this app: `@layer base` dresses any `.cm-editor` as a code editor, so the
 * rules have to be unlayered CSS to win (a runtime theme setting
 * `font-family: inherit` inherits the base layer's JetBrains Mono, which is
 * exactly how the mention pill ended up monospace); and CodeMirror injects a
 * theme as an inline <style>, which the bundled app's CSP nonce has blocked
 * before, leaving the composer completely unstyled. Keeping a theme here too
 * would just create declarations that look authoritative and do nothing.
 */

export function ComposerInput({
  value,
  placeholder,
  members,
  me,
  onChange,
  onKeyDown,
  onPaste,
  handle,
}: ComposerInputProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  // The callbacks change every render; the editor is built once. Reading them
  // through refs keeps both true.
  const onChangeRef = useRef(onChange);
  const onKeyDownRef = useRef(onKeyDown);
  const onPasteRef = useRef(onPaste);
  onChangeRef.current = onChange;
  onKeyDownRef.current = onKeyDown;
  onPasteRef.current = onPaste;

  const directory = useMemo(() => ({ members, me }), [members, me]);

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          EditorView.lineWrapping,
          cmPlaceholder(placeholder),
          commsMentionExtension,
          // Highest precedence: the mention picker has to win Enter, Tab and
          // the arrows before any default binding moves the caret.
          Prec.highest(keymap.of([{ any: (_view, event) => onKeyDownRef.current(event) }])),
          keymap.of(historyKeymap),
          EditorView.domEventHandlers({
            paste: (event) => onPasteRef.current(event),
          }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            // Our own dispatches are not typing.
            if (update.transactions.some((tr) => tr.annotation(programmatic))) return;
            onChangeRef.current(update.state.doc.toString(), update.state.selection.main.head);
          }),
          EditorView.contentAttributes.of({ "aria-label": placeholder }),
        ],
      }),
      parent: host.current,
    });
    viewRef.current = view;
    view.dispatch({ effects: setMentionDirectory.of(directory) });
    return () => {
      viewRef.current = null;
      view.destroy();
    };
    // Built once per mount. The composer is keyed by conversation upstream, so
    // `placeholder` never changes under a live editor; `value` is reconciled
    // by the effect below rather than by rebuilding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Names arrive after the roster loads, and a restored draft can be painted
  // before them. Repaint the chips when the directory changes.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setMentionDirectory.of(directory) });
  }, [directory]);

  // Reconcile the store's value into the document: a send clears it, an edit
  // loads a message into it, a draft restores it. Skipped when they already
  // agree, which is the case for every keystroke the user makes.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      selection: { anchor: value.length },
      annotations: programmatic.of(true),
    });
  }, [value]);

  useImperativeHandle(
    handle,
    () => ({
      focus: () => viewRef.current?.focus(),
      getSelection: () => {
        const view = viewRef.current;
        if (!view) return { value, start: value.length, end: value.length };
        const { from, to } = view.state.selection.main;
        return { value: view.state.doc.toString(), start: from, end: to };
      },
      applyEdit: (edit) => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: edit.value },
          selection: { anchor: edit.start, head: edit.end },
          annotations: programmatic.of(true),
        });
        view.focus();
      },
    }),
    [value],
  );

  return <div ref={host} className="atlas-comms-cm-host" />;
}
