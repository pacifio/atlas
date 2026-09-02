import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  AtSign,
  Bold,
  Code,
  CornerUpRight,
  Italic,
  Link2,
  List,
  ListOrdered,
  Loader2,
  Paperclip,
  Pencil,
  Plus,
  Quote,
  Strikethrough,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Kbd } from "@/ui/kbd";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useCommsStore } from "../stores/comms-store";
import { useComposerFileDrop } from "@/features/chat/hooks/use-composer-file-drop";
import { CommsAvatar } from "./comms-avatar";
import { EmojiPicker } from "./emoji-picker";
import { insertLink, insertText, linePrefix, wrap, type Edit } from "../lib/markdown-insert";
import { utf8Bytes } from "../lib/derive";
import { CHAT_BODY_MAX_BYTES, CHAT_MESSAGE_ATTACHMENT_MAX } from "../types";
import type { CommsMessage, OrgMemberProfile } from "../types";

/** One file on its way up, as the composer sees it. */
export interface PendingAttachment {
  uploadId: string;
  /** Server file id, once the intent has been created. */
  fileId: string | null;
  filename: string;
  totalBytes: number;
  sentBytes: number;
  state: "uploading" | "complete" | "failed";
  error?: string;
}

interface ComposerProps {
  convId: string;
  members: OrgMemberProfile[];
  memberMap: Map<string, OrgMemberProfile>;
  lookup: (id: string) => CommsMessage | undefined;
  placeholder: string;
}

const EMPTY_COMPOSER = {
  draft: "",
  replyTo: null as string | null,
  editing: null as string | null,
  attachments: [] as PendingAttachment[],
};

/**
 * The team-chat composer.
 *
 * Built on the agent composer's two-layer card (`chat/components/message-input.tsx`):
 * a muted outer shell whose exposed bottom strip *is* the toolbar, and an inner
 * input surface that owns the focus ring. It keeps a plain `<textarea>` rather
 * than the agent's CodeMirror — that exists to host mention *chips inside the
 * document*, whereas a chat body is plain text carrying `<@id>` tokens.
 *
 * Two limits are contract-driven, not taste: the body cap is counted in UTF-8
 * BYTES (emoji and CJK cost 3–4×, and a character counter would let someone
 * write a message the server then refuses), and the mention picker inserts the
 * `<@user_id>` token form so a later rename changes rendering, never history.
 */
