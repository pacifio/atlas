import { memo, useEffect, useMemo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Copy,
  CornerUpRight,
  Download,
  Link as LinkIcon,
  FileText,
  Loader2,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  SmilePlus,
  Trash2,
} from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { cn } from "@/lib/utils";
import { copyText } from "@/lib/clipboard";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { comms } from "../lib/comms-api";
import { CommsAvatar } from "./comms-avatar";
import { MessageBody } from "./message-body";
import { MediaLightbox } from "./media-lightbox";
import {
  attachmentPath,
  cachedAttachmentPath,
  cachedRatio,
  rememberRatio,
} from "../lib/attachment-cache";
import { aggregateReactions, formatClock } from "../lib/derive";
import { useCommsStore } from "../stores/comms-store";
import { ArcProgress } from "./arc-progress";
import { AudioPlayer } from "./audio-player";
import { CHAT_REACTION_EMOJI } from "../types";
import type { ChatAttachment, CommsMessage, OrgMemberProfile } from "../types";

/**
 * One author's run of messages, rendered LINEAR — the Discord/Slack shape:
 *
 * ```
 * [avatar]  Name · 12:04
 *           message body, full width
 *           media
 *           reaction chips
 * ```
 *
 * There are no bubbles and no side-switching. The panel is ~390px wide, and a
 * `max-w-[88%]` bubble in that space wrapped almost every sentence and left the
 * timestamp colliding with the text; a linear row gives the body the whole
 * column. `own` therefore no longer changes layout at all — it only decides who
 * is offered Edit.
 *
 * Continuation rows drop the avatar and header entirely and reveal their
 * timestamp in the gutter on hover, which is what keeps a busy channel tight.
 */
interface MessageGroupProps {
  messages: CommsMessage[];
  own: boolean;
  author: OrgMemberProfile | null;
  members: Map<string, OrgMemberProfile>;
  me: string;
  /** Resolves a `reply_to_id` for the quote line. */
  lookup: (id: string) => CommsMessage | undefined;
  onReply: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onReact: (id: string, emoji: string, on: boolean) => void;
  onPin: (id: string, on: boolean) => void;
  /** Jump the transcript to a message id (reply quotes, pin entries). */
  onJump: (id: string) => void;
  /** Channels and group DMs name the author; a 1:1 DM does not need to. */
  showAuthor: boolean;
}

/** The avatar gutter width, shared by the header row and every continuation. */
const GUTTER = "w-9";

export const MessageGroup = memo(function MessageGroup({
  messages,
  own,
  author,
  members,
  me,
  lookup,
  onReply,
  onEdit,
  onDelete,
  onReact,
  onPin,
  onJump,
  showAuthor,
}: MessageGroupProps) {
  return (
    <div className="px-2 py-0.5">
      {messages.map((m, i) => (
        <MessageRow
          key={m.id}
          message={m}
          first={i === 0}
          own={own}
          author={author}
          members={members}
          me={me}
          lookup={lookup}
          onReply={onReply}
          onEdit={onEdit}
          onDelete={onDelete}
          onReact={onReact}
          onPin={onPin}
          onJump={onJump}
          showAuthor={showAuthor}
        />
      ))}
    </div>
  );
});

/**
 * One message. The unit of re-render.
 *
 * Two granularity rules keep the transcript quiet:
 *
 * - **Reactions and pin state are subscribed HERE, per message id.** The store
 *   indexes reactions by message and a selector returning this row's slice (or
 *   a boolean) means a reaction anywhere else changes nothing about this fiber.
 * - **The hover toolbar mounts on first hover, not eagerly.** Three Radix roots
 *   per row across a whole transcript was ~12 idle fibers per message; CSS
 *   already hides the toolbar until hover, so mounting it at that moment is
 *   invisible — and drops the idle cost to zero.
 */
