import { Fragment, type ReactNode } from "react";
import {
  ArrowUp,
  Bold,
  Code,
  Italic,
  Link2,
  List,
  ListOrdered,
  Loader2,
  Paperclip,
  Quote,
  Strikethrough,
  X,
} from "lucide-react";
import { Hint, HintItem, Kbd, Separator } from "@tryatlas/design";
import { cn } from "@/lib/utils";
import type { OrgMemberProfile, PendingAttachment } from "../../types";
import type { ComposerFormat, ComposerMention } from "./comms-composer-view";

// The pieces of the team-chat composer's bar (`comms-composer-view.tsx`):
// the send button, the mention popup, the formatting row and an attachment
// chip. Props only, like the view that places them.

/** The bar's icon buttons: one size, one hover, Discord's spacing. */
export const BAR_BUTTON =
  "flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-element-hover hover:text-foreground";

export function SendButton({
  label,
  canSend,
  uploading,
  onSend,
}: {
  label: string;
  canSend: boolean;
  uploading: boolean;
  onSend: () => void;
}) {
  return (
    <HintItem label={label}>
      <button
        type="button"
        aria-label={label}
        disabled={!canSend}
        onClick={onSend}
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
  );
}

/** The house mention-picker shell (`src/features/mentions`): opaque, NOT
 *  frosted — a backdrop blur here re-blends against the composer and glitches
 *  with the caret — plus the keycap footer, so the two pickers in the app read
 *  as one component. In flow above the bar rather than a portal, so the editor
 *  keeps focus. */
export function MentionPopup({
  mention,
  renderAvatar,
}: {
  mention: ComposerMention;
  renderAvatar: (member: OrgMemberProfile) => ReactNode;
}) {
  return (
    <div
      className={cn(
        "absolute bottom-full left-2 right-2 z-popover mb-1 flex flex-col overflow-hidden rounded-lg",
        "border border-border bg-popover",
        "shadow-lg inset-highlight",
      )}
      // Selecting with the mouse must not blur the editor first.
      onMouseDown={(e) => e.preventDefault()}
    >
      {/* No section header and no email line: one kind of thing is listed
          here and the name is what gets typed, so both were furniture in a
          popup that sits over the conversation. */}
      <div className="max-h-[180px] flex-1 overflow-y-auto hide-scrollbar py-1">
        {mention.matches.map((m, i) => (
          <button
            key={m.id}
            type="button"
            onMouseEnter={() => mention.onHover(i)}
            onClick={() => mention.onPick(m)}
            className={cn(
              "flex h-control-md w-full items-center gap-1.5 px-2 text-left transition-colors cursor-pointer",
              i === mention.highlighted ? "bg-element-selected" : "hover:bg-element-hover",
            )}
          >
            {renderAvatar(m)}
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
  );
}

const FORMATS: { kind: ComposerFormat; title: string; icon: typeof Bold }[] = [
  { kind: "bold", title: "Bold  ⌘B", icon: Bold },
  { kind: "italic", title: "Italic  ⌘I", icon: Italic },
  { kind: "strike", title: "Strikethrough", icon: Strikethrough },
  { kind: "code", title: "Code", icon: Code },
  { kind: "link", title: "Link  ⌘K", icon: Link2 },
  { kind: "bullet", title: "Bulleted list", icon: List },
  { kind: "number", title: "Numbered list", icon: ListOrdered },
  { kind: "quote", title: "Quote", icon: Quote },
];

export function FormatRow({ onFormat }: { onFormat: (kind: ComposerFormat) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-border-subtle px-4 pt-1.5 pb-1">
      {FORMATS.map(({ kind, title, icon: Icon }) => (
        <Fragment key={kind}>
          {/* Inline styles first, then the block-level ones. */}
          {kind === "bullet" && (
            <Separator orientation="vertical" strong className="mx-0.5 h-3.5" />
          )}
          <HintItem label={title}>
            <button
              type="button"
              aria-label={title}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onFormat(kind)}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-element-hover hover:text-foreground cursor-pointer"
            >
              <Icon size={13} />
            </button>
          </HintItem>
        </Fragment>
      ))}
    </div>
  );
}

export function AttachmentChip({
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
          className="absolute inset-y-0 left-0 bg-success/20 transition-[width] duration-200"
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
          aria-label={`Remove ${attachment.filename}`}
          onClick={() => onRemove(attachment.uploadId)}
          className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-element-active hover:text-foreground cursor-pointer"
        >
          <X size={10} />
        </button>
      </Hint>
    </div>
  );
}
