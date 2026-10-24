// The Tiptap editor both composers sit on: the session composer
// (`features/chat/components/chat-input.tsx`) and team chat.
//
// The core owns what every composer does the same way — the document model
// (`composer-doc.ts`), chips (`composer-chip.tsx`), picker triggers
// (`composer-triggers.ts`), keys (`composer-keymap.ts`), paste, the
// placeholder, and draft restore through `initialValue`. A feature brings its
// chip nodes, its serializer (what a chip's text is and how text becomes
// chips) and its pickers.
//
// Performance is the contract here, because this replaces CodeMirror on the
// app's hottest input:
//   - `shouldRerenderOnTransaction: false`. A keystroke re-renders no React at
//     all — not this component, not the feature above it. The document lives
//     in the editor and is serialized only when someone asks (`getValue`).
//   - What the parent needs per keystroke are edges: `onEmptyChange` fires
//     when "would send nothing" flips, from a check that stops at the first
//     non-space character (`isDocBlank`); `onDocChange` carries no payload, so
//     a debounced draft mirror costs a timer reset.
//   - The placeholder is the one piece of React that follows the document,
//     and it re-renders on the empty↔non-empty edge only.
//   - Chip views are memoized (`createChipNode`).
//   - Everything the editor reads from props it reads through refs, so the
//     editor is built once per mount and never torn down by a re-render.

import {
  forwardRef,
  memo,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { AnyExtension, Editor, JSONContent } from "@tiptap/core";
import { EditorContent, useEditor, type UseEditorOptions } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Fragment, Slice } from "@tiptap/pm/model";
import { Selection, TextSelection, type Transaction } from "@tiptap/pm/state";
import { invoke } from "@tauri-apps/api/core";

import { cn } from "@/lib/utils";
import { markInputActivity } from "@/lib/input-activity";
import { filesFromClipboard, hasFiles } from "@/lib/scratch-file";
import {
  docToText,
  fragmentToText,
  isDocBlank,
  isDocEmpty,
  isLargePaste,
  textOffsetToPos,
  textToDoc,
  textToParagraphs,
  type ComposerSerializer,
} from "./composer-doc";
import { ComposerKeymap } from "./composer-keymap";
import {
  ComposerTriggers,
  type ComposerKeyInterceptor,
  type ComposerTriggerSpec,
} from "./composer-triggers";

/** Transaction meta on a change the composer made through its handle rather
 *  than the user typing — `setValue`. A feature that only reacts to typing (a
 *  picker opening on `@`) skips these. */
export const PROGRAMMATIC = "atlasComposerProgrammatic";

export interface InsertChipOptions {
  /** Replace this range (a picker's `@query`); defaults to the selection. */
  from?: number;
  to?: number;
  /** Insert at the very start of the document instead. */
  atStart?: boolean;
  /** Put a space before the chip when the character before it is not one. */
  padBefore?: boolean;
}

export interface ComposerEditorHandle {
  focus(): void;
  blur(): void;
  /** The document as text. O(document) — call it when you need it. */
  getValue(): string;
  /** Replace the document, caret to the end — or to `selection`, as text
   *  offsets. Chips are rebuilt from tokens. One undo step. */
  setValue(text: string, selection?: { start: number; end: number }): void;
  clear(): void;
  /** Replace a range with plain text and put the caret after it. */
  replaceRange(from: number, to: number, text: string): void;
  /** Insert a chip, with a space after it so the next keystroke is not glued
   *  to it. */
  insertChip(name: string, data: unknown, opts?: InsertChipOptions): void;
  /** Insert text at the caret, tokenized like a paste. */
  insertText(text: string): void;
  /** The live editor, for a feature reading its own chips. */
  editor(): Editor | null;
}

