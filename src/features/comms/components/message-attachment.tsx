import { memo, useEffect, useState } from "react";
import { Download, FileText, Link as LinkIcon } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { HintGroup, HintItem, Icon, IconButton, Spinner } from "@tryatlas/design";
import { openConversationMedia } from "../stores/lightbox-store";
import { useCommsStore } from "../stores/comms-store";
import {
  attachmentPath,
  cachedAttachmentPath,
  cachedRatio,
  rememberRatio,
} from "../lib/attachment-cache";
import { copyAttachmentLink, saveAttachment } from "../lib/attachment-actions";
import { formatBytes } from "../lib/derive";
import { ArcProgress } from "./arc-progress";
import { AudioPlayer } from "./audio-player";
import type { ChatAttachment } from "../types";

/**
 * One attachment, full width.
 *
 * Images and video render at the column's width with their own aspect ratio, so
 * a picture reads as a picture rather than a thumbnail. The ratio is learned on
 * first decode and cached, which means every later render reserves the right
 * box — the previous `h-[120px]` placeholder had no relationship to the final
 * height, so every image jumped.
 */
export const MessageAttachment = memo(function MessageAttachment({
  attachment,
  convId,
}: {
  attachment: ChatAttachment;
  convId: string;
}) {
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
          className="flex w-full max-w-[520px] items-center justify-center rounded-lg border border-border-subtle bg-card"
        >
          <Spinner size="md" label="" />
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
          className="w-full max-w-[520px] rounded-lg border border-border-subtle bg-popover"
        />
      );
    }
    return (
      <button
        type="button"
        onClick={() => openConversationMedia(convId, attachment.id)}
        style={box}
        className="block w-full max-w-[520px] cursor-zoom-in overflow-hidden rounded-lg border border-border-subtle bg-card"
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
      // A name rather than a native `title`: the title would also show over
      // the action buttons inside, on top of their own tooltips.
      aria-label={`Download ${attachment.filename}`}
      onClick={() => {
        if (!downloading) void saveAttachment(attachment);
      }}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !downloading) {
          e.preventDefault();
          void saveAttachment(attachment);
        }
      }}
      className="group/file flex max-w-[420px] cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-2 transition-colors duration-fast hover:border-border-strong hover:bg-element-hover"
    >
      {progress ? (
        <span className="flex size-4 shrink-0 items-center justify-center text-success">
          <ArcProgress got={progress.got} total={progress.total} />
        </span>
      ) : (
        <Icon icon={FileText} size="lg" className="text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-secondary-foreground">
          {attachment.filename}
        </span>
        <span className="block text-2xs tabular-nums text-disabled">
          {formatBytes(attachment.bytes)}
          {failed && " · could not load"}
        </span>
      </span>
      <HintGroup>
        <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-fast group-hover/file:opacity-100 focus-within:opacity-100">
          <HintItem label="Copy link">
            <IconButton
              icon={LinkIcon}
              label="Copy link"
              size="xs"
              onClick={(e) => {
                e.stopPropagation();
                void copyAttachmentLink(attachment);
              }}
            />
          </HintItem>
          <HintItem label="Download">
            <IconButton
              icon={Download}
              label="Download"
              size="xs"
              disabled={downloading}
              onClick={(e) => {
                e.stopPropagation();
                if (!downloading) void saveAttachment(attachment);
              }}
            />
          </HintItem>
        </span>
      </HintGroup>
    </div>
  );
});