const MessageRow = memo(function MessageRow({
  message,
  first,
  own,
  author,
  members,
  me,
  lookup,
  onReply,
  onEdit,
  onDelete,
  onReact,
  onPin,
  onJump,
  showAuthor,
}: {
  message: CommsMessage;
  first: boolean;
  own: boolean;
  author: OrgMemberProfile | null;
  members: Map<string, OrgMemberProfile>;
  me: string;
  lookup: (id: string) => CommsMessage | undefined;
  onReply: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onReact: (id: string, emoji: string, on: boolean) => void;
  onPin: (id: string, on: boolean) => void;
  onJump: (id: string) => void;
  showAuthor: boolean;
}) {
  const m = message;
  const pinned = useCommsStore((s) => s.pinned.includes(m.id));
  const [hovered, setHovered] = useState(false);
  // Opening a Radix menu moves the pointer and focus into a PORTAL, outside
  // this row — so `onMouseLeave` fires, and if mounting depended on hover alone
  // the toolbar (and the menu inside it) would unmount the instant it opened.
  // The open flag therefore has to live OUT here, above the thing that unmounts.
  const [menuOpen, setMenuOpen] = useState(false);
  const parent = m.reply_to_id ? lookup(m.reply_to_id) : undefined;

  return (
    <div
      data-msg-id={m.id}
      className="group/msg relative flex gap-2 rounded px-1 hover:bg-bg-hover [contain:layout_style]"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className={cn("shrink-0 pt-[3px]", GUTTER)}>
        {first ? (
          <CommsAvatar member={author} size={30} />
        ) : (
          // The gutter is never empty-looking on hover: a continuation
          // reveals its own time where the avatar would be.
          <span className="hidden justify-end pr-0.5 pt-[3px] text-[9.5px] tabular-nums leading-none text-text-ghost group-hover/msg:flex">
            {formatClock(m.created_at)}
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1 pb-0.5">
        {m.reply_to_id && (
          <ReplyLine
            parent={parent}
            author={parent ? (members.get(parent.author_id) ?? null) : null}
            onJump={() => onJump(m.reply_to_id as string)}
          />
        )}

        {first && (
          <div className="flex items-baseline gap-1.5">
            <span className="truncate text-[12px] font-semibold text-text-primary">
              {showAuthor ? (author?.name ?? "Unknown") : (author?.name ?? "You")}
            </span>
            <span className="shrink-0 text-[10px] tabular-nums text-text-ghost">
              {formatClock(m.created_at)}
            </span>
          </div>
        )}

        <MessageContent message={m} members={members} me={me} pinned={pinned} />

        <ReactionRow message={m} members={members} me={me} onReact={onReact} />
      </div>

      {(hovered || menuOpen) && (
        <HoverActions
          onOpenChange={setMenuOpen}
          pinned={pinned}
          canEdit={own && !m.deleted}
          canDelete={!m.deleted}
          onReact={(emoji) => onReact(m.id, emoji, true)}
          onReply={() => onReply(m.id)}
          onEdit={() => onEdit(m.id)}
          onDelete={() => onDelete(m.id)}
          onPin={() => onPin(m.id, !pinned)}
          onCopy={() => void copyText(m.body)}
        />
      )}
    </div>
  );
});

function MessageContent({
  message,
  members,
  me,
  pinned,
}: {
  message: CommsMessage;
  members: Map<string, OrgMemberProfile>;
  me: string;
  pinned: boolean;
}) {
  // The row survives a delete so a reply pointing at it still renders; the body
  // is genuinely gone from the server, so this is a tombstone, not a hide.
  if (message.deleted) {
    return <div className="text-[12.5px] italic text-text-ghost">Message deleted</div>;
  }

  const pending = message.status === "sending";
  const failed = message.status === "failed";
  const hasBody = message.body.trim().length > 0;

  return (
    <div className={cn(pending && "opacity-60")}>
      {hasBody && (
        <div className="flex flex-wrap items-baseline gap-x-1.5">
          <MessageBody
            body={message.body}
            members={members}
            me={me}
            className="min-w-0 flex-1 text-text-secondary"
          />
        </div>
      )}

      {message.attachments.length > 0 && (
        <div className={cn("flex flex-col gap-1.5", hasBody && "mt-1.5")}>
          {message.attachments.map((a) => (
            <AttachmentView key={a.id} attachment={a} />
          ))}
        </div>
      )}

      {(message.edited_at || pinned || pending || failed) && (
        <div className="mt-0.5 flex items-center gap-1.5 text-[9.5px] text-text-ghost">
          {pinned && <Pin size={9} />}
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

/** Discord's one-line quote: who, and the first line of what. */
function ReplyLine({
  parent,
  author,
  onJump,
}: {
  parent: CommsMessage | undefined;
  author: OrgMemberProfile | null;
  onJump: () => void;
}) {
  // A parent can be missing (paged out) or deleted. A deleted parent renders
  // as a stub — a reply must never appear to point at nothing — but a merely
  // paged-out one still jumps: the jump loads history until it finds it.
  const deleted = parent?.deleted === true;
  return (
    <button
      type="button"
      onClick={deleted ? undefined : onJump}
      disabled={deleted}
      title={deleted ? undefined : "Jump to message"}
      className={cn(
        "group/reply flex w-full min-w-0 items-center gap-1 pb-0.5 text-left text-[10.5px] text-text-tertiary",
        !deleted && "cursor-pointer",
      )}
    >
      <CornerUpRight size={10} className="shrink-0 -scale-y-100 opacity-50" />
      <span
        className={cn(
          "shrink-0 font-medium text-text-secondary",
          !deleted && "group-hover/reply:underline",
        )}
      >
        {author?.name ?? "Unknown"}
      </span>
      <span className="min-w-0 truncate opacity-80">
        {deleted ? <span className="italic">original message deleted</span> : (parent?.body ?? "…")}
      </span>
    </button>
  );
}

/**
 * Reaction chips, in normal flow beneath the message.
 *
 * They used to be absolutely positioned at `-bottom-2.5`, which is what made
 * them sit on top of the message's own edge.
 */
function ReactionRow({
  message,
  members,
  me,
  onReact,
}: {
  message: CommsMessage;
  members: Map<string, OrgMemberProfile>;
  me: string;
  onReact: (id: string, emoji: string, on: boolean) => void;
}) {
  // Per-message subscription: a reaction on any OTHER message changes nothing
  // here. The slice keeps identity unless this message's rows changed.
  const rows = useCommsStore((s) => s.reactionsByMessage[message.id]);
  const chips = useMemo(
    () => (rows ? aggregateReactions(rows, message.id, me) : []),
    [rows, message.id, me],
  );
  if (chips.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {chips.map((c) => (
        <button
          key={c.emoji}
          type="button"
          title={c.userIds.map((id) => members.get(id)?.name ?? "Unknown").join(", ")}
          onClick={() => onReact(message.id, c.emoji, !c.mine)}
          className={cn(
            "flex h-[21px] items-center gap-1 rounded-full border px-1.5 text-[11px] leading-none transition-colors cursor-pointer",
            c.mine
              ? "border-[var(--comms-unread)]/60 bg-[var(--comms-unread)]/15 text-text-primary"
              : "border-border-default bg-bg-elevated text-text-secondary hover:bg-bg-hover",
          )}
        >
          <span>{c.emoji}</span>
          <span className="tabular-nums">{c.count}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * One attachment, full width.
 *
 * Images and video render at the column's width with their own aspect ratio, so
 * a picture reads as a picture rather than a thumbnail. The ratio is learned on
 * first decode and cached, which means every later render reserves the right
 * box — the previous `h-[120px]` placeholder had no relationship to the final
 * height, so every image jumped.
 */
function AttachmentView({ attachment }: { attachment: ChatAttachment }) {
  const isImage = attachment.content_type.startsWith("image/");
  const isVideo = attachment.content_type.startsWith("video/");
  const isAudio = attachment.content_type.startsWith("audio/");
  // Audio rides the same eager local-cache fetch as media: the block is
  // interactive the moment it paints, and audio files are small.
  const inline = isImage || isVideo || isAudio;

  const [path, setPath] = useState<string | null>(
    () => cachedAttachmentPath(attachment.id) ?? null,
  );
  const [ratio, setRatio] = useState<number | undefined>(() => cachedRatio(attachment.id));
  const [failed, setFailed] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  // Per-attachment download slice: exists only while the save is in flight.
  const progress = useCommsStore((s) => s.downloads[attachment.id]);
  const downloading = progress !== undefined;

  useEffect(() => {
    if (!inline || path || failed) return;
    let alive = true;
    attachmentPath(attachment.id, attachment.filename)
      .then((p) => alive && setPath(p))
      .catch((e) => {
        console.warn("comms: attachment fetch failed:", attachment.id, e);
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [attachment.id, attachment.filename, inline, path, failed]);

  if (isAudio && !failed) {
    return (
      <AudioPlayer
        src={path ? convertFileSrc(path) : null}
        filename={attachment.filename}
        subtitle={formatBytes(attachment.bytes)}
        buffering={false}
        onDownload={() => void saveAttachment(attachment)}
      />
    );
  }

  if (inline && !failed) {
    // Until the ratio is known, reserve a 16/10 box — close enough for most
    // screenshots that the correction is not a visible jump.
    const box = { aspectRatio: String(ratio ?? 16 / 10) };
    if (!path) {
      return (
        <div
          style={box}
          className="flex w-full max-w-[520px] items-center justify-center rounded-lg border border-border-subtle bg-bg-elevated"
        >
          <Loader2 size={14} className="animate-spin text-text-ghost" />
        </div>
      );
    }
    if (isVideo) {
      return (
        <video
          src={convertFileSrc(path)}
          controls
          preload="metadata"
          style={box}
          className="w-full max-w-[520px] rounded-lg border border-border-subtle bg-black"
        />
      );
    }
    return (
      <>
        <button
          type="button"
          onClick={() => setZoomed(true)}
          style={box}
          className="block w-full max-w-[520px] overflow-hidden rounded-lg border border-border-subtle bg-bg-elevated cursor-zoom-in"
        >
          <img
            src={convertFileSrc(path)}
            alt={attachment.filename}
            draggable={false}
            onLoad={(e) => {
              const el = e.currentTarget;
              rememberRatio(attachment.id, el.naturalWidth, el.naturalHeight);
              if (ratio === undefined && el.naturalHeight > 0) {
                setRatio(el.naturalWidth / el.naturalHeight);
              }
            }}
            onError={() => setFailed(true)}
            className="h-full w-full object-cover [-webkit-user-drag:none]"
          />
        </button>
        <MediaLightbox
          open={zoomed}
          onOpenChange={setZoomed}
          path={path}
          filename={attachment.filename}
        />
      </>
    );
  }

  // Everything else — and any image whose fetch failed — is a file card: a real
  // affordance, not a label. Clicking it downloads; hover reveals copy-link and
  // download. It is a div rather than a button because it CONTAINS buttons, and
  // nesting interactive elements is invalid.
  return (
    <div
      role="button"
      tabIndex={0}
      title={`Download ${attachment.filename}`}
      onClick={() => {
        if (!downloading) void saveAttachment(attachment);
      }}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !downloading) {
          e.preventDefault();
          void saveAttachment(attachment);
        }
      }}
      className="group/file flex max-w-[420px] cursor-pointer items-center gap-2 rounded-lg border border-border-default bg-bg-elevated px-2.5 py-2 transition-colors hover:border-border-strong hover:bg-bg-hover"
    >
      {progress ? (
        <span className="flex h-[15px] w-[15px] shrink-0 items-center justify-center text-[var(--comms-unread)]">
          <ArcProgress got={progress.got} total={progress.total} />
        </span>
      ) : (
        <FileText size={15} className="shrink-0 text-text-tertiary" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11.5px] text-text-secondary">
          {attachment.filename}
        </span>
        <span className="block text-[10px] tabular-nums text-text-ghost">
          {formatBytes(attachment.bytes)}
          {failed && " · could not load"}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/file:opacity-100 focus-within:opacity-100">
        <button
          type="button"
          title="Copy link"
          onClick={(e) => {
            e.stopPropagation();
            void copyAttachmentLink(attachment);
          }}
          className={fileActionBtn}
        >
          <LinkIcon size={12} />
        </button>
        <button
          type="button"
          title="Download"
          disabled={downloading}
          onClick={(e) => {
            e.stopPropagation();
            if (!downloading) void saveAttachment(attachment);
          }}
          className={fileActionBtn}
        >
          <Download size={12} />
        </button>
      </span>
    </div>
  );
}

const fileActionBtn =
  "flex h-6 w-6 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-bg-active hover:text-text-primary cursor-pointer";

/** Save an attachment wherever the user wants it. */
export async function saveAttachment(attachment: ChatAttachment): Promise<void> {
  try {
    const dest = await saveFileDialog({ defaultPath: attachment.filename });
    if (!dest) return;
    await comms.saveAttachment(attachment.id, attachment.filename, dest, attachment.id);
    toast.success(`Saved ${attachment.filename}`);
  } catch (e) {
    console.warn("comms: save attachment failed:", attachment.id, e);
    toast.error("Could not save that file.");
  }
}

/**
 * Copy the attachment's canonical URL.
 *
 * NOT a public share link — this API has no such concept by design (ADR-0010
 * §3: no presigned URLs; `GET /files/{id}` answers a 302 to a ticket that dies
 * in sixty seconds). What this copies is the addressable resource, which
 * resolves for a colleague who is signed in and in the conversation, and 404s
 * for everyone else. The toast says so rather than implying a share.
 */
async function copyAttachmentLink(attachment: ChatAttachment): Promise<void> {
  try {
    const base = await comms.baseUrl();
    const org = useCommsStore.getState().connection.orgId;
    const url = `${base}/files/${attachment.id}${org ? `?org=${org}` : ""}`;
    await copyText(url);
    toast.success("Link copied — opens for members of this conversation.");
  } catch (e) {
    console.warn("comms: copy link failed:", attachment.id, e);
    toast.error("Could not copy that link.");
  }
}

function HoverActions({
  pinned,
  canEdit,
  canDelete,
  onOpenChange,
  onReact,
  onReply,
  onEdit,
  onDelete,
  onPin,
  onCopy,
}: {
  pinned: boolean;
  canEdit: boolean;
  canDelete: boolean;
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
    <div
      className={cn(
        "absolute -top-2.5 right-2 z-10 flex items-center gap-px rounded-md border border-border-default bg-bg-overlay p-0.5 shadow-[var(--shadow-md)]",
        "opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100",
        forceShow && "opacity-100",
      )}
    >
      <Popover.Root open={pickerOpen} onOpenChange={setPickerOpen}>
        <Popover.Trigger asChild>
          <button type="button" title="React" className={actionBtn}>
            <SmilePlus size={12} />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side="top"
            align="end"
            sideOffset={6}
            className="z-[var(--z-modal)] w-[212px] rounded-lg border border-border-default bg-bg-overlay p-1.5 shadow-[var(--shadow-overlay)] animate-scale-in"
          >
            <div className="grid grid-cols-7 gap-0.5">
              {/* Built FROM the allowlist, so no button here can be refused. */}
              {CHAT_REACTION_EMOJI.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => {
                    onReact(e);
                    setPickerOpen(false);
                  }}
                  className="flex h-7 w-7 items-center justify-center rounded text-[14px] transition-colors hover:bg-bg-hover cursor-pointer"
                >
                  {e}
                </button>
              ))}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      <button type="button" title="Reply" onClick={onReply} className={actionBtn}>
        <CornerUpRight size={12} className="-scale-y-100" />
      </button>

      <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenu.Trigger asChild>
          <button type="button" title="More" className={actionBtn}>
            <MoreHorizontal size={12} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            side="top"
            align="end"
            sideOffset={6}
            className="z-[var(--z-modal)] min-w-[168px] rounded-lg border border-border-default bg-bg-overlay p-1 shadow-[var(--shadow-overlay)] animate-scale-in"
          >
            <DropdownMenu.Item onSelect={onCopy} className={menuItem}>
              <Copy size={12} /> Copy text
            </DropdownMenu.Item>
            {/* Pins are SHARED, not personal — anyone's pin is everyone's. */}
            <DropdownMenu.Item onSelect={onPin} className={menuItem}>
              {pinned ? <PinOff size={12} /> : <Pin size={12} />}
              {pinned ? "Unpin for everyone" : "Pin for everyone"}
            </DropdownMenu.Item>
            {(canEdit || canDelete) && (
              <DropdownMenu.Separator className="my-1 h-px bg-border-default" />
            )}
            {/* Author only — an admin can delete but never rewrite. */}
            {canEdit && (
              <DropdownMenu.Item onSelect={onEdit} className={menuItem}>
                <Pencil size={12} /> Edit
              </DropdownMenu.Item>
            )}
            {canDelete && (
              <DropdownMenu.Item
                onSelect={onDelete}
                className={cn(menuItem, "text-error data-[highlighted]:text-error")}
              >
                <Trash2 size={12} /> Delete
              </DropdownMenu.Item>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

const actionBtn =
  "flex h-6 w-6 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary cursor-pointer";

const menuItem =
  "flex items-center gap-2 rounded px-2 py-1.5 text-[11.5px] text-text-secondary outline-none transition-colors data-[highlighted]:bg-bg-hover data-[highlighted]:text-text-primary cursor-pointer";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
