// The team chat composer's text surface: the shared Tiptap composer core
// (`components/composer/`) with team chat's mention pills on top
// (`comms-mention-pill.tsx`, `../lib/comms-composer-doc.ts`).
//
// An editor rather than a `<textarea>` for one reason: a mention has to look
// like a pill while the TEXT still holds the `<@user_id>` token the server
// expects. A textarea's text is its display, so it could only ever show the
// raw id.
//
// Everything above this component works in plain strings, and this keeps it
// that way. It exposes the three primitives the textarea did — `focus`,
// `getSelection`, `applyEdit` — so the markdown toolbar, the emoji picker and
// the mention picker keep working through the pure `{value, start, end}`
// helpers in `../lib/markdown-insert`, and never learn an editor is here.
// Offsets in those shapes are offsets into the wire text, pills counted as
// their whole token.
//
// Deliberately plain: no markdown marks, no highlighting. The toolbar already
// shows what formatting is applied, and colouring the source would make a
// two-line message look like a diff.

import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Transaction } from "@tiptap/pm/state";

import {
  ComposerEditor,
  PROGRAMMATIC,
  type ComposerEditorHandle,
} from "@/components/composer/composer-editor";
import { docChips, docToText, posToTextOffset } from "@/components/composer/composer-doc";
import { COMMS_MENTION, commsSerializer } from "../lib/comms-composer-doc";
import type { OrgMemberProfile } from "../types";
import { CommsDirectoryContext, CommsMention, CommsMentionPills } from "./comms-mention-pill";

export interface ComposerInputHandle {
  focus: () => void;
  /** The shape every helper in `markdown-insert` takes. */
  getSelection: () => { value: string; start: number; end: number };
  /** Replace the whole text and place the selection, as setting
   *  `textarea.value` + `setSelectionRange` used to. */
  applyEdit: (edit: { value: string; start: number; end: number }) => void;
}

interface ComposerInputProps {
  value: string;
  placeholder: string;
  members: Map<string, OrgMemberProfile>;
  me: string;
  /** The user typed. Not called for `value` coming back in, or for
   *  `applyEdit` — the mention picker depends on that: re-running detection
   *  after, say, a ⌘B wrap could pop it open around an `@` the user was not
   *  typing. */
  onChange: (value: string, caret: number) => void;
  /**
   * Every keydown, before the editor's own keys. Return true to consume it —
   * the mention picker and the formatting shortcuts do. Kept as one callback
   * so the parent's key handling stays in one readable block.
   */
  onKeyDown: (event: KeyboardEvent) => boolean;
  /** Return true if the paste was handled (a file, an image). */
  onPaste: (event: ClipboardEvent) => boolean;
  /** Text over the large-paste limit. Return true to take it as an
   *  attachment. */
  onPasteLargeText?: (text: string) => boolean;
  handle: React.RefObject<ComposerInputHandle | null>;
}

export function ComposerInput({
  value,
  placeholder,
  members,
  me,
  onChange,
  onKeyDown,
  onPaste,
  onPasteLargeText,
  handle,
}: ComposerInputProps) {
  const inner = useRef<ComposerEditorHandle>(null);
  const membersRef = useRef(members);
  // The parent re-renders on every keystroke (the draft lives in its store)
  // and hands down fresh callbacks each time. The editor gets stable ones
  // that call the latest, so those re-renders stop at this component.
  const latest = useRef({ onChange, onKeyDown, onPaste, onPasteLargeText });
  // After commit, never during render (see `ComposerEditor`'s `live`).
  useLayoutEffect(() => {
    membersRef.current = members;
    latest.current = { onChange, onKeyDown, onPaste, onPasteLargeText };
  });
  const [stable] = useState(() => ({
    onKeyDown: (e: KeyboardEvent) => latest.current.onKeyDown(e),
    onPaste: (e: ClipboardEvent) => latest.current.onPaste(e),
    onPasteLargeText: (text: string) => latest.current.onPasteLargeText?.(text) ?? false,
  }));
  const [initialValue] = useState(value);

  // Built once: the serializer and the pill plugin read the roster live.
  const serializer = useMemo(() => commsSerializer(() => membersRef.current), []);
  const extensions = useMemo(
    () => [CommsMention, CommsMentionPills.configure({ getMembers: () => membersRef.current })],
    [],
  );

  // The text as of the last time the two sides agreed — what the user last
  // typed, or what last came in. `value` echoing it back (every keystroke
  // does, through the store) costs a string compare, not a serialization.
  const synced = useRef(value);

  const [onDocChange] = useState(() => (tr: Transaction) => {
    const editor = inner.current?.editor();
    if (!editor || tr.getMeta(PROGRAMMATIC)) return;
    const text = docToText(editor.state.doc, serializer);
    synced.current = text;
    latest.current.onChange(
      text,
      posToTextOffset(editor.state.doc, editor.state.selection.head, serializer),
    );
  });

  // Reconcile the store's value into the document: a send clears it, an edit
  // loads a message into it, a draft restores it.
  useEffect(() => {
    if (value === synced.current) return;
    synced.current = value;
    inner.current?.setValue(value);
  }, [value]);

  // Names arrive after the roster loads, and a restored draft can be painted
  // before them: an id nobody could name stayed text, and may be a pill now.
  // Existing pills repaint by themselves (they read the directory at render).
  useEffect(() => {
    const editor = inner.current?.editor();
    if (!editor) return;
    const text = docToText(editor.state.doc, serializer);
    const wanted = serializer.tokenize(text.split("\n")).flat();
    const pills = wanted.filter((n) => n.type === COMMS_MENTION).length;
    if (pills === docChips(editor.state.doc, COMMS_MENTION).length) return;
    const { from, to } = editor.state.selection;
    inner.current?.setValue(text, {
      start: posToTextOffset(editor.state.doc, from, serializer),
      end: posToTextOffset(editor.state.doc, to, serializer),
    });
  }, [members, serializer]);

  useImperativeHandle(
    handle,
    () => ({
      focus: () => inner.current?.focus(),
      getSelection: () => {
        const editor = inner.current?.editor();
        if (!editor) return { value, start: value.length, end: value.length };
        const { doc, selection } = editor.state;
        return {
          value: docToText(doc, serializer),
          start: posToTextOffset(doc, selection.from, serializer),
          end: posToTextOffset(doc, selection.to, serializer),
        };
      },
      applyEdit: (edit) => {
        synced.current = edit.value;
        inner.current?.setValue(edit.value, { start: edit.start, end: edit.end });
        inner.current?.focus();
      },
    }),
    [value, serializer],
  );

  const directory = useMemo(() => ({ members, me }), [members, me]);

  return (
    <CommsDirectoryContext.Provider value={directory}>
      <ComposerEditor
        ref={inner}
        extensions={extensions}
        serializer={serializer}
        initialValue={initialValue}
        placeholder={placeholder}
        ariaLabel={placeholder}
        className="atlas-comms-composer"
        // Enter is the parent's (`onKeyDown` sends); what reaches the
        // composer's own keymap is Shift+Enter, a newline.
        enterToSend={false}
        onDocChange={onDocChange}
        onKeyDown={stable.onKeyDown}
        onPaste={stable.onPaste}
        onPasteLargeText={stable.onPasteLargeText}
      />
    </CommsDirectoryContext.Provider>
  );
}
