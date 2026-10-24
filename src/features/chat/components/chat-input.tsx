// The session composer's editor: the shared Tiptap composer core
// (`components/composer/`) with the session's pieces on top — mention chips
// that write short forms (`session-mention-chip.tsx`,
// `composer-short-forms.ts`), the `@` / `~` mention trigger and the `/` slash
// trigger.
//
// Everything above this — pickers, attachments, drafts, send — is
// `message-input.tsx`. This file only adapts the core's generic triggers and
// chips to the session's types.

import { forwardRef, useImperativeHandle, useLayoutEffect, useMemo, useRef } from "react";

import {
  ComposerEditor,
  type ComposerEditorHandle,
  type InsertChipOptions,
} from "@/components/composer/composer-editor";
import { docChips } from "@/components/composer/composer-doc";
import type {
  ComposerKeyInterceptor,
  ComposerTriggerSpec,
} from "@/components/composer/composer-triggers";
import { SESSION_MENTION, sessionSerializer } from "../lib/composer-short-forms";
import { rememberMention } from "../lib/mention-registry";
import type { MentionData, MentionKind } from "../lib/mentions";
import {
  SessionMention,
  mentionOf,
  pickedChip,
  type SessionChipRecord,
} from "./session-mention-chip";

export interface MentionTrigger {
  /** Position of the trigger char (inclusive). */
  from: number;
  /** Caret position (exclusive). The typed query is between them. */
  to: number;
  query: string;
  /** Viewport coords of the trigger char — the popover's anchor. */
  anchor: { x: number; y: number };
  /** `~` opens locked to knowledge notes (the knowledge editor's shortcut);
   *  `@` opens unscoped. */
  scope: MentionKind | null;
}

export interface SlashTrigger {
  from: number;
  to: number;
  query: string;
  /** Is the `/` the document's first character? Only there does a
   *  passthrough command resolve — `claude-agent-acp` gates on
   *  `firstText.startsWith("/")` — so only there may selecting one send. */
  atStart: boolean;
  anchor: { x: number; y: number };
}

export interface ChatInputHandle {
  focus(): void;
  blur(): void;
  /** The prompt text, mentions as short forms. */
  getValue(): string;
  /** Replace the prompt, caret to the end; short forms come back as chips. */
  setValue(text: string): void;
  clear(): void;
  /** The mentions in the prompt, in reading order. */
  getMentions(): MentionData[];
  /** Insert a mention chip. With `from`/`to`, that range is replaced (a
   *  picker swallowing the `@query` the user typed). */
  insertMention(m: MentionData, opts?: InsertChipOptions): void;
  /** Take out every chip of `kind` with `id`; false when there was none. */
  removeMention(kind: MentionKind, id: string): boolean;
  /** Replace a range with text, caret after it. */
  replaceRange(from: number, to: number, text: string): void;
  /** Insert text at the caret, as a paste would. */
  insertText(text: string): void;
}

interface ChatInputProps {
  /** A restored draft. Read on mount. */
  initialValue?: string;
  placeholder?: string;
  /** Resolves a project-relative `@file:` token back into a chip. */
  projectPath?: string | null;
  /** Bare Enter sends (Shift+Enter is a newline); off, only ⌘Enter sends. */
  enterToSend?: boolean;
  onSubmit?: () => void;
  /** Edge-triggered: whether the prompt would trim to nothing. */
  onEmptyChange?: (blank: boolean) => void;
  /** Every document change, no payload. */
  onDocChange?: () => void;
  onMentionTrigger?: (trigger: MentionTrigger | null) => void;
  onSlashTrigger?: (trigger: SlashTrigger | null) => void;
  /** Up/Down/Enter/Escape/Backspace/Tab while a picker is open. Return true
   *  to swallow the key. */
  keyInterceptor?: ComposerKeyInterceptor | null;
  onPasteImages?: (files: File[]) => boolean;
  onPastePaths?: (paths: string[]) => void;
  onPasteLargeText?: (text: string) => boolean;
}

const EXTENSIONS = [SessionMention];

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
  {
    initialValue = "",
    placeholder = "Message Atlas... (@ to mention, / for commands)",
    projectPath = null,
    onMentionTrigger,
    onSlashTrigger,
    ...rest
  },
  ref,
) {
  const inner = useRef<ComposerEditorHandle>(null);
  const projectRef = useRef(projectPath);
  const mentionRef = useRef(onMentionTrigger);
  const slashRef = useRef(onSlashTrigger);
  // After commit, never during render (see `ComposerEditor`'s `live`).
  useLayoutEffect(() => {
    projectRef.current = projectPath;
    mentionRef.current = onMentionTrigger;
    slashRef.current = onSlashTrigger;
  });

  const serializer = useMemo(() => sessionSerializer(() => projectRef.current), []);

  // Stable specs (the core diffs per spec), each forwarding to the latest
  // callback.
  const triggers = useMemo(
    (): ComposerTriggerSpec[] => [
      {
        chars: "@~",
        onChange: (t) =>
          mentionRef.current?.(
            t && {
              from: t.from,
              to: t.to,
              query: t.query,
              anchor: t.anchor,
              scope: t.char === "~" ? "knowledge" : null,
            },
          ),
      },
      {
        chars: "/",
        onChange: (t) =>
          slashRef.current?.(
            t && { from: t.from, to: t.to, query: t.query, atStart: t.atStart, anchor: t.anchor },
          ),
      },
    ],
    [],
  );

  useImperativeHandle(
    ref,
    (): ChatInputHandle => ({
      focus: () => inner.current?.focus(),
      blur: () => inner.current?.blur(),
      getValue: () => inner.current?.getValue() ?? "",
      setValue: (text) => inner.current?.setValue(text),
      clear: () => inner.current?.clear(),
      getMentions: () => {
        const editor = inner.current?.editor();
        return editor
          ? docChips(editor.state.doc, SESSION_MENTION).map((n) =>
              mentionOf(n.attrs.data as SessionChipRecord),
            )
          : [];
      },
      insertMention: (m, opts) => {
        // Remembered so its short form becomes this chip again when the text
        // comes back (a draft restore, a paste of the composer's own text).
        // Every insert is the user's pick or drop, so the chip is `picked`.
        const chip = pickedChip(m);
        rememberMention(chip, projectRef.current);
        inner.current?.insertChip(SESSION_MENTION, chip, opts);
      },
      removeMention: (kind, id) => {
        const editor = inner.current?.editor();
        if (!editor) return false;
        const ranges: { from: number; to: number }[] = [];
        editor.state.doc.descendants((node, pos) => {
          if (node.type.name === SESSION_MENTION) {
            const data = node.attrs.data as SessionChipRecord;
            if (data.kind === kind && data.id === id) {
              ranges.push({ from: pos, to: pos + node.nodeSize });
            }
          }
          return !node.isInline;
        });
        if (ranges.length === 0) return false;
        // Last first, so the earlier positions still hold.
        let tr = editor.state.tr;
        for (const r of ranges.reverse()) tr = tr.delete(r.from, r.to);
        editor.view.dispatch(tr);
        return true;
      },
      replaceRange: (from, to, text) => inner.current?.replaceRange(from, to, text),
      insertText: (text) => inner.current?.insertText(text),
    }),
    [],
  );

  return (
    <ComposerEditor
      ref={inner}
      extensions={EXTENSIONS}
      serializer={serializer}
      initialValue={initialValue}
      placeholder={placeholder}
      ariaLabel="Chat message"
      className="atlas-chat-composer"
      triggers={onMentionTrigger || onSlashTrigger ? triggers : undefined}
      {...rest}
    />
  );
});
