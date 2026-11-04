import { useState, type ReactNode } from "react";
import { ALargeSmall, AtSign, Plus } from "lucide-react";
import { CommsComposerShell, HintGroup, HintItem } from "@tryatlas/design";
import { cn } from "@/lib/utils";
import { EmojiPicker } from "../emoji-picker";
import {
  AttachmentChip,
  BAR_BUTTON,
  FormatRow,
  MentionPopup,
  SendButton,
} from "./comms-composer-parts";
import type { OrgMemberProfile, PendingAttachment } from "../../types";

export type ComposerFormat =
  | "bold"
  | "italic"
  | "strike"
  | "code"
  | "link"
  | "bullet"
  | "number"
  | "quote";

/** What the strip tucked behind the bar's top edge says: the message being
 *  replied to, or that one is being edited. */
export interface ComposerIntent {
  kind: "reply" | "edit";
  /** The replied-to author; null while editing (it is you). */
  author: string | null;
  preview: string | null;
}

export interface ComposerMention {
  matches: OrgMemberProfile[];
  highlighted: number;
  onHover: (index: number) => void;
  onPick: (member: OrgMemberProfile) => void;
}

export interface CommsComposerViewProps {
  /** The editor, or its cold-load stand-in. */
  input: ReactNode;
  /** True while the draft is empty: the bar rests narrower until it is used. */
  draftEmpty: boolean;
  intent: ComposerIntent | null;
  onCancelIntent: () => void;
  attachments: PendingAttachment[];
  onRemoveAttachment: (uploadId: string) => void;
  atAttachmentLimit: boolean;
  attachmentLimit: number;
  onAttach: () => void;
  mention: ComposerMention | null;
  bytes: number;
  maxBytes: number;
  sendState: "ready" | "disabled" | "uploading";
  editing: boolean;
  onSend: () => void;
  onFormat: (kind: ComposerFormat) => void;
  onEmoji: (char: string) => void;
  onMention: () => void;
  dropActive: boolean;
  renderAvatar: (member: OrgMemberProfile) => ReactNode;
}

/**
 * The team-chat composer, drawn from props on `@tryatlas/design`'s
 * `CommsComposerShell`: one glass-rimmed bar whose controls sit beside the
 * text, a reply or edit strip tucked behind its top edge, and the drop and
 * over-limit edges. The container (`comms-composer.tsx`) owns the editor, the
 * store and the keys — Escape included, so the shell's own Escape handling is
 * off; this file only fills the shell's slots.
 *
 * Every control that sits beside the editor keeps `onMouseDown`
 * preventDefault: without it the editor loses its selection the moment the
 * button takes focus, and every wrap or insert would land at the wrong place.
 */
export function CommsComposerView({
  input,
  draftEmpty,
  intent,
  onCancelIntent,
  attachments,
  onRemoveAttachment,
  atAttachmentLimit,
  attachmentLimit,
  onAttach,
  mention,
  bytes,
  maxBytes,
  sendState,
  editing,
  onSend,
  onFormat,
  onEmoji,
  onMention,
  dropActive,
  renderAvatar,
}: CommsComposerViewProps) {
  // The formatting row, shown on demand (the Aa toggle). Per composer, not
  // remembered: it is a tool you reach for, not a mode you live in.
  const [formatOpen, setFormatOpen] = useState(false);
  const overLimit = bytes > maxBytes;
  const attachLabel = atAttachmentLimit ? `At most ${attachmentLimit} files` : "Attach a file";

  return (
    // One bar, Discord's: attach on the left, the text, then the few controls
    // a message needs on the right. Formatting is behind the Aa toggle (and
    // ⌘B / ⌘I / ⌘K) rather than eight glyphs that are always there.
    <HintGroup side="top">
      <CommsComposerShell
        editor={input}
        escapeToCancel={false}
        popup={
          mention && mention.matches.length > 0 ? (
            <MentionPopup mention={mention} renderAvatar={renderAvatar} />
          ) : undefined
        }
        replyTo={
          intent?.kind === "reply"
            ? { authorName: intent.author ?? "Unknown", preview: intent.preview ?? "" }
            : null
        }
        replyEmptyLabel="Message deleted"
        onCancelReply={onCancelIntent}
        editing={intent?.kind === "edit"}
        editPreview={intent?.kind === "edit" ? intent.preview : null}
        onCancelEdit={onCancelIntent}
        dropActive={dropActive}
        invalid={overLimit}
        attachments={
          attachments.length > 0
            ? attachments.map((a) => (
                <AttachmentChip key={a.uploadId} attachment={a} onRemove={onRemoveAttachment} />
              ))
            : undefined
        }
        formatRow={formatOpen ? <FormatRow onFormat={onFormat} /> : undefined}
        toolsStart={
          <HintItem label={attachLabel}>
            <button
              type="button"
              aria-label={attachLabel}
              disabled={atAttachmentLimit}
              onClick={onAttach}
              className={cn(
                BAR_BUTTON,
                atAttachmentLimit && "cursor-not-allowed opacity-50 hover:bg-transparent",
              )}
            >
              <Plus size={18} />
            </button>
          </HintItem>
        }
        toolsEnd={
          <>
            {/* Only shown near the ceiling — a permanent counter is noise. */}
            {bytes > maxBytes * 0.8 && (
              <span
                className={cn(
                  "mr-1 text-2xs tabular-nums",
                  overLimit ? "text-error" : "text-disabled",
                )}
              >
                {bytes.toLocaleString()} / {maxBytes.toLocaleString()}
              </span>
            )}
            <EmojiPicker onPick={onEmoji} />
            <HintItem label="Mention someone">
              <button
                type="button"
                aria-label="Mention someone"
                onMouseDown={(e) => e.preventDefault()}
                onClick={onMention}
                className={BAR_BUTTON}
              >
                <AtSign size={16} />
              </button>
            </HintItem>
            <HintItem label={formatOpen ? "Hide formatting" : "Formatting"}>
              <button
                type="button"
                aria-label={formatOpen ? "Hide formatting" : "Formatting"}
                aria-pressed={formatOpen}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setFormatOpen((v) => !v)}
                className={cn(BAR_BUTTON, formatOpen && "bg-element-active text-foreground")}
              >
                <ALargeSmall size={17} />
              </button>
            </HintItem>
          </>
        }
        // The shell widens the bar on `canSend`; it should widen for any
        // draft, sendable or not (over the limit, still uploading), so it
        // never shrinks under something you are writing. Whether Send is
        // live is `sendState`, read by the button below.
        canSend={!draftEmpty || sendState === "ready"}
        sending={sendState === "uploading"}
        sendLabel={
          editing ? "Save edit" : sendState === "uploading" ? "Waiting for uploads…" : "Send"
        }
        onSend={onSend}
        renderSend={({ sending, label, onSend: send }) => (
          <SendButton
            label={label}
            canSend={sendState === "ready"}
            uploading={sending}
            onSend={send}
          />
        )}
      />
    </HintGroup>
  );
}