export interface ComposerEditorProps {
  /** The feature's chip nodes and anything else it adds. Read on mount. */
  extensions: readonly AnyExtension[];
  /** Read on mount; keep it module-level or memoized. */
  serializer: ComposerSerializer;
  /** Read on mount: a restored draft. */
  initialValue?: string;
  placeholder?: string;
  ariaLabel?: string;
  /** The host element's class — where the feature's typography lives. */
  className?: string;
  /** Bare Enter sends (Shift+Enter is a newline); off, only ⌘Enter sends. */
  enterToSend?: boolean;
  onSubmit?: () => void;
  /** Escape, when no picker took it. Return true if it did something. */
  onEscape?: () => boolean;
  /** Edge-triggered: whether the document would trim to nothing. */
  onEmptyChange?: (blank: boolean) => void;
  /** Every document change. The transaction says whether it was typing
   *  (`PROGRAMMATIC`); a draft mirror ignores it. */
  onDocChange?: (transaction: Transaction) => void;
  /** Every keydown, before any binding of the composer's own. Return true to
   *  consume it. For a feature that keeps its key handling in one block. */
  onKeyDown?: (event: KeyboardEvent) => boolean;
  /** Every paste, before the composer's own handling. Return true if it was
   *  taken (a file the feature attaches its own way). */
  onPaste?: (event: ClipboardEvent) => boolean;
  triggers?: readonly ComposerTriggerSpec[];
  /** Offered picker keys first while a trigger is open. */
  keyInterceptor?: ComposerKeyInterceptor | null;
  /** Clipboard images, before anything else. Return true to consume. */
  onPasteImages?: (files: File[]) => boolean;
  /** Finder-copied files as absolute paths. Unset, the paths are pasted as
   *  text. */
  onPastePaths?: (paths: string[]) => void;
  /** Text over the large-paste limit (`isLargePaste`). Return true to take
   *  it as an attachment; false pastes it as text after all. */
  onPasteLargeText?: (text: string) => boolean;
}

/** Wrap a path in double quotes if it holds whitespace, so a reader takes it
 *  as one token. */
function quotePath(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}

/** The placeholder's own little store: the editor writes the empty bit, the
 *  overlay subscribes, and nothing else re-renders. */