export function CommsComposer({ convId, members, memberMap, lookup, placeholder }: ComposerProps) {
  // The composer subscribes to ITS OWN slice. When this lived in the
  // conversation component, every keystroke — and every upload-progress tick —
  // re-rendered the entire transcript above it.
  const composer = useCommsStore((s) => s.composers[convId]) ?? EMPTY_COMPOSER;
  const { draft, replyTo, editing, attachments } = composer;
  const actions = useCommsStore.use.actions();
  const onChange = (value: string) => actions.setDraft(convId, value);
  const onSend = () => actions.send(convId);
  const onCommitEdit = () => actions.commitEdit(convId);
  const onCancelIntent = () => actions.cancelComposerIntent(convId);
  const onAttachFiles = (paths: string[]) => actions.attachFiles(convId, paths);
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
  const ref = useRef<HTMLTextAreaElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const [mentionQuery, setMentionQuery] = useState<{ start: number; query: string } | null>(null);
  const [highlighted, setHighlighted] = useState(0);

  const bytes = utf8Bytes(draft);
  const overLimit = bytes > CHAT_BODY_MAX_BYTES;
  const uploading = attachments.some((a) => a.state === "uploading");
  const ready = attachments.filter((a) => a.state === "complete" && a.fileId);
  // An empty body is legal with at least one attachment — a screenshot with no
  // caption is the ordinary case.
  const canSend = (draft.trim().length > 0 || ready.length > 0) && !overLimit && !uploading;

  const { isDropTarget } = useComposerFileDrop({
    targetRef: shellRef,
    onDropFiles: onAttachFiles,
  });

  // Autosize, capped so a long message never eats the transcript.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  // Focus on conversation switch and when an edit or reply is started.
  useEffect(() => {
    ref.current?.focus();
  }, [convId, replyTo, editing]);

  const matches = useMemo(() => {
    if (!mentionQuery) return [];
    const q = mentionQuery.query.toLowerCase();
    return members
      .filter((m) => m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q))
      .slice(0, 6);
  }, [members, mentionQuery]);

  useEffect(() => setHighlighted(0), [mentionQuery?.query]);

  const detectMention = useCallback((value: string, caret: number) => {
    // Look back from the caret for an unbroken `@word` that starts a token.
    const upto = value.slice(0, caret);
    const at = upto.lastIndexOf("@");
    if (at === -1) return null;
    const before = at === 0 ? " " : upto[at - 1];
    if (!/\s/.test(before)) return null;
    const query = upto.slice(at + 1);
    if (/\s/.test(query)) return null;
    return { start: at, query };
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    onChange(value);
    setMentionQuery(detectMention(value, e.target.selectionStart ?? value.length));
  };

  /** Apply a pure edit and put the caret back where it belongs. */
  const applyEdit = (edit: Edit) => {
    onChange(edit.value);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(edit.start, edit.end);
    });
  };

  const selection = () => {
    const el = ref.current;
    return {
      value: draft,
      start: el?.selectionStart ?? draft.length,
      end: el?.selectionEnd ?? draft.length,
    };
  };

  const insertMention = (member: OrgMemberProfile) => {
    if (!mentionQuery) return;
    const el = ref.current;
    const caret = el?.selectionStart ?? draft.length;
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

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionQuery && matches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlighted((h) => (h + 1) % matches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlighted((h) => (h - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertMention(matches[highlighted]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionQuery(null);
        return;
      }
    }
    // The usual shortcuts, so formatting does not have to mean the mouse.
    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      const key = e.key.toLowerCase();
      if (key === "b") {
        e.preventDefault();
        applyEdit(wrap(selection(), "**"));
        return;
      }
      if (key === "i") {
        e.preventDefault();
        applyEdit(wrap(selection(), "*"));
        return;
      }
      if (key === "k") {
        e.preventDefault();
        applyEdit(insertLink(selection()));
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === "Escape" && (replyTo || editing)) {
      e.preventDefault();
      onCancelIntent();
    }
  };

  const intentTarget = editing ? lookup(editing) : replyTo ? lookup(replyTo) : undefined;
  const atLimit = attachments.length >= CHAT_MESSAGE_ATTACHMENT_MAX;

  return (
    <div className="relative shrink-0 px-2 pb-2 pt-1">
      {mentionQuery &&
        matches.length > 0 && (
          // The house mention-picker shell (`src/features/mentions`): opaque
          // black, NOT frosted — a backdrop blur here re-blends against the
          // composer and glitches with the caret — plus the keycap footer, so
          // the two pickers in the app read as one component.
          <div
            className={cn(
              "absolute bottom-full left-2 right-2 z-[var(--z-dropdown)] mb-1 flex flex-col overflow-hidden rounded-lg",
              "border border-white/10 bg-black",
              "shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_8px_24px_rgba(0,0,0,0.6)]",
              "animate-scale-in",
            )}
            // Selecting with the mouse must not blur the textarea first.
            onMouseDown={(e) => e.preventDefault()}
          >
            {/* No section header and no email line: one kind of thing is
                listed here and the name is what gets typed, so both were
                furniture in a popup that sits over the conversation. */}
            <div className="max-h-[180px] flex-1 overflow-y-auto hide-scrollbar py-1">
              {matches.map((m, i) => (
                <button
                  key={m.id}
                  type="button"
                  onMouseEnter={() => setHighlighted(i)}
                  onClick={() => insertMention(m)}
                  className={cn(
                    "flex h-[26px] w-full items-center gap-1.5 px-2 text-left transition-colors cursor-pointer",
                    i === highlighted ? "bg-white/[0.07]" : "hover:bg-white/[0.04]",
                  )}
                >
                  <CommsAvatar member={m} size={16} />
                  <span className="min-w-0 flex-1 truncate text-[11px] text-text-primary">
                    {m.name}
                  </span>
                </button>
              ))}
            </div>
            <div className="flex h-[26px] shrink-0 items-center justify-between border-t border-white/10 px-2">
              <span className="flex items-center gap-1.5 text-[9px] text-text-tertiary">
                <Kbd>↑↓</Kbd>
                <span>navigate</span>
                <Kbd>↵</Kbd>
                <span>select</span>
              </span>
              <span className="flex items-center gap-1.5 text-[9px] text-text-tertiary">
                <Kbd>esc</Kbd>
                <span>close</span>
              </span>
            </div>
          </div>
        )}

      {/* The reply/edit strip, TUCKED into the top of the composer rather than
          floating above it — the same construction as the agent composer's AI
          grant bar. `mx-2` insets it so the composer reads as the wider element,
          `rounded-t-2xl` matches the shell's corners, and `-mb-4` against `pb-5`
          lets the shell overlap its lower half so the two read as one object.
          `z-0` keeps it behind; the shell below carries `z-10`.
          `atlas-pill-in` is the same 200ms rise the grant bar animates in with,
          and it is already disabled under prefers-reduced-motion. */}
      {(replyTo || editing) && (
        <div className="atlas-pill-in relative z-0 mx-2 -mb-4 flex items-center gap-1.5 rounded-t-2xl bg-[var(--bg-tertiary)] px-3 pb-5 pt-1.5">
          {editing ? (
            <Pencil size={11} className="shrink-0 text-text-tertiary" />
          ) : (
            <CornerUpRight size={11} className="shrink-0 -scale-y-100 text-text-tertiary" />
          )}
          <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-text-tertiary">
            {editing ? "Editing" : "Replying to"}
          </span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-text-secondary">
            {editing ? null : (memberMap.get(intentTarget?.author_id ?? "")?.name ?? "Unknown")}
            {intentTarget && !editing ? " · " : ""}
            {intentTarget?.deleted ? "deleted message" : intentTarget?.body}
          </span>
          <button
            type="button"
            title="Cancel"
            onClick={onCancelIntent}
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-bg-active hover:text-text-primary cursor-pointer"
          >
            <X size={11} />
          </button>
        </div>
      )}

      {/* Outer shell — its exposed bottom strip is the toolbar. */}
      <div
        ref={shellRef}
        className={cn(
          // `z-10` so the shell paints over — and visually tucks — the reply
          // strip's lower half.
          "relative z-10 rounded-2xl border bg-[var(--bg-secondary)] shadow-[0_8px_24px_rgba(0,0,0,0.35)] transition-colors",
          isDropTarget
            ? "border-[var(--accent-primary)] ring-2 ring-[var(--accent-primary)]/40"
            : overLimit
              ? "border-error"
              : "border-border-default",
        )}
      >
        {isDropTarget && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-[var(--accent-primary)]/8 backdrop-blur-[1px]">
            <span className="rounded-full bg-bg-elevated px-3 py-1 text-[11px] font-medium text-text-secondary shadow">
              Drop files to attach
            </span>
          </div>
        )}

        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-2 pt-2">
            {attachments.map((a) => (
              <AttachmentChip key={a.uploadId} attachment={a} onRemove={onRemoveAttachment} />
            ))}
          </div>
        )}

        {/* Inner input surface. The disabled dimming, when it exists, belongs
            HERE and not on the shell — on the shell it fades the toolbar and
            every popover anchored to it. */}
        <div className="relative m-1 rounded-xl border border-border-default bg-bg-base transition-[border-color,box-shadow] duration-150 focus-within:border-[color-mix(in_srgb,var(--border-focus)_50%,var(--border-default))] focus-within:ring-1 focus-within:ring-[var(--accent-primary)]/10">
          {/* EVERY vertical value here is literal px, and that is the whole
              point. Atlas's UI-scale shrinks the root font-size, so a rem-based
              `py-2` renders ~6px rather than 8px while `min-h-[34px]` stays a
              hard 34px — 6 + 18 + 6 = 30, and the missing 4px collected at the
              bottom of the content box, dropping the line off-centre. Padding
              and min-height must be derived from the same unit as the line box:
              8 + 18 + 8 = 34, so one line is exactly centred and each extra
              line adds a clean 18px. (The agent composer pins its geometry in
              px for this same reason.) */}
          <textarea
            ref={ref}
            value={draft}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder={placeholder}
            className="block min-h-[34px] w-full resize-none bg-transparent py-[8px] pl-[10px] pr-[38px] text-[12.5px] leading-[18px] text-text-primary outline-none placeholder:text-text-ghost hide-scrollbar"
          />
          {/* Inline send, pinned top-right — the agent composer's placement, so
              it stays put as the textarea grows downward. */}
          <button
            type="button"
            title={editing ? "Save edit" : uploading ? "Waiting for uploads…" : "Send"}
            disabled={!canSend}
            onClick={submit}
            className={cn(
              "absolute right-[4px] top-[4px] flex h-[26px] w-[26px] items-center justify-center rounded-lg border border-transparent transition-colors",
              canSend
                ? "text-text-primary hover:border-border-default hover:bg-bg-hover cursor-pointer"
                : "text-text-tertiary cursor-not-allowed",
            )}
          >
            {uploading ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <ArrowUp size={15} strokeWidth={2.5} />
            )}
          </button>
        </div>

        <div className="flex items-center justify-between gap-1 px-1.5 pb-1.5 pt-0.5">
          <div className="flex min-w-0 items-center gap-0.5">
            <button
              type="button"
              title={atLimit ? `At most ${CHAT_MESSAGE_ATTACHMENT_MAX} files` : "Attach a file"}
              disabled={atLimit}
              onClick={onPickFiles}
              className={cn(
                "flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border border-border-default bg-bg-elevated text-text-secondary transition-colors",
                atLimit
                  ? "cursor-not-allowed opacity-50"
                  : "hover:bg-bg-hover hover:text-text-primary cursor-pointer",
              )}
            >
              <Plus size={13} />
            </button>
            <Divider />
            <EmojiPicker onPick={(char) => applyEdit(insertText(selection(), char))} />
            <button
              type="button"
              title="Mention someone"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                const sel = selection();
                const needsSpace = sel.start > 0 && !/\s$/.test(draft.slice(0, sel.start));
                const edit = insertText(sel, needsSpace ? " @" : "@");
                applyEdit(edit);
                setMentionQuery({ start: edit.start - 1, query: "" });
              }}
              className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary cursor-pointer"
            >
              <AtSign size={14} />
            </button>
          </div>

          <div className="flex shrink-0 items-center gap-0.5">
            {/* Only shown near the ceiling — a permanent counter is noise. */}
            {bytes > CHAT_BODY_MAX_BYTES * 0.8 && (
              <span
                className={cn(
                  "mr-1 text-[9.5px] tabular-nums",
                  overLimit ? "text-error" : "text-text-ghost",
                )}
              >
                {bytes.toLocaleString()} / {CHAT_BODY_MAX_BYTES.toLocaleString()}
              </span>
            )}
            <FormatButton
              title="Bold  ⌘B"
              icon={Bold}
              onApply={() => applyEdit(wrap(selection(), "**"))}
            />
            <FormatButton
              title="Italic  ⌘I"
              icon={Italic}
              onApply={() => applyEdit(wrap(selection(), "*"))}
            />
            <FormatButton
              title="Strikethrough"
              icon={Strikethrough}
              onApply={() => applyEdit(wrap(selection(), "~~"))}
            />
            <FormatButton
              title="Code"
              icon={Code}
              onApply={() => applyEdit(wrap(selection(), "`"))}
            />
            <FormatButton
              title="Link  ⌘K"
              icon={Link2}
              onApply={() => applyEdit(insertLink(selection()))}
            />
            <Divider />
            <FormatButton
              title="Bulleted list"
              icon={List}
              onApply={() => applyEdit(linePrefix(selection(), "- "))}
            />
            <FormatButton
              title="Numbered list"
              icon={ListOrdered}
              onApply={() => applyEdit(linePrefix(selection(), "1. ", true))}
            />
            <FormatButton
              title="Quote"
              icon={Quote}
              onApply={() => applyEdit(linePrefix(selection(), "> "))}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function Divider() {
  return <span aria-hidden className="mx-0.5 h-3.5 w-px shrink-0 bg-border-default" />;
}

