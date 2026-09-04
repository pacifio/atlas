import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { timeAgo } from "@/lib/time-ago";
import { AudioPlayer } from "./audio-player";
import { MediaLightbox } from "./media-lightbox";
import { formatBytes, saveAttachment } from "./message-group";
import { attachmentPath, cachedAttachmentPath } from "../lib/attachment-cache";
import { useCommsStore } from "../stores/comms-store";
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
          <SectionHead label="Media" />
          <div className="grid grid-cols-3 gap-1">
            {media.map(({ message, attachment }) => (
              <MediaThumb key={attachment.id} attachment={attachment} message={message} />
            ))}
          </div>
        </>
      )}

      {audio.length > 0 && (
        <>
          <SectionHead label="Audio" />
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
          <SectionHead label="Files" />
          <div className="flex flex-col">
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

      <div className="mt-2 flex flex-col items-center gap-1">
        <span className="text-[9.5px] text-text-ghost">
          Files from loaded history · {(messages ?? []).length} messages scanned
        </span>
        <button
          type="button"
          disabled={loadingOlder}
          onClick={loadOlder}
          className="flex h-[24px] items-center gap-1.5 rounded-md border border-border-default bg-bg-hover px-2.5 text-[10.5px] text-text-secondary transition-colors hover:bg-bg-active hover:text-text-primary disabled:opacity-50 cursor-pointer"
        >
          <RefreshCw size={10} className={loadingOlder ? "animate-spin" : ""} />
          Load older messages
        </button>
      </div>
    </div>
  );
}

function SectionHead({ label }: { label: string }) {
  return (
    <div className="px-1 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.06em] text-text-secondary">
      {label}
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
      className="flex w-full items-center gap-2 rounded-md px-1.5 py-[6px] text-left transition-colors hover:bg-bg-hover cursor-pointer"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11.5px] text-text-secondary">
          {attachment.filename}
        </span>
        <span className="block text-[9.5px] text-text-ghost">
          {author?.name ?? "Unknown"} ·{" "}
          {timeAgo(new Date(message.created_at).toISOString(), { suffix: true })} ·{" "}
          {formatBytes(attachment.bytes)}
        </span>
      </span>
    </button>
  );
}