function createFlag(initial: boolean) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: boolean) {
      if (next === value) return;
      value = next;
      for (const l of listeners) l();
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

const Placeholder = memo(function Placeholder({
  text,
  flag,
}: {
  text: string;
  flag: ReturnType<typeof createFlag>;
}) {
  const empty = useSyncExternalStore(flag.subscribe, flag.get);
  if (!empty || !text) return null;
  return (
    <div aria-hidden className="atlas-composer-placeholder">
      {text}
    </div>
  );
});

// Memoized: what a re-render could change is read through `live`, so a parent
// re-rendering (a picker opening, a status flip, a draft kept in a store) does
// not re-render the editor shell with it.
export const ComposerEditor = memo(
  forwardRef<ComposerEditorHandle, ComposerEditorProps>(function ComposerEditor(props, ref) {
    const {
      extensions,
      serializer,
      initialValue = "",
      placeholder = "",
      ariaLabel,
      className,
    } = props;

    // Every callback through a ref: the editor is built once, and reads
    // whatever the parent passed last.
    // Written after commit, never during render: a render React throws away
    // must not leave its props behind. Nothing reads `live` between the two.
    const live = useRef(props);
    useLayoutEffect(() => {
      live.current = props;
    });

    const [emptyFlag] = useState(() => createFlag(initialValue.length === 0));
    const blankRef = useRef(initialValue.trim().length === 0);

    // The options object is built once and kept. `useEditor` compares it with
    // the editor's on every render, and a fresh one (new extension instances,
    // new `editorProps`) makes it call `setOptions`, which re-runs the whole
    // view update — and `content` would re-tokenize the initial text. A
    // parent re-render must cost nothing here.
    const [options] = useState((): UseEditorOptions => ({
      immediatelyRender: true,
      shouldRerenderOnTransaction: false,
      extensions: [
        StarterKit.configure({
          blockquote: false,
          bold: false,
          bulletList: false,
          code: false,
          codeBlock: false,
          gapcursor: false,
          hardBreak: false,
          heading: false,
          horizontalRule: false,
          italic: false,
          link: false,
          listItem: false,
          listKeymap: false,
          orderedList: false,
          strike: false,
          trailingNode: false,
          underline: false,
        }),
        ComposerTriggers.configure({
          getTriggers: () => live.current.triggers ?? [],
          getKeyInterceptor: () => live.current.keyInterceptor ?? null,
        }),
        ComposerKeymap.configure({
          getEnterToSend: () => live.current.enterToSend ?? true,
          onSubmit: () => live.current.onSubmit?.(),
          onEscape: () => live.current.onEscape?.() ?? false,
        }),
        ...extensions,
      ],
      content: textToDoc(initialValue, serializer),
      editorProps: {
        attributes: {
          role: "textbox",
          "aria-multiline": "true",
          // No browser corrections in a prompt, as in CodeMirror: a path or
          // an identifier must arrive as typed.
          spellcheck: "false",
          autocorrect: "off",
          autocapitalize: "off",
          writingsuggestions: "false",
          ...(ariaLabel ? { "aria-label": ariaLabel } : {}),
        },
        // Copy writes the composer's own text — chips as their tokens, lines
        // joined by one newline — instead of ProseMirror's block-per-
        // paragraph default with blank lines between.
        clipboardTextSerializer: (slice) => fragmentToText(slice.content, serializer),
        // A plain-text drop (and a paste the handler below declines) goes
        // through the same tokenizer as a paste.
        clipboardTextParser: (text, _$context, _plain, view) =>
          textSlice(view.state.schema, text, serializer),
        handleKeyDown: (view, event) =>
          !view.composing && (live.current.onKeyDown?.(event) ?? false),
        handleDOMEvents: {
          // Stamp typing activity at the very start of key handling, so the
          // transcript's deferred markdown parse cannot slip a long task in
          // between a keydown and its edit (`input-activity.ts`).
          keydown: () => {
            markInputActivity();
            return false;
          },
        },
        handlePaste: (view, event) => {
          const p = live.current;
          if (p.onPaste?.(event)) return true;
          const dt = event.clipboardData;
          if (!dt) return false;
          // Clipboard images (screenshots) first. `filesFromClipboard` skips
          // Finder's zero-byte stubs — a copied `.png` file has an image mime
          // but no bytes, and must take the path route below instead.
          const images = filesFromClipboard(dt).filter((f) => f.type.startsWith("image/"));
          if (images.length > 0 && p.onPasteImages?.(images)) {
            event.preventDefault();
            markInputActivity();
            return true;
          }
          // Finder-copied files: the web paste event cannot expose a path, so
          // ask Rust for the native pasteboard's file URLs.
          if (hasFiles(dt)) {
            event.preventDefault();
            void (async () => {
              try {
                const paths = await invoke<string[]>("clipboard_file_paths");
                if (!paths || paths.length === 0) return;
                markInputActivity();
                if (live.current.onPastePaths) {
                  live.current.onPastePaths(paths);
                  return;
                }
                view.dispatch(view.state.tr.insertText(paths.map(quotePath).join(" ") + " "));
                view.focus();
              } catch (err) {
                console.warn("clipboard file paste failed:", err);
              }
            })();
            return true;
          }
          const text = dt.getData("text/plain").replace(/\r\n?/g, "\n");
          if (!text) return false;
          if (isLargePaste(text) && p.onPasteLargeText?.(text)) {
            event.preventDefault();
            markInputActivity();
            return true;
          }
          // Always the text flavour. Chips come back from their tokens
          // through the feature's serializer, which resolves them in the
          // current context: a chip record carried in HTML could name one
          // thing in its label and another in its data. And other HTML (a
          // web page, a code editor) would arrive with its whitespace
          // collapsed and its blocks flattened into lines the user did not
          // write.
          event.preventDefault();
          view.dispatch(
            view.state.tr
              .replaceSelection(textSlice(view.state.schema, text, serializer))
              .scrollIntoView()
              .setMeta("uiEvent", "paste"),
          );
          return true;
        },
      },
      onUpdate: ({ editor: e, transaction }) => {
        // Stamp activity so a deferred markdown parse waits out the burst.
        markInputActivity();
        const doc = e.state.doc;
        emptyFlag.set(isDocEmpty(doc));
        const blank = isDocBlank(doc);
        if (blank !== blankRef.current) {
          blankRef.current = blank;
          live.current.onEmptyChange?.(blank);
        }
        live.current.onDocChange?.(transaction);
      },
    }));
    const editor = useEditor(options, []);

    // A restored draft is one the user is about to continue: caret at the
    // end, not ProseMirror's default start. Here rather than in `onCreate`,
    // which Tiptap fires a task later — a paste or a keystroke that lands
    // first would go in at the start.
    useLayoutEffect(() => {
      editor.view.dispatch(
        editor.state.tr
          .setSelection(Selection.atEnd(editor.state.doc))
          .setMeta("addToHistory", false),
      );
    }, [editor]);

    useImperativeHandle(
      ref,
      (): ComposerEditorHandle => ({
        focus: () => editor.view.focus(),
        blur: () => (editor.view.dom as HTMLElement).blur(),
        getValue: () => docToText(editor.state.doc, serializer),
        setValue: (text, selection) => {
          const { state } = editor;
          const doc = state.schema.nodeFromJSON(textToDoc(text, serializer));
          const tr = state.tr.replaceWith(0, state.doc.content.size, doc.content);
          tr.setSelection(
            selection
              ? TextSelection.create(
                  tr.doc,
                  textOffsetToPos(tr.doc, selection.start, serializer),
                  textOffsetToPos(tr.doc, selection.end, serializer),
                )
              : Selection.atEnd(tr.doc),
          );
          editor.view.dispatch(tr.setMeta(PROGRAMMATIC, true).scrollIntoView());
        },
        clear: () => {
          editor.commands.clearContent(true);
        },
        replaceRange: (from, to, text) => {
          const tr = editor.state.tr.insertText(text, from, to);
          tr.setSelection(TextSelection.create(tr.doc, from + text.length));
          editor.view.dispatch(tr.scrollIntoView());
        },
        insertChip: (name, data, opts = {}) => {
          const { state } = editor;
          const schema = state.schema;
          const chip = schema.nodes[name]?.create({ data });
          if (!chip) return;
          let from = opts.from ?? state.selection.from;
          let to = opts.to ?? opts.from ?? state.selection.to;
          if (opts.atStart) from = to = Selection.atStart(state.doc).from;
          const nodes = [chip, schema.text(" ")];
          if (opts.padBefore && from > 1) {
            const before = state.doc.textBetween(from - 1, from, undefined, "￼");
            if (before && !/\s/.test(before)) nodes.unshift(schema.text(" "));
          }
          const tr = state.tr.replaceWith(from, to, nodes);
          const size = nodes.reduce((n, node) => n + node.nodeSize, 0);
          tr.setSelection(TextSelection.create(tr.doc, from + size));
          editor.view.dispatch(tr.scrollIntoView());
        },
        insertText: (text) => {
          editor.view.dispatch(
            editor.state.tr
              .replaceSelection(textSlice(editor.state.schema, text, serializer))
              .scrollIntoView(),
          );
        },
        editor: () => editor,
      }),
      [editor, serializer],
    );

    return (
      <div className={cn("atlas-composer", className)}>
        <EditorContent editor={editor} />
        <Placeholder text={placeholder} flag={emptyFlag} />
      </div>
    );
  }),
);

/** Text → a slice that opens into the current line at both ends, so a
 *  one-line paste lands inline and a multi-line one splits the line around
 *  itself exactly where the newlines are. */
function textSlice(schema: Editor["schema"], text: string, serializer: ComposerSerializer): Slice {
  const blocks = textToParagraphs(text, serializer).map((json: JSONContent) =>
    schema.nodeFromJSON(json),
  );
  return new Slice(Fragment.fromArray(blocks), 1, 1);
}
