import { useState, type ReactNode } from "react";
import { ALargeSmall, AtSign, CornerUpRight, Pencil, Plus, X } from "lucide-react";
import { Hint, HintGroup, HintItem, IconButton, Pill } from "@tryatlas/design";
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
 * The team-chat composer, drawn from props.
 *
 * Built on the agent composer's two-layer card (`chat/components/message-input.tsx`):
 * one bar with a glass rim whose controls sit beside the text, and a reply or
 * edit strip tucked behind its top edge. The container (`comms-composer.tsx`)
 * owns the editor, the store and the keys; this file only lays them out.
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
  // Focus anywhere in the composer (the editor, its buttons, the mention
  // picker). Tracked rather than read off `:focus-within` because the width
  // also holds while there is something in the bar.
  const [focused, setFocused] = useState(false);
  // At rest the bar is 84% of the column, centred; in use it eases out to 89.5%,
  // never the full width. "In use" outlasts focus while the bar holds a draft,
  // files, a reply or an edit, or the formatting row, so it never shrinks
  // under something you are writing.
  const expanded =
    focused || !draftEmpty || attachments.length > 0 || formatOpen || intent !== null;
  const overLimit = bytes > maxBytes;
  const canSend = sendState === "ready";

  return (
    <div
      data-comms-composer
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
        {mention && mention.matches.length > 0 && (
          <MentionPopup mention={mention} renderAvatar={renderAvatar} />
        )}

        {/* The reply/edit strip, TUCKED into the top of the composer rather than
          floating above it — the same construction as the agent composer's AI
          grant bar. `mx-2` insets it so the composer reads as the wider element,
          `rounded-t-2xl` matches the shell's corners, and `-mb-4` against `pb-5`
          lets the shell overlap its lower half so the two read as one object.
          `z-0` keeps it behind; the shell below carries `z-10`.
          `atlas-pill-in` is the same 200ms rise the grant bar animates in with,
          and it is already disabled under prefers-reduced-motion. */}
        {intent && (
          <div className="atlas-pill-in relative z-0 mx-2 -mb-4 flex items-center gap-1.5 rounded-t-2xl bg-popover px-3 pb-5 pt-1.5">
            {intent.kind === "edit" ? (
              <Pencil size={11} className="shrink-0 text-muted-foreground" />
            ) : (
              <CornerUpRight size={11} className="shrink-0 -scale-y-100 text-muted-foreground" />
            )}
            <span className="shrink-0 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              {intent.kind === "edit" ? "Editing" : "Replying to"}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-secondary-foreground">
              {intent.kind === "reply" ? (intent.author ?? "Unknown") : null}
              {intent.kind === "reply" && intent.preview !== null ? " · " : ""}
              {intent.preview}
            </span>
            <Hint label="Cancel" side="top">
              <IconButton size="2xs" icon={X} label="Cancel" onClick={onCancelIntent} />
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
            className={cn(
              // `z-10` so the shell paints over — and visually tucks — the reply
              // strip's lower half.
              // The glass rim (`glass-rim`, the sidebar dock's): the app's own
              // background inside a 1px edge lit from the top.
              // `rounded-composer` (globals.css) makes one line an exact
              // capsule and keeps that corner as it grows. A drop or an
              // over-limit draft colours that edge solid.
              "glass-rim rounded-composer relative z-10",
              dropActive ? "border-primary ring-2 ring-primary/40" : overLimit && "border-error",
            )}
          >
            {dropActive && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-composer bg-primary/8 backdrop-blur-[1px]">
                <Pill size="sm" surface="raised">
                  Drop files to attach
                </Pill>
              </div>
            )}

            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-4 pt-3">
                {attachments.map((a) => (
                  <AttachmentChip key={a.uploadId} attachment={a} onRemove={onRemoveAttachment} />
                ))}
              </div>
            )}

            {formatOpen && <FormatRow onFormat={onFormat} />}

            {/* The side controls sit in 44px rows pinned to the BOTTOM, so they
              stay on the last line as the text grows, the way Discord's do.
              Vertical values are literal px, the line box's unit: the editor
              is 8 + 18 + 8 = 34px, and 5px above and below make the 44px row
              (Atlas's UI scale shrinks rem, which would drop the line
              off-centre — see the editor's own padding). */}
            <div className="flex items-end gap-1 px-[8px]">
              <div className="flex h-[44px] shrink-0 items-center">
                <HintItem
                  label={atAttachmentLimit ? `At most ${attachmentLimit} files` : "Attach a file"}
                >
                  <button
                    type="button"
                    aria-label={
                      atAttachmentLimit ? `At most ${attachmentLimit} files` : "Attach a file"
                    }
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
              </div>

              <div className="min-h-[44px] min-w-0 flex-1 py-[5px]">{input}</div>

              <div className="flex h-[44px] shrink-0 items-center gap-0.5">
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
                <SendButton
                  label={
                    editing
                      ? "Save edit"
                      : sendState === "uploading"
                        ? "Waiting for uploads…"
                        : "Send"
                  }
                  canSend={canSend}
                  uploading={sendState === "uploading"}
                  onSend={onSend}
                />
              </div>
            </div>
          </div>
        </HintGroup>
      </div>
    </div>
  );
}
