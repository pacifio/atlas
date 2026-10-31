import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ALargeSmall,
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
import { HintGroup, HintItem } from "@/ui/hint-group";
import { Hint } from "@/ui/tooltip";
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
import { EmojiPicker } from "./emoji-picker";
import { insertLink, insertText, linePrefix, wrap, type Edit } from "../lib/markdown-insert";
import { utf8Bytes } from "../lib/derive";
import { authorLabel } from "../lib/message-author";
import { toPlainText } from "../lib/to-plain-text";
import { CHAT_BODY_MAX_BYTES, CHAT_MESSAGE_ATTACHMENT_MAX } from "../types";
import type { CommsMessage, OrgMemberProfile } from "../types";

// Start the editor chunk downloading as soon as this module evaluates, but
// keep it a DYNAMIC import: a static one would put Tiptap and ProseMirror in
// the comms panel's own chunk, so opening team chat would block on them. The
// session composer does exactly this for the same reason
// (`chat/components/message-input.tsx`). One promise, shared by every
// composer instance.
const composerInputPromise: Promise<typeof import("./composer-input")> = import("./composer-input");

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
 * The team-chat composer.
 *
 * Built on the agent composer's two-layer card (`chat/components/message-input.tsx`):
 * a muted outer shell whose exposed bottom strip *is* the toolbar, and an inner
 * input surface that owns the focus ring, and on the same editor core
 * (`components/composer/`). The body stays plain text carrying `<@id>`
 * tokens; the editor only paints them as pills (`composer-input.tsx`).
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

  const isDropTarget = dropActive;

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
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlighted((h) => (h + 1) % matches.length);
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlighted((h) => (h - 1 + matches.length) % matches.length);
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
    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      const key = e.key.toLowerCase();
      if (key === "b") {
        e.preventDefault();
        applyEdit(wrap(selection(), "**"));
        return true;
      }
      if (key === "i") {
        e.preventDefault();
        applyEdit(wrap(selection(), "*"));
        return true;
      }
      if (key === "k") {
        e.preventDefault();
        applyEdit(insertLink(selection()));
        return true;
      }
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

  // The formatting row, shown on demand (the Aa toggle). Per composer, not
  // remembered: it is a tool you reach for, not a mode you live in.
  const [formatOpen, setFormatOpen] = useState(false);
  // Focus anywhere in the composer (the editor, its buttons, the mention
  // picker). Tracked rather than read off `:focus-within` because the width
  // also holds while there is something in the bar.
  const [focused, setFocused] = useState(false);
  // At rest the bar is 84% of the column, centred; in use it eases out to 89.5%,
  // never the full width. "In use" outlasts focus while the bar holds a draft,
  // files, a reply or an edit, or the formatting row, so it never shrinks
  // under something you are writing.
  const expanded =
    focused ||
    draft.length > 0 ||
    attachments.length > 0 ||
    formatOpen ||
    replyTo !== null ||
    editing !== null;

  const intentTarget = editing ? lookup(editing) : replyTo ? lookup(replyTo) : undefined;
  const atLimit = attachments.length >= CHAT_MESSAGE_ATTACHMENT_MAX;

  return (
    <div
      className="relative shrink-0 px-2 pb-4 pt-1"
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      {/* The bar's width: 84% at rest, 89.5% in use, centred, and never under
          24rem (or the column, when that is narrower) — a side-panel chat is
          already narrow. Width only; nothing else moves. */}
      <div
        className={cn(
          "relative mx-auto min-w-[min(100%,24rem)] transition-[width] duration-slow ease-out-strong motion-reduce:transition-none",
          expanded ? "w-[89.5%]" : "w-[84%]",
        )}
      >
        {mentionQuery && matches.length > 0 && (
          // The house mention-picker shell (`src/features/mentions`): opaque
          // black, NOT frosted — a backdrop blur here re-blends against the
          // composer and glitches with the caret — plus the keycap footer, so
          // the two pickers in the app read as one component.
          <div
            className={cn(
              "absolute bottom-full left-2 right-2 z-popover mb-1 flex flex-col overflow-hidden rounded-lg",
              "border border-border bg-popover",
              "shadow-lg inset-highlight",
            )}
            // Selecting with the mouse must not blur the editor first.
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
                    "flex h-control-md w-full items-center gap-1.5 px-2 text-left transition-colors cursor-pointer",
                    i === highlighted
                      ? "bg-[var(--atlas-element-selected)]"
                      : "hover:bg-[var(--atlas-element-hover)]",
                  )}
                >
                  <CommsAvatar member={m} size={16} />
                  <span className="min-w-0 flex-1 truncate text-xs text-foreground">{m.name}</span>
                </button>
              ))}
            </div>
            <div className="flex h-control-md shrink-0 items-center justify-between border-t border-border px-2">
              <span className="flex items-center gap-1.5 text-3xs text-muted-foreground">
                <Kbd>↑↓</Kbd>
                <span>navigate</span>
                <Kbd>↵</Kbd>
                <span>select</span>
              </span>
              <span className="flex items-center gap-1.5 text-3xs text-muted-foreground">
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
          <div className="atlas-pill-in relative z-0 mx-2 -mb-4 flex items-center gap-1.5 rounded-t-2xl bg-[var(--popover)] px-3 pb-5 pt-1.5">
            {editing ? (
              <Pencil size={11} className="shrink-0 text-muted-foreground" />
            ) : (
              <CornerUpRight size={11} className="shrink-0 -scale-y-100 text-muted-foreground" />
            )}
            <span className="shrink-0 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              {editing ? "Editing" : "Replying to"}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-secondary-foreground">
              {editing
                ? null
                : intentTarget
                  ? authorLabel(intentTarget, (id) => memberMap.get(id)?.name ?? "Unknown")
                  : "Unknown"}
              {intentTarget && !editing ? " · " : ""}
              {intentTarget?.deleted
                ? "deleted message"
                : intentTarget
                  ? toPlainText(intentTarget.body, memberMap)
                  : null}
            </span>
            <Hint label="Cancel" side="top">
              <button
                type="button"
                onClick={onCancelIntent}
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-element-active hover:text-foreground cursor-pointer"
              >
                <X size={11} />
              </button>
            </Hint>
          </div>
        )}

        {/* One bar, Discord's: attach on the left, the text, then the few
          controls a message needs on the right. Formatting is behind the Aa
          toggle (and ⌘B / ⌘I / ⌘K) rather than eight glyphs that are always
          there; a row of them only appears while it is on. One surface with a
          glass rim, no inner field: the bar IS the field. */}
        <HintGroup side="top">
          <div
            ref={shellRef}
            className={cn(
              // `z-10` so the shell paints over — and visually tucks — the reply
              // strip's lower half.
              // The glass rim (`glass-rim`, the sidebar dock's): the app's own
              // background inside a 1px edge lit from the top.
              // `rounded-composer` (globals.css) makes one line an exact
              // capsule and keeps that corner as it grows. A drop or an
              // over-limit draft colours that edge solid.
              "glass-rim rounded-composer relative z-10",
              isDropTarget
                ? "border-[var(--primary)] ring-2 ring-[var(--primary)]/40"
                : overLimit && "border-error",
            )}
          >
            {isDropTarget && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-composer bg-[var(--primary)]/8 backdrop-blur-[1px]">
                <span className="rounded-full bg-card px-3 py-1 text-xs font-medium text-secondary-foreground shadow">
                  Drop files to attach
                </span>
              </div>
            )}

            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-4 pt-3">
                {attachments.map((a) => (
                  <AttachmentChip key={a.uploadId} attachment={a} onRemove={onRemoveAttachment} />
                ))}
              </div>
            )}

            {formatOpen && (
              <div className="flex flex-wrap items-center gap-0.5 border-b border-border-subtle px-4 pt-1.5 pb-1">
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
            )}

            {/* The side controls sit in 44px rows pinned to the BOTTOM, so they
              stay on the last line as the text grows, the way Discord's do.
              Vertical values are literal px, the line box's unit: the editor
              is 8 + 18 + 8 = 34px, and 5px above and below make the 44px row
              (Atlas's UI scale shrinks rem, which would drop the line
              off-centre — see the editor's own padding). */}
            <div className="flex items-end gap-1 px-[8px]">
              <div className="flex h-[44px] shrink-0 items-center">
                <HintItem
                  label={atLimit ? `At most ${CHAT_MESSAGE_ATTACHMENT_MAX} files` : "Attach a file"}
                >
                  <button
                    type="button"
                    disabled={atLimit}
                    onClick={onPickFiles}
                    className={cn(
                      BAR_BUTTON,
                      atLimit && "cursor-not-allowed opacity-50 hover:bg-transparent",
                    )}
                  >
                    <Plus size={18} />
                  </button>
                </HintItem>
              </div>

              <div className="min-h-[44px] min-w-0 flex-1 py-[5px]">
                {Input ? (
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
                )}
              </div>

              <div className="flex h-[44px] shrink-0 items-center gap-0.5">
                {/* Only shown near the ceiling — a permanent counter is noise. */}
                {bytes > CHAT_BODY_MAX_BYTES * 0.8 && (
                  <span
                    className={cn(
                      "mr-1 text-2xs tabular-nums",
                      overLimit ? "text-error" : "text-disabled",
                    )}
                  >
                    {bytes.toLocaleString()} / {CHAT_BODY_MAX_BYTES.toLocaleString()}
                  </span>
                )}
                <EmojiPicker onPick={(char) => applyEdit(insertText(selection(), char))} />
                <HintItem label="Mention someone">
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      const sel = selection();
                      const needsSpace = sel.start > 0 && !/\s$/.test(draft.slice(0, sel.start));
                      const edit = insertText(sel, needsSpace ? " @" : "@");
                      applyEdit(edit);
                      setMentionQuery({ start: edit.start - 1, query: "" });
                    }}
                    className={BAR_BUTTON}
                  >
                    <AtSign size={16} />
                  </button>
                </HintItem>
                <HintItem label={formatOpen ? "Hide formatting" : "Formatting"}>
                  <button
                    type="button"
                    aria-pressed={formatOpen}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setFormatOpen((v) => !v)}
                    className={cn(BAR_BUTTON, formatOpen && "bg-element-active text-foreground")}
                  >
                    <ALargeSmall size={17} />
                  </button>
                </HintItem>
                <HintItem
                  label={editing ? "Save edit" : uploading ? "Waiting for uploads…" : "Send"}
                >
                  <button
                    type="button"
                    disabled={!canSend}
                    onClick={submit}
                    className={cn(
                      BAR_BUTTON,
                      canSend
                        ? "text-foreground"
                        : "cursor-not-allowed text-disabled hover:bg-transparent hover:text-disabled",
                    )}
                  >
                    {uploading ? (
                      <Loader2 size={15} className="animate-spin" />
                    ) : (
                      <ArrowUp size={17} strokeWidth={2.25} />
                    )}
                  </button>
                </HintItem>
              </div>
            </div>
          </div>
        </HintGroup>
      </div>
    </div>
  );
}