/**
 * A formatting button.
 *
 * `onMouseDown` preventDefault is load-bearing: without it the textarea loses
 * its selection the moment the button takes focus, and every wrap would apply
 * to an empty range.
 */
function FormatButton({
  title,
  icon: Icon,
  onApply,
}: {
  title: string;
  icon: typeof Bold;
  onApply: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onApply}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary cursor-pointer"
    >
      <Icon size={13} />
    </button>
  );
}

function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: PendingAttachment;
  onRemove: (uploadId: string) => void;
}) {
  const pct =
    attachment.totalBytes > 0
      ? Math.min(100, Math.round((attachment.sentBytes / attachment.totalBytes) * 100))
      : 0;
  const failed = attachment.state === "failed";

  return (
    <div
      className={cn(
        "group/chip relative flex h-[26px] max-w-[220px] items-center gap-1.5 overflow-hidden rounded-md border px-2 text-[11px]",
        failed
          ? "border-error text-error"
          : "border-border-default bg-bg-elevated text-text-secondary",
      )}
    >
      {/* Progress paints behind the label rather than as a separate bar — the
          chip is only 26px tall and a bar would halve the text. */}
      {attachment.state === "uploading" && (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 bg-[var(--comms-unread)]/20 transition-[width] duration-200"
          style={{ width: `${pct}%` }}
        />
      )}
      <Paperclip size={11} className="relative shrink-0 opacity-60" />
      <span className="relative min-w-0 flex-1 truncate">{attachment.filename}</span>
      {attachment.state === "uploading" && (
        <span className="relative shrink-0 tabular-nums opacity-60">{pct}%</span>
      )}
      <button
        type="button"
        title={failed ? attachment.error || "Upload failed — remove" : "Remove"}
        onClick={() => onRemove(attachment.uploadId)}
        className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-bg-active hover:text-text-primary cursor-pointer"
      >
        <X size={10} />
      </button>
    </div>
  );
}
