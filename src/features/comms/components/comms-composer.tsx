import { useEffect, useMemo, useRef, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { filesFromClipboard, hasFiles, scratchPathForFile } from "@/lib/scratch-file";
import { useCommsStore } from "../stores/comms-store";
import { CommsAvatar } from "./comms-avatar";
import type {
  ComposerInput as ComposerInputComponent,
  ComposerInputHandle,
} from "./composer-input";
import {
  CommsComposerView,
  type ComposerFormat,
  type ComposerIntent,
} from "./views/comms-composer-view";
import {
  insertLink,
  insertText,
  linePrefix,
  wrap,
  type Edit,
  type Selection,
} from "../lib/markdown-insert";
import { utf8Bytes } from "../lib/derive";
import { authorLabel } from "../lib/message-author";
import { toPlainText } from "../lib/to-plain-text";
import { CHAT_BODY_MAX_BYTES, CHAT_MESSAGE_ATTACHMENT_MAX } from "../types";
import type { CommsMessage, OrgMemberProfile, PendingAttachment } from "../types";

// Start the editor chunk downloading as soon as this module evaluates, but
// keep it a DYNAMIC import: a static one would put Tiptap and ProseMirror in
// the comms panel's own chunk, so opening team chat would block on them. The
// session composer does exactly this for the same reason
// (`chat/components/message-input.tsx`). One promise, shared by every
// composer instance.
const composerInputPromise: Promise<typeof import("./composer-input")> = import("./composer-input");

interface ComposerProps {
  convId: string;
  members: OrgMemberProfile[];
  memberMap: Map<string, OrgMemberProfile>;
  lookup: (id: string) => CommsMessage | undefined;
  placeholder: string;
  /** A file drag is over the conversation — the shell lights up. The drop
   *  target itself is the whole conversation column (see `CommsConversation`),
   *  not this shell, so the composer only renders the state. */
  dropActive?: boolean;
}

const EMPTY_COMPOSER = {
  draft: "",
  replyTo: null as string | null,
  editing: null as string | null,
  attachments: [] as PendingAttachment[],
};

/**
 * The team-chat composer: the editor, the store slice, paste and upload, the
 * mention picker's state and the keys. `views/comms-composer-view.tsx` draws
 * it. The body stays plain text carrying `<@id>` tokens; the editor only
 * paints them as pills (`composer-input.tsx`).
 *
 * Two limits are contract-driven, not taste: the body cap is counted in UTF-8
 * BYTES (emoji and CJK cost 3–4×, and a character counter would let someone
 * write a message the server then refuses), and the mention picker inserts the
 * `<@user_id>` token form so a later rename changes rendering, never history.
 */
export function CommsComposer({
  convId,
  members,
  memberMap,
  lookup,
  placeholder,
  dropActive = false,
}: ComposerProps) {
  // The composer subscribes to ITS OWN slice. When this lived in the
  // conversation component, every keystroke — and every upload-progress tick —
  // re-rendered the entire transcript above it.
  const composer = useCommsStore((s) => s.composers[convId]) ?? EMPTY_COMPOSER;
  const { draft, replyTo, editing, attachments } = composer;
  const actions = useCommsStore.use.actions();
  // Only so a mention of YOU reads differently in the pill, as it does in the
  // rendered message.
  const me = useCommsStore.use.me();
  const onChange = (value: string) => actions.setDraft(convId, value);
  const onSend = () => actions.send(convId);
  const onCommitEdit = () => actions.commitEdit(convId);
  const onCancelIntent = () => actions.cancelComposerIntent(convId);
  const onRemoveAttachment = (uploadId: string) => actions.removeAttachment(convId, uploadId);
  const onPickFiles = () => {
    void (async () => {
      try {
        // Multi-select — a message carries up to ten attachments.
        const picked = await openFileDialog({ multiple: true });
        if (!picked) return;
        actions.attachFiles(convId, Array.isArray(picked) ? picked : [picked]);
      } catch (e) {
        console.warn("comms: file picker failed:", e);
      }
    })();
  };
  const input = useRef<ComposerInputHandle>(null);
  const [Input, setInput] = useState<typeof ComposerInputComponent | null>(null);
  useEffect(() => {
    let cancelled = false;
    void composerInputPromise.then((m) => {
      if (!cancelled) setInput(() => m.ComposerInput);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const [mentionQuery, setMentionQuery] = useState<{ start: number; query: string } | null>(null);
  const [highlighted, setHighlighted] = useState(0);

  const bytes = utf8Bytes(draft);
  const overLimit = bytes > CHAT_BODY_MAX_BYTES;
  const uploading = attachments.some((a) => a.state === "uploading");
  const ready = attachments.filter((a) => a.state === "complete" && a.fileId);
  // An empty body is legal with at least one attachment — a screenshot with no
  // caption is the ordinary case.
  const canSend = (draft.trim().length > 0 || ready.length > 0) && !overLimit && !uploading;

  // Paste: a screenshot (bytes, no path) is spooled to a scratch file; a
  // Finder-copied file (a name but no bytes in the web sandbox) is resolved
  // through the native pasteboard; anything else is text and pastes as usual.
  /** Returns true when the paste was a file and the text insert must not run. */
  const handlePaste = (e: ClipboardEvent): boolean => {
    const dt = e.clipboardData;
    const files = filesFromClipboard(dt);
    if (files.length > 0) {
      e.preventDefault();
      void Promise.all(files.map(scratchPathForFile))
        .then((paths) => actions.attachFiles(convId, paths))
        .catch((err) => {
          console.warn("comms: paste failed:", err);
          toast.error(typeof err === "string" ? err : "Could not paste that file.");
        });
      return true;
    }
    if (hasFiles(dt)) {
      e.preventDefault();
      void invoke<string[]>("clipboard_file_paths")
        .then((paths) => {
          if (paths.length > 0) actions.attachFiles(convId, paths);
        })
        .catch((err) => console.warn("comms: clipboard paths failed:", err));
      return true;
    }
    return false;
  };

  // A wall of text (a log, a whole file) goes up as a file rather than into
  // the body, where it would blow the byte cap and every later keystroke
  // would pay for its layout. Same scratch path as a pasted screenshot.
  const handlePasteLargeText = (text: string): boolean => {
    const lines = text.split("\n").length;
    const file = new File([text], `pasted-text-${lines}-lines-${Date.now()}.txt`, {
      type: "text/plain",
    });
    void scratchPathForFile(file)
      .then((path) => actions.attachFiles(convId, [path]))
      .catch((err) => {
        console.warn("comms: large paste failed:", err);
        toast.error(typeof err === "string" ? err : "Could not attach that paste.");
      });
    return true;
  };

  // Focus on conversation switch and when an edit or reply is started.
  useEffect(() => {
    input.current?.focus();
  }, [convId, replyTo, editing]);

  const matches = useMemo(() => {
    if (!mentionQuery) return [];
    const q = mentionQuery.query.toLowerCase();
    return members
      .filter((m) => m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q))
      .slice(0, 6);
  }, [members, mentionQuery]);

  useEffect(() => setHighlighted(0), [mentionQuery?.query]);

  const handleChange = (value: string, caret: number) => {
    onChange(value);
    setMentionQuery(detectMention(value, caret));
  };

  /** Apply a pure edit and put the caret back where it belongs. */
  const applyEdit = (edit: Edit) => {
    onChange(edit.value);
    input.current?.applyEdit(edit);
  };

  const selection = () =>
    input.current?.getSelection() ?? {
      value: draft,
      start: draft.length,
      end: draft.length,
    };

  const insertMention = (member: OrgMemberProfile) => {
    if (!mentionQuery) return;
    const caret = selection().start;
    // The TOKEN form goes into the body; the name is resolved at render.
    const token = `<@${member.id}> `;
    const next = draft.slice(0, mentionQuery.start) + token + draft.slice(caret);
    const pos = mentionQuery.start + token.length;
    setMentionQuery(null);
    applyEdit({ value: next, start: pos, end: pos });
  };

  const submit = () => {
    if (!canSend) return;
    if (editing) onCommitEdit();
    else onSend();
    setMentionQuery(null);
  };

  /**
   * Returns true when the key was consumed. The editor asks before applying
   * any binding of its own, which is what lets the mention picker keep Enter,
   * Tab and the arrows.
   */
  const handleKeyDown = (e: KeyboardEvent): boolean => {
    if (mentionQuery && matches.length > 0) {
      const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
      if (step !== 0) {
        e.preventDefault();
        setHighlighted((h) => (h + step + matches.length) % matches.length);
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertMention(matches[highlighted]);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionQuery(null);
        return true;
      }
    }
    // The usual shortcuts, so formatting does not have to mean the mouse.
    const shortcut = e.metaKey || e.ctrlKey ? SHORTCUTS[e.key.toLowerCase()] : undefined;
    if (shortcut && !e.altKey) {
      e.preventDefault();
      onFormat(shortcut);
      return true;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
      return true;
    }
    if (e.key === "Escape" && (replyTo || editing)) {
      e.preventDefault();
      onCancelIntent();
      return true;
    }
    return false;
  };

  const intentTarget = editing ? lookup(editing) : replyTo ? lookup(replyTo) : undefined;
  const intent: ComposerIntent | null =
    editing || replyTo
      ? {
          kind: editing ? "edit" : "reply",
          author:
            !editing && intentTarget
              ? authorLabel(intentTarget, (id) => memberMap.get(id)?.name ?? "Unknown")
              : null,
          preview: intentTarget?.deleted
            ? "deleted message"
            : intentTarget
              ? toPlainText(intentTarget.body, memberMap)
              : null,
        }
      : null;

  const onFormat = (kind: ComposerFormat) => applyEdit(FORMAT_EDITS[kind](selection()));

  const onMention = () => {
    const sel = selection();
    const needsSpace = sel.start > 0 && !/\s$/.test(draft.slice(0, sel.start));
    const edit = insertText(sel, needsSpace ? " @" : "@");
    applyEdit(edit);
    setMentionQuery({ start: edit.start - 1, query: "" });
  };

  return (
    <CommsComposerView
      input={
        Input ? (
          <Input
            handle={input}
            value={draft}
            placeholder={placeholder}
            members={memberMap}
            me={me}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onPasteLargeText={handlePasteLargeText}
          />
        ) : (
          // Same geometry, so the composer does not resize when the real
          // editor lands. Only ever seen on a cold first open.
          <div className="px-[10px] py-[8px] text-base leading-[18px] text-disabled">
            {draft || placeholder}
          </div>
        )
      }
      draftEmpty={draft.length === 0}
      intent={intent}
      onCancelIntent={onCancelIntent}
      attachments={attachments}
      onRemoveAttachment={onRemoveAttachment}
      atAttachmentLimit={attachments.length >= CHAT_MESSAGE_ATTACHMENT_MAX}
      attachmentLimit={CHAT_MESSAGE_ATTACHMENT_MAX}
      onAttach={onPickFiles}
      mention={
        mentionQuery
          ? { matches, highlighted, onHover: setHighlighted, onPick: insertMention }
          : null
      }
      bytes={bytes}
      maxBytes={CHAT_BODY_MAX_BYTES}
      sendState={canSend ? "ready" : uploading ? "uploading" : "disabled"}
      editing={editing !== null}
      onSend={submit}
      onFormat={onFormat}
      onEmoji={(char) => applyEdit(insertText(selection(), char))}
      onMention={onMention}
      dropActive={dropActive}
      renderAvatar={(m) => <CommsAvatar member={m} size={16} />}
    />
  );
}

/** ⌘B, ⌘I and ⌘K, as the formatting row's own edits. */
const SHORTCUTS: Record<string, ComposerFormat> = { b: "bold", i: "italic", k: "link" };

/** Look back from the caret for an unbroken `@word` that starts a token. */
function detectMention(value: string, caret: number): { start: number; query: string } | null {
  const upto = value.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at === -1) return null;
  const before = at === 0 ? " " : upto[at - 1];
  if (!/\s/.test(before)) return null;
  const query = upto.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query };
}

/** The formatting row's buttons, as pure edits on the editor's selection. */
const FORMAT_EDITS: Record<ComposerFormat, (sel: Selection) => Edit> = {
  bold: (sel) => wrap(sel, "**"),
  italic: (sel) => wrap(sel, "*"),
  strike: (sel) => wrap(sel, "~~"),
  code: (sel) => wrap(sel, "`"),
  link: (sel) => insertLink(sel),
  bullet: (sel) => linePrefix(sel, "- "),
  number: (sel) => linePrefix(sel, "1. ", true),
  quote: (sel) => linePrefix(sel, "> "),
};