/** The bar's icon buttons: one size, one hover, Discord's spacing. */
const BAR_BUTTON =
  "flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-element-hover hover:text-foreground";

function Divider() {
  return <span aria-hidden className="mx-0.5 h-3.5 w-px shrink-0 bg-border" />;
}

/**
 * A formatting button.
 *
 * `onMouseDown` preventDefault is load-bearing: without it the editor loses
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
    <HintItem label={title}>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onApply}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-element-hover hover:text-foreground cursor-pointer"
      >
        <Icon size={13} />
      </button>
    </HintItem>
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
        "group/chip relative flex h-control-md max-w-[220px] items-center gap-1.5 overflow-hidden rounded-md border px-2 text-xs",
        failed ? "border-error text-error" : "border-border bg-card text-secondary-foreground",
      )}
    >
      {/* Progress paints behind the label rather than as a separate bar — the
          chip is only 26px tall and a bar would halve the text. */}
      {attachment.state === "uploading" && (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 bg-[var(--atlas-status-success-foreground)]/20 transition-[width] duration-200"
          style={{ width: `${pct}%` }}
        />
      )}
      <Paperclip size={11} className="relative shrink-0 opacity-60" />
      <span className="relative min-w-0 flex-1 truncate">{attachment.filename}</span>
      {attachment.state === "uploading" && (
        <span className="relative shrink-0 tabular-nums opacity-60">{pct}%</span>
      )}
      <Hint label={failed ? attachment.error || "Upload failed — remove" : "Remove"} side="top">
        <button
          type="button"
          onClick={() => onRemove(attachment.uploadId)}
          className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-element-active hover:text-foreground cursor-pointer"
        >
          <X size={10} />
        </button>
      </Hint>
    </div>
  );
}
