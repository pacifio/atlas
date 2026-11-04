import { useEffect, useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { timeAgo } from "@/lib/time-ago";
import { AudioPlayer } from "./audio-player";
import { FileRowView, FilesTabView, MediaTile } from "./views/files-tab-view";
import { saveAttachment } from "../lib/attachment-actions";
import { formatBytes } from "../lib/derive";
import { attachmentPath, cachedAttachmentPath } from "../lib/attachment-cache";
import { useCommsStore } from "../stores/comms-store";
import { openMediaList, toLightboxItem, type LightboxItem } from "../stores/lightbox-store";
import type { ChatAttachment, CommsMessage, OrgMemberProfile } from "../types";

/**
 * Every file in the conversation, as far as loaded history reaches.
 *
 * There is no server route listing a conversation's attachments — they ride
 * embedded in messages and nowhere else — so this tab is a PROJECTION over
 * the transcript the store already holds, and its coverage grows with
 * history. Each section offers to page more in; a silent cap that reads as
 * "that's everything" would be a lie.
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
  // The gallery walks this grid's own order (newest first), not the transcript's.
  const gallery = useMemo(
    () => media.map((e) => toLightboxItem(e.attachment)).filter((i): i is LightboxItem => !!i),
    [media],
  );
  const audio = entries.filter((e) => e.attachment.content_type.startsWith("audio/"));
  const files = entries.filter((e) => !media.includes(e) && !audio.includes(e));

  const loadOlder = () => {
    setLoadingOlder(true);
    void actions.loadOlder(convId).finally(() => setLoadingOlder(false));
  };

  return (
    <FilesTabView
      media={media.map(({ message, attachment }) => (
        <MediaThumb
          key={attachment.id}
          attachment={attachment}
          message={message}
          gallery={gallery}
        />
      ))}
      audio={audio.map(({ message, attachment }) => (
        <AudioEntry
          key={attachment.id}
          attachment={attachment}
          author={members.get(message.author_id) ?? null}
        />
      ))}
      files={files.map(({ message, attachment }) => (
        <FileRow
          key={attachment.id}
          attachment={attachment}
          message={message}
          author={members.get(message.author_id) ?? null}
        />
      ))}
      loadingOlder={loadingOlder}
      onLoadOlder={loadOlder}
    />
  );
}

function MediaThumb({
  attachment,
  message,
  gallery,
}: {
  attachment: ChatAttachment;
  message: CommsMessage;
  gallery: LightboxItem[];
}) {
  const [path, setPath] = useState<string | null>(
    () => cachedAttachmentPath(attachment.id) ?? null,
  );
  const [failed, setFailed] = useState(false);
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
    <MediaTile
      filename={attachment.filename}
      title={`${attachment.filename} · ${timeAgo(new Date(message.created_at).toISOString(), { suffix: true })}`}
      kind={isVideo ? "video" : "image"}
      src={path ? convertFileSrc(path) : null}
      onOpen={() => openMediaList(gallery, attachment.id)}
    />
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
    <FileRowView
      filename={attachment.filename}
      author={author}
      authorName={author?.name ?? "Unknown"}
      when={timeAgo(new Date(message.created_at).toISOString(), { suffix: true })}
      size={formatBytes(attachment.bytes)}
      downloading={progress !== undefined}
      onDownload={() => void saveAttachment(attachment)}
    />
  );
}
