import { useEffect, useMemo, useState } from "react";
import { FileText, Image as ImageIcon, Music, RefreshCw } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { timeAgo } from "@/lib/time-ago";
import { AudioPlayer } from "./audio-player";
import { CommsAvatar } from "./comms-avatar";
import { MediaLightbox } from "./media-lightbox";
import { formatBytes, saveAttachment } from "./message-group";
import { attachmentPath, cachedAttachmentPath } from "../lib/attachment-cache";
import { useCommsStore } from "../stores/comms-store";
import type { LucideIcon } from "lucide-react";
import type { ChatAttachment, CommsMessage, OrgMemberProfile } from "../types";

/**
 * Every file in the conversation, as far as loaded history reaches.
 *
 * There is no server route listing a conversation's attachments — they ride
 * embedded in messages and nowhere else — so this tab is a PROJECTION over
 * the transcript the store already holds, and its coverage grows with
 * history. The footer says so explicitly and offers to page more in; a
 * silent cap that reads as "that's everything" would be a lie.
 */
export function FilesTab({ convId }: { convId: string }) {
  const messages = useCommsStore((s) => s.messages[convId]);
  const memberList = useCommsStore.use.members();
  const actions = useCommsStore.use.actions();
  const members = useMemo(() => new Map(memberList.map((m) => [m.id, m])), [memberList]);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const entries = useMemo(() => {
    const out: { message: CommsMessage; attachment: ChatAttachment }[] = [];
    for (const m of messages ?? []) {
      if (m.deleted) continue;
      for (const attachment of m.attachments) out.push({ message: m, attachment });
    }
    out.reverse(); // newest first
    return out;
  }, [messages]);

  const media = entries.filter(
    (e) =>
      e.attachment.content_type.startsWith("image/") ||
      e.attachment.content_type.startsWith("video/"),
  );
  const audio = entries.filter((e) => e.attachment.content_type.startsWith("audio/"));
  const files = entries.filter((e) => !media.includes(e) && !audio.includes(e));

  const loadOlder = () => {
    setLoadingOlder(true);
    void actions.loadOlder(convId).finally(() => setLoadingOlder(false));
  };

  return (
    <div className="hide-scrollbar flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 pb-3 pt-2">
      {entries.length === 0 && (
        <p className="px-1 pt-4 text-center text-[11px] text-text-ghost">
          No files in loaded history.
        </p>
      )}

      {media.length > 0 && (
        <>
          <SectionHead
            label="Media"
            icon={ImageIcon}
            onRefresh={loadOlder}
            refreshing={loadingOlder}
          />
          <div className="grid grid-cols-3 gap-1">
            {media.map(({ message, attachment }) => (
              <MediaThumb key={attachment.id} attachment={attachment} message={message} />
            ))}
          </div>
        </>
      )}

      {audio.length > 0 && (
        <>
          <SectionHead label="Audio" icon={Music} onRefresh={loadOlder} refreshing={loadingOlder} />
          <div className="flex flex-col gap-1">
            {audio.map(({ message, attachment }) => (
              <AudioEntry
                key={attachment.id}
                attachment={attachment}
                author={members.get(message.author_id) ?? null}
              />
            ))}
          </div>
        </>
      )}

      {files.length > 0 && (
        <>
          <SectionHead
            label="Files"
            icon={FileText}
            onRefresh={loadOlder}
            refreshing={loadingOlder}
          />
          <div className="flex flex-col gap-1">
            {files.map(({ message, attachment }) => (
              <FileRow
                key={attachment.id}
                attachment={attachment}
                message={message}
                author={members.get(message.author_id) ?? null}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function SectionHead({
  label,
  icon: Icon,
  onRefresh,
  refreshing,
}: {
  label: string;
  icon: LucideIcon;
  /** Pages older history in — this list only sees what the transcript holds,
   *  so "refresh" here honestly means "reach further back". */
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5 px-1 pb-1 pt-2">
      <Icon size={11} className="shrink-0 text-text-secondary" />
      <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-text-secondary">
        {label}
      </span>
      <button
        type="button"
        title="Load older messages"
        disabled={refreshing}
        onClick={onRefresh}
        className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border-default text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50 cursor-pointer"
      >
        <RefreshCw size={9} className={refreshing ? "animate-spin" : ""} />
      </button>
    </div>
  );
}

function MediaThumb({
  attachment,
  message,
}: {
  attachment: ChatAttachment;
  message: CommsMessage;
}) {
  const [path, setPath] = useState<string | null>(
    () => cachedAttachmentPath(attachment.id) ?? null,
  );
  const [failed, setFailed] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const isVideo = attachment.content_type.startsWith("video/");

  useEffect(() => {
    if (path || failed) return;
    let alive = true;
    attachmentPath(attachment.id, attachment.filename)
      .then((p) => alive && setPath(p))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [attachment.id, attachment.filename, path, failed]);

  if (failed) return null;
  return (
    <>
      <button
        type="button"
        title={`${attachment.filename} · ${timeAgo(new Date(message.created_at).toISOString(), { suffix: true })}`}
        onClick={() => path && setZoomed(true)}
        className="relative aspect-square overflow-hidden rounded-md border border-border-subtle bg-bg-elevated cursor-zoom-in"
      >
        {path ? (
          isVideo ? (
            <video src={convertFileSrc(path)} muted className="h-full w-full object-cover" />
          ) : (
            <img
              src={convertFileSrc(path)}
              alt={attachment.filename}
              className="h-full w-full object-cover"
            />
          )
        ) : (
          <span
            className="absolute inset-0 bg-[var(--bg-elevated)]"
            style={{ animation: "atlas-marker-shimmer 1.4s ease-in-out infinite" }}
          />
        )}
      </button>
      {path && (
        <MediaLightbox
          open={zoomed}
          onOpenChange={setZoomed}
          path={path}
          filename={attachment.filename}
        />
      )}
    </>
  );
}

function AudioEntry({
  attachment,
  author,
}: {
  attachment: ChatAttachment;
  author: OrgMemberProfile | null;
}) {
  const [path, setPath] = useState<string | null>(
    () => cachedAttachmentPath(attachment.id) ?? null,
  );

  useEffect(() => {
    if (path) return;
    let alive = true;
    attachmentPath(attachment.id, attachment.filename)
      .then((p) => alive && setPath(p))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [attachment.id, attachment.filename, path]);

  return (
    <AudioPlayer
      src={path ? convertFileSrc(path) : null}
      filename={attachment.filename}
      subtitle={`${author?.name ?? "Unknown"} · ${formatBytes(attachment.bytes)}`}
      onDownload={() => void saveAttachment(attachment)}
    />
  );
}

function FileRow({
  attachment,
  message,
  author,
}: {
  attachment: ChatAttachment;
  message: CommsMessage;
  author: OrgMemberProfile | null;
}) {
  const progress = useCommsStore((s) => s.downloads[attachment.id]);
  return (
    <button
      type="button"
      title={`Download ${attachment.filename}`}
      disabled={progress !== undefined}
      onClick={() => void saveAttachment(attachment)}
      // A surface of its own: on the panel's pure-black card these rows had
      // nothing to sit on and read as floating text.
      className="flex w-full items-center gap-2 rounded-lg bg-[#0D0E0D] px-2.5 py-2 text-left transition-colors hover:bg-bg-hover cursor-pointer"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11.5px] text-text-secondary">
          {attachment.filename}
        </span>
        <span className="mt-0.5 flex items-center gap-1 text-[9.5px] text-text-ghost">
          <CommsAvatar member={author} size={12} />
          <span className="truncate">{author?.name ?? "Unknown"}</span>·
          <span className="shrink-0">
            {timeAgo(new Date(message.created_at).toISOString(), { suffix: true })}
          </span>
          ·<span className="shrink-0">{formatBytes(attachment.bytes)}</span>
        </span>
      </span>
    </button>
  );
}
