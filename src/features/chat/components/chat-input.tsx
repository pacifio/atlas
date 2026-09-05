// CodeMirror 6 composer for the chat input. Replaces what used to be a
// `<textarea>` in `message-input.tsx`.
//
// Why CodeMirror instead of textarea: this composer needs to host real
// inline atomic chips (mention pills) that delete in one backspace, plus
// markdown bullet auto-indent. Both are very hard to do well over a plain
// textarea. CodeMirror is already a project dep (used by the file editor)
// so adding a thin wrapper here costs us nothing in bundle terms.
//
// This file intentionally has *no* mention awareness yet — the mention
// state field + chip widget extension lands in a follow-up and just plugs
// into the `extraExtensions` prop. Today this is "textarea + bullets".

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import { drawSelection, EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentMore,
  indentLess,
} from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";

import {
  mentionExtension,
  mentionTriggerPlugin,
  mentionKeymap,
  insertMention as insertMentionInView,
  getMentions as getMentionsFromView,
  type MentionKeyInterceptor,
  type MentionTrigger,
} from "../lib/cm-mention-extension";
import {
  slashTriggerPlugin,
  type SlashKeyInterceptor,
  type SlashTrigger,
} from "../lib/cm-slash-extension";
import type { MentionData } from "../lib/mentions";
import { markInputActivity } from "@/lib/input-activity";
import { invoke } from "@tauri-apps/api/core";

/** Wrap a path in double quotes if it contains whitespace, so the agent reads
 *  it as a single token. */
function quotePath(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}

export interface ChatInputHandle {
  focus(): void;
  blur(): void;
  getValue(): string;
  setValue(text: string): void;
  clear(): void;
  /** Read mentions registered with the current document. */
  getMentions(): MentionData[];
  /**
   * Insert a mention chip. If `from`/`to` are provided, that doc slice is
   * replaced (used when the picker commits and we want to swallow the
   * `@query` the user typed). Otherwise inserts at the caret.
   */
  insertMention(m: MentionData, from?: number, to?: number): void;
  /** Imperative dispatch — escape hatch for the mention extension to
   *  insert a chip into the buffer. Pass the raw view if you need more. */
  view(): EditorView | null;
}

