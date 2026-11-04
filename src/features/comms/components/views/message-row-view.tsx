import { useEffect, useState, type ReactNode } from "react";
import {
  Copy,
  CornerUpRight,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  SmilePlus,
  Trash2,
} from "lucide-react";
import {
  Badge,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  HintGroup,
  HintItem,
  Icon,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@tryatlas/design";
import { cn } from "@/lib/utils";
import { CommsAvatar, IntegrationAvatar } from "../comms-avatar";
import { isWebhookMessage, presentAuthor } from "../../lib/message-author";
import { formatClock, type ReactionChip } from "../../lib/derive";
import type { CommsMessage, OrgMemberProfile } from "../../types";

export interface MessageRowViewProps {
  message: CommsMessage;
  /** Heads its group: draws the avatar and the name line. */
  first: boolean;
  author: OrgMemberProfile | null;
  /** `undefined` for an unresolved author: no presence dot at all. */
  authorOnline: boolean | undefined;
  /** Channels and group DMs name the author; a 1:1 DM does not need to. */
  showAuthor: boolean;
  pinned: boolean;
  reactions: readonly ReactionChip[];
  memberName: (id: string) => string;
  /** The message this one replies to; `undefined` while it is paged out. */
  replyParent: CommsMessage | undefined;
  /** Who wrote the parent, already resolved (integrations by their posted name). */
  replyParentName: string;
  /** The parent's first line, already flattened by `toPlainText`. */
  replyPreview: string;
  canEdit: boolean;
  canDelete: boolean;
  /** The server's reaction allowlist; the picker is built from it. */
  reactionEmoji: readonly string[];
  onReact: (emoji: string, on: boolean) => void;
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onPin: () => void;
  onCopy: () => void;
  onJumpToParent: () => void;
  /** The rendered markdown body (absent when the message has none). */
  body: ReactNode;
  attachments: ReactNode;
  references: ReactNode;
}

/** The avatar gutter width, shared by the header row and every continuation. */
const GUTTER = "w-9";

/**
 * One message, rendered LINEAR — the Discord/Slack shape:
 *
 * ```
 * [avatar]  Name · 12:04
 *           message body, full width
 *           media
 *           reaction chips
 * ```
 *
 * Continuation rows drop the avatar and header entirely and reveal their
 * timestamp in the gutter on hover, which is what keeps a busy channel tight.
 *
 * **The hover toolbar mounts on first hover, not eagerly.** Three popup roots
 * per row across a whole transcript was ~12 idle fibers per message; CSS
 * already hides the toolbar until hover, so mounting it at that moment is
 * invisible — and drops the idle cost to zero. Keyboard focus entering the row
 * (a reply line, a reaction chip, a link in the body) mounts it too, so the
 * next Tab reaches React, Reply and More.
 *
 * **A deleted message is only its tombstone**: no reply line, no reactions,
 * and a toolbar that offers nothing but a disabled Copy — there is no text left
 * to copy, nothing to react or reply to, and pinning a tombstone pins nothing.
 */
export function MessageRowView({
  message: m,
  first,
  author,
  authorOnline,
  showAuthor,
  pinned,
  reactions,
  memberName,
  replyParent,
  replyParentName,
  replyPreview,
  canEdit,
  canDelete,
  reactionEmoji,
  onReact,
  onReply,
  onEdit,
  onDelete,
  onPin,
  onCopy,
  onJumpToParent,
  body,
  attachments,
  references,
}: MessageRowViewProps) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  // Opening a menu moves the pointer and focus into a PORTAL, outside this
  // row — so `onMouseLeave` fires, and if mounting depended on hover alone the
  // toolbar (and the menu inside it) would unmount the instant it opened. The
  // open flag therefore has to live OUT here, above the thing that unmounts.
  const [menuOpen, setMenuOpen] = useState(false);
  const webhook = isWebhookMessage(m);
  const presented = presentAuthor(m, memberName);

  return (
    <div
      data-msg-id={m.id}
      className="group/msg relative flex gap-2 rounded px-1 py-px hover:bg-element-hover [contain:layout_style]"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        // Focus moving between the row's own controls (chip -> toolbar) keeps
        // the toolbar; only focus leaving the row drops it.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <div className={cn("shrink-0 pt-[3px]", GUTTER)}>
        {first && webhook ? (
          <IntegrationAvatar id={m.author_id} name={presented.name} size={30} />
        ) : first ? (
          <CommsAvatar member={author} size={30} online={authorOnline} />
        ) : (
          // The gutter is never empty-looking on hover: a continuation
          // reveals its own time where the avatar would be.
          <span className="hidden justify-end pr-0.5 pt-[3px] text-2xs tabular-nums leading-none text-disabled group-hover/msg:flex">
            {formatClock(m.created_at)}
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1 pb-1">
        {m.reply_to_id && !m.deleted && (
          <ReplyLine
            deleted={replyParent?.deleted === true}
            loaded={replyParent !== undefined}
            name={replyParentName}
            preview={replyPreview}
            onJump={onJumpToParent}
          />
        )}

        {first && webhook ? (
          // An integration is named however its DM-ness: there is no "You" or
          // counterpart to fall back on, and the badge is the whole point.
          <div className="flex min-w-0 items-baseline gap-1.5" title={presented.title ?? undefined}>
            <span className="truncate text-sm font-semibold text-foreground">{presented.name}</span>
            <Badge variant="outline" size="sm" className="self-center">
              <span className="uppercase tracking-wider">App</span>
            </Badge>
            {presented.via && (
              <span className="min-w-0 truncate text-2xs text-muted-foreground">
                via {presented.via}
              </span>
            )}
            <span className="shrink-0 text-2xs tabular-nums text-disabled">
              {formatClock(m.created_at)}
            </span>
          </div>
        ) : (
          first && (
            <div className="flex items-baseline gap-1.5">
              <span className="truncate text-sm font-semibold text-foreground">
                {showAuthor ? (author?.name ?? "Unknown") : (author?.name ?? "You")}
              </span>
              <span className="shrink-0 text-2xs tabular-nums text-disabled">
                {formatClock(m.created_at)}
              </span>
            </div>
          )
        )}

        <MessageContent
          message={m}
          pinned={pinned}
          body={body}
          attachments={attachments}
          references={references}
        />

        {reactions.length > 0 && !m.deleted && (
          // In normal flow beneath the message: absolutely positioned chips
          // sat on top of the message's own edge.
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {reactions.map((c) => (
              <button
                key={c.emoji}
                type="button"
                aria-pressed={c.mine}
                title={c.userIds.map(memberName).join(", ")}
                onClick={() => onReact(c.emoji, !c.mine)}
                className={cn(
                  "flex h-[21px] cursor-pointer items-center gap-1 rounded-full border px-1.5 text-xs leading-none transition-colors duration-fast",
                  c.mine
                    ? "border-success/60 bg-success/15 text-foreground"
                    : "border-border bg-card text-secondary-foreground hover:bg-element-hover",
                )}
              >
                <span>{c.emoji}</span>
                <span className="tabular-nums">{c.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {(hovered || focused || menuOpen) && (
        <HoverActions
          onOpenChange={setMenuOpen}
          deleted={m.deleted === true}
          pinned={pinned}
          canEdit={canEdit}
          canDelete={canDelete}
          reactionEmoji={reactionEmoji}
          onReact={(emoji) => onReact(emoji, true)}
          onReply={onReply}
          onEdit={onEdit}
          onDelete={onDelete}
          onPin={onPin}
          onCopy={onCopy}
        />
      )}
    </div>
  );
}

function MessageContent({
  message,
  pinned,
  body,
  attachments,
  references,
}: {
  message: CommsMessage;
  pinned: boolean;
  body: ReactNode;
  attachments: ReactNode;
  references: ReactNode;
}) {
  // The row survives a delete so a reply pointing at it still renders; the body
  // is genuinely gone from the server, so this is a tombstone, not a hide.
  if (message.deleted) {
    return <div className="text-base italic text-disabled">Message deleted</div>;
  }

  const pending = message.status === "sending";
  const failed = message.status === "failed";
  const hasBody = message.body.trim().length > 0;
  const hasAttachments = message.attachments.length > 0;
  const hasReferences = (message.artifact_refs ?? []).length > 0;

  return (
    <div className={cn(pending && "opacity-60")}>
      {hasBody && <div className="flex flex-wrap items-baseline gap-x-1.5">{body}</div>}

      {hasAttachments && (
        <div className={cn("flex flex-col gap-1.5", hasBody && "mt-1.5")}>{attachments}</div>
      )}

      {/* Session References — from the web's picker or the agent's
          `org_send` alike: each opens its recorded session on the Timeline. */}
      {hasReferences && (
        <div className={cn("flex flex-col gap-1.5", (hasBody || hasAttachments) && "mt-1.5")}>
          {references}
        </div>
      )}

      {(message.edited_at || pinned || pending || failed) && (
        <div className="mt-0.5 flex items-center gap-1.5 text-2xs text-disabled">
          {pinned && <Icon icon={Pin} size="xs" />}
          {message.edited_at && <span className="italic">edited</span>}
          {/* Two rungs only — nothing on this wire reports that a message
              reached a device, so there is no "delivered". */}
          {pending && <span>sending…</span>}
          {failed && <span className="text-error">failed to send</span>}
        </div>
      )}
    </div>
  );
}

/**
 * Discord's one-line quote: who, and the first line of what.
 *
 * A parent can be missing (paged out) or deleted. A deleted parent renders as
 * a stub — a reply must never appear to point at nothing — but a merely
 * paged-out one still jumps: the jump loads history until it finds it.
 */
function ReplyLine({
  deleted,
  loaded,
  name,
  preview,
  onJump,
}: {
  deleted: boolean;
  loaded: boolean;
  name: string;
  preview: string;
  onJump: () => void;
}) {
  return (
    <button
      type="button"
      onClick={deleted ? undefined : onJump}
      disabled={deleted}
      title={deleted ? undefined : "Jump to message"}
      className={cn(
        "group/reply flex w-full min-w-0 items-center gap-1 pb-0.5 text-left text-xs text-muted-foreground",
        !deleted && "cursor-pointer",
      )}
    >
      <span className="flex shrink-0 opacity-50">
        <Icon icon={CornerUpRight} size="xs" className="-scale-y-100" />
      </span>
      <span
        className={cn(
          "shrink-0 font-medium text-secondary-foreground",
          !deleted && "group-hover/reply:underline",
        )}
      >
        {name}
      </span>
      <span className="min-w-0 truncate opacity-80">
        {deleted ? (
          <span className="italic">original message deleted</span>
        ) : loaded ? (
          preview
        ) : (
          "…"
        )}
      </span>
    </button>
  );
}

function HoverActions({
  deleted,
  pinned,
  canEdit,
  canDelete,
  reactionEmoji,
  onOpenChange,
  onReact,
  onReply,
  onEdit,
  onDelete,
  onPin,
  onCopy,
}: {
  /** A tombstone: only a disabled Copy is offered. */
  deleted: boolean;
  pinned: boolean;
  canEdit: boolean;
  canDelete: boolean;
  reactionEmoji: readonly string[];
  /** Tells the row to keep this mounted while a menu is open. */
  onOpenChange: (open: boolean) => void;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onPin: () => void;
  onCopy: () => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const forceShow = pickerOpen || menuOpen;
  useEffect(() => {
    onOpenChange(forceShow);
  }, [forceShow, onOpenChange]);

  return (
    <HintGroup side="top">
      <div
        className={cn(
          "absolute -top-2.5 right-2 z-10 flex items-center gap-px rounded-md border border-border bg-popover p-0.5 shadow-md",
          "opacity-0 transition-opacity duration-fast group-hover/msg:opacity-100 group-focus-within/msg:opacity-100",
          forceShow && "opacity-100",
        )}
      >
        {!deleted && (
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <HintItem label="React">
              <PopoverTrigger render={<IconButton icon={SmilePlus} label="React" size="xs" />} />
            </HintItem>
            <PopoverContent side="top" align="end" sideOffset={6} className="w-[212px] gap-0 p-1.5">
              <div className="grid grid-cols-7 gap-0.5">
                {/* Built FROM the allowlist, so no button here can be refused. */}
                {reactionEmoji.map((e) => (
                  <button
                    key={e}
                    type="button"
                    onClick={() => {
                      onReact(e);
                      setPickerOpen(false);
                    }}
                    className="flex size-7 cursor-pointer items-center justify-center rounded text-md transition-colors duration-fast hover:bg-element-hover"
                  >
                    {e}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        )}

        {!deleted && (
          <HintItem label="Reply">
            <IconButton
              icon={<Icon icon={CornerUpRight} size="xs" className="-scale-y-100" />}
              label="Reply"
              size="xs"
              onClick={onReply}
            />
          </HintItem>
        )}

        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <HintItem label="More">
            <DropdownMenuTrigger
              render={<IconButton icon={MoreHorizontal} label="More" size="xs" />}
            />
          </HintItem>
          <DropdownMenuContent side="top" align="end" sideOffset={6} className="min-w-[168px]">
            <DropdownMenuItem onClick={onCopy} disabled={deleted}>
              <Icon icon={Copy} size="sm" /> Copy text
            </DropdownMenuItem>
            {/* Pins are SHARED, not personal — anyone's pin is everyone's. */}
            {!deleted && (
              <DropdownMenuItem onClick={onPin}>
                <Icon icon={pinned ? PinOff : Pin} size="sm" />
                {pinned ? "Unpin for everyone" : "Pin for everyone"}
              </DropdownMenuItem>
            )}
            {(canEdit || canDelete) && <DropdownMenuSeparator />}
            {/* Author only — an admin can delete but never rewrite. */}
            {canEdit && (
              <DropdownMenuItem onClick={onEdit}>
                <Icon icon={Pencil} size="sm" /> Edit
              </DropdownMenuItem>
            )}
            {canDelete && (
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Icon icon={Trash2} size="sm" /> Delete
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </HintGroup>
  );
}