interface ChatInputProps {
  /** Bound text. Reads it once on mount; changes via setValue/clear. */
  initialValue?: string;
  placeholder?: string;
  /** Fires on every doc change. Receives the plain text body. */
  onChange?: (value: string) => void;
  /** Fires on Cmd/Ctrl+Enter — the submit gesture. Also fires on bare Enter
   *  when `enterToSend` is true. */
  onSubmit?: () => void;
  /** When true (default), bare Enter submits and Shift+Enter inserts a
   *  newline — the Slack/Discord/ChatGPT convention. When false, Enter
   *  always inserts a newline and only Cmd/Ctrl+Enter submits (the old
   *  default). Read live via ref so toggling the setting takes effect
   *  without remounting the view. */
  enterToSend?: boolean;
  /** Fires whenever the `@` trigger range changes (open or close). */
  onMentionTrigger?: (trigger: MentionTrigger | null) => void;
  /** Fires whenever the `/` trigger range changes (open or close). */
  onSlashTrigger?: (trigger: SlashTrigger | null) => void;
  /**
   * Lookup function called for Up/Down/Enter/Escape **before** CodeMirror's
   * default keymap. Return `true` to swallow the key (picker is open and
   * handled it); return `false` to pass through to CM. Read at keypress
   * time so callers can change it without remounting the view.
   *
   * Wired to both the mention and slash keymaps — the parent decides which
   * picker is open and routes accordingly.
   */
  keyInterceptor?: MentionKeyInterceptor | null;
  /** Offered clipboard image files BEFORE the default file-paste handling.
   *  Return true to consume them (e.g. stage as inline attachments); false
   *  falls through to the path-paste path. Read live via ref. */
  onPasteImages?: (files: File[]) => boolean;
  /** Slot for future extensions. */
  extraExtensions?: Extension[];
  /** Min height in pixels (matches old textarea: 44). */
  minHeight?: number;
  /** Max height before vertical scroll kicks in (matches old: 200). */
  maxHeight?: number;
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
  {
    initialValue = "",
    placeholder = "Message Atlas... (@ to mention, / for commands)",
    onChange,
    onSubmit,
    enterToSend = true,
    onMentionTrigger,
    onSlashTrigger,
    keyInterceptor,
    onPasteImages,
    extraExtensions,
    minHeight = 44,
    maxHeight = 200,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Keep the latest callbacks in refs so the extensions captured at mount
  // can always reach the current handler without us tearing down the view
  // on every keystroke.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const enterToSendRef = useRef(enterToSend);
  enterToSendRef.current = enterToSend;
  const onMentionTriggerRef = useRef(onMentionTrigger);
  onMentionTriggerRef.current = onMentionTrigger;
  const onSlashTriggerRef = useRef(onSlashTrigger);
  onSlashTriggerRef.current = onSlashTrigger;
  const keyInterceptorRef = useRef<MentionKeyInterceptor | SlashKeyInterceptor | null | undefined>(
    keyInterceptor,
  );
  keyInterceptorRef.current = keyInterceptor;
  const onPasteImagesRef = useRef(onPasteImages);
  onPasteImagesRef.current = onPasteImages;

  // Build the theme once — sized to the container, transparent
  // background so the parent's chip rounding shows through.
  //
  // HEADS UP: seven declarations below are DEAD — `.atlas-chat-cm-host` in
  // `styles/globals.css` redeclares them and wins. Editing them here alone
  // does nothing. See that block for why; it is the authoritative copy.
  //   &: backgroundColor, fontSize, lineHeight
  //   .cm-scroller: fontFamily, minHeight
  //   .cm-content: padding
  //   .cm-line: padding
  // `.cm-selectionBackground` is dead too, for a different reason: globals.css
  // declares it `!important` inside `@layer base`, and for important
  // declarations the layer order inverts — layered beats unlayered.
  // Everything not in that list (color, maxHeight, caret, placeholder,
  // scrollbar hiding) is declared only here and does take effect.
  //
  // `minHeight` is the trap: it is a public PROP, so `<ChatInput minHeight={80}>`
  // type-checks, reads as configuration, and silently does nothing against
  // globals.css's hardcoded 44px. Drive the CSS from it or drop the prop.
  const theme = useMemo(
    () =>
      EditorView.theme(
        {
          "&": {
            backgroundColor: "transparent",
            color: "var(--text-primary)",
            fontSize: "13px",
            lineHeight: "1.55",
          },
          ".cm-scroller": {
            fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
            minHeight: `${minHeight}px`,
            maxHeight: `${maxHeight}px`,
            overflowY: "auto",
            // Hide the scrollbar (matches the app's `hide-scrollbar`
            // convention). The global ::-webkit-scrollbar reserves 8px of
            // layout width — with `overflow:auto` WebKit reveals that bar on
            // hover, which rewraps the text, flips the overflow condition,
            // and oscillates the composer for a couple frames (the hover
            // "flicker"). Removing the layout-taking bar kills it; content
            // still scrolls via wheel/trackpad.
            scrollbarWidth: "none",
          },
          ".cm-scroller::-webkit-scrollbar": {
            display: "none",
          },
          ".cm-content": {
            // Symmetric vertical padding: the input is its own card now (the
            // toolbar moved to the outer shell's footer), so the old slim 4px
            // bottom — tuned for a toolbar directly beneath — read as text
            // glued to the card's bottom edge on multi-line drafts. 12+20+12
            // also lands exactly on the 44px min height for one line.
            padding: "12px 16px",
            // Hide the native contenteditable caret — CodeMirror's own
            // `drawSelection` extension paints the visible cursor. Without
            // this, WebKit shows BOTH (the native blink + CM's div), which
            // looks like a double-caret glitch in the composer.
            caretColor: "transparent",
          },
          ".cm-line": {
            padding: "0",
          },
          "&.cm-focused": {
            outline: "none",
          },
          // Style CM's drawn cursor to match the theme.
          ".cm-cursor, .cm-dropCursor": {
            borderLeftColor: "var(--text-primary)",
            borderLeftWidth: "1px",
          },
          ".cm-placeholder": {
            color: "var(--text-tertiary)",
          },
          // Hide the active-line highlight; this is a chat composer, not
          // a source editor.
          ".cm-activeLine, .cm-activeLineGutter": {
            backgroundColor: "transparent",
          },
          ".cm-selectionBackground, ::selection": {
            background: "var(--selection-bg) !important",
          },
        },
        { dark: true },
      ),
    [minHeight, maxHeight],
  );

  const extensionsKey = extraExtensions ?? null;

  // One mount/unmount per component lifetime — the view itself is
  // mutated via dispatch, never recreated, to avoid losing focus and
  // selection state when callbacks change. Extension changes recompile
  // via `reconfigure`.
  useEffect(() => {
    const parent = containerRef.current;
    if (!parent) return;

    const submitKeymap = keymap.of([
      {
        key: "Mod-Enter",
        run: () => {
          onSubmitRef.current?.();
          return true;
        },
      },
      {
        // Tab on a bullet line indents the line; otherwise insert spaces
        // (kept as a soft-indent so users can still tab-navigate out).
        key: "Tab",
        run: (view) => {
          if (isOnListLine(view)) {
            return indentMore(view);
          }
          return false; // fall through to default Tab handling
        },
        shift: (view) => {
          if (isOnListLine(view)) {
            return indentLess(view);
          }
          return false;
        },
      },
    ]);

    // Enter-to-send. `Prec.high` places this above lang-markdown's Enter
    // (which would otherwise continue a bullet) but below the pickers'
    // `Prec.highest` keymap, so Enter still confirms an open @ / # / slash
    // selection instead of firing a send. Declaring no `shift` handler
    // leaves Shift+Enter to fall through to plain newline insertion.
    const enterSubmitKeymap = Prec.high(
      keymap.of([
        {
          key: "Enter",
          run: () => {
            if (!enterToSendRef.current) return false;
            onSubmitRef.current?.();
            return true;
          },
        },
      ]),
    );

    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: initialValue,
        // Seed the caret at the end of the seeded document so a draft
        // restored on tab switch doesn't drop the user at position 0.
        // CodeMirror's default is { anchor: 0 } which feels broken when
        // the composer remounts with prior typing.
        selection: { anchor: initialValue.length },
        extensions: [
          history(),
          // CM-managed caret + selection rendering. Pairs with
          // `caret-color: transparent` on `.cm-content` (see theme) to
          // eliminate the WebKit double-caret artifact.
          drawSelection(),
          // The markdown language pack ships an Enter binding that
          // continues `-` / `*` / `1.` bullets on the next line and
          // outdents on an empty marker — exactly the "type `- a` Enter
          // → `- ` on next line; empty bullet + Enter → outdent" UX.
          markdown({ base: markdownLanguage, addKeymap: true }),
          // Soft wrap so the composer feels like a textarea.
          EditorView.lineWrapping,
          submitKeymap,
          enterSubmitKeymap,
          keymap.of([...historyKeymap, ...defaultKeymap]),
          cmPlaceholder(placeholder),
          theme,
          EditorView.contentAttributes.of({
            "aria-label": "Chat message",
            role: "textbox",
            "aria-multiline": "true",
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              // Stamp typing activity so the chat's deferred markdown parse
              // (markdown-cache.tsx) won't fire a long highlight task in the
              // middle of a keystroke burst and stall the composer.
              markInputActivity();
              onChangeRef.current?.(u.state.doc.toString());
            }
          }),
          // Mark activity at the very start of key handling too — earlier
          // than the post-change updateListener — so a parse can't slip in
          // between keydown and the resulting doc change.
          EditorView.domEventHandlers({
            keydown: () => {
              markInputActivity();
              return false;
            },
            // Paste a Finder-copied file as its absolute path. The web paste
            // event can't expose the path (sandbox), so when the clipboard
            // carries file references we ask Rust to read the native
            // pasteboard's file URLs and insert them at the cursor. Plain
            // text/markdown pastes (no files) fall through to CodeMirror.
            paste: (event, view) => {
              const dt = event.clipboardData;
              // Clipboard images (screenshots) first: offer them to the
              // parent, which stages them as inline base64 attachments
              // when the agent supports image prompts. Unconsumed images
              // fall through to the path-paste below.
              const imageFiles = dt?.files
                ? Array.from(dt.files).filter((f) => f.type.startsWith("image/"))
                : [];
              if (imageFiles.length > 0 && onPasteImagesRef.current?.(imageFiles)) {
                event.preventDefault();
                markInputActivity();
                return true;
              }
              const hasFiles =
                !!dt &&
                (Array.from(dt.types).includes("Files") || (dt.files && dt.files.length > 0));
              if (!hasFiles) return false;
              event.preventDefault();
              void (async () => {
                try {
                  const paths = await invoke<string[]>("clipboard_file_paths");
                  if (!paths || paths.length === 0) return;
                  const text = paths.map(quotePath).join(" ") + " ";
                  const head = view.state.selection.main.head;
                  view.dispatch({
                    changes: { from: head, insert: text },
                    selection: { anchor: head + text.length },
                  });
                  markInputActivity();
                  view.focus();
                } catch (err) {
                  console.warn("clipboard file paste failed:", err);
                }
              })();
              return true;
            },
          }),
          ...mentionExtension,
          mentionTriggerPlugin((t) => onMentionTriggerRef.current?.(t)),
          slashTriggerPlugin((t) => onSlashTriggerRef.current?.(t)),
          // Prec.highest puts the picker keymap above lang-markdown's
          // Enter binding (which would otherwise continue a bullet) and
          // above the default Enter (which inserts a newline). The
          // mention and slash pickers share an interceptor signature —
          // the parent routes by which trigger state is non-null — so
          // one keymap fronts both pickers and we avoid running the
          // interceptor twice per keypress.
          Prec.highest(
            keymap.of(
              mentionKeymap(
                () => (keyInterceptorRef.current as MentionKeyInterceptor | null) ?? null,
              ),
            ),
          ),
          ...(extensionsKey ?? []),
        ],
      }),
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // `placeholder` / `theme` / `extensionsKey` are stable enough not to
    // bounce the view; if a caller needs to change them at runtime they
    // can call `.setValue("")` after a remount instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(
    ref,
    (): ChatInputHandle => ({
      focus: () => viewRef.current?.focus(),
      blur: () => viewRef.current?.contentDOM.blur(),
      getValue: () => viewRef.current?.state.doc.toString() ?? "",
      setValue: (text) => {
        const v = viewRef.current;
        if (!v) return;
        v.dispatch({
          changes: { from: 0, to: v.state.doc.length, insert: text },
        });
      },
      clear: () => {
        const v = viewRef.current;
        if (!v) return;
        v.dispatch({
          changes: { from: 0, to: v.state.doc.length, insert: "" },
        });
      },
      getMentions: () => (viewRef.current ? getMentionsFromView(viewRef.current) : []),
      insertMention: (m, from, to) => {
        const v = viewRef.current;
        if (!v) return;
        const head = v.state.selection.main.head;
        insertMentionInView(v, m, from ?? head, to ?? head);
      },
      view: () => viewRef.current,
    }),
    [],
  );

  return <div ref={containerRef} className="atlas-chat-cm-host" />;
});

/** Whether the current selection's main caret sits on a markdown bullet or
 *  ordered-list line. Used to gate the Tab indent/outdent behavior so
 *  Tab outside lists still inserts whatever the default handler wants. */
function isOnListLine(view: EditorView): boolean {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  return /^\s*([-*+]|\d+\.)\s/.test(line.text);
}
