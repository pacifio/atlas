import type { ReactNode } from "react";
import { FileText, Folder, Image as ImageIcon, Music, Play, RefreshCw } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  Button,
  EmptyState,
  Hint,
  Icon,
  IconButton,
  SectionHeader,
  Spinner,
} from "@tryatlas/design";
import { CommsAvatar } from "../comms-avatar";
import type { OrgMemberProfile } from "../../types";

export interface FilesTabViewProps {
  /** Rendered tiles, newest first; a section is left out while empty. */
  media: ReactNode[];
  audio: ReactNode[];
  files: ReactNode[];
  loadingOlder: boolean;
  /** Page older history in: this list only sees what the transcript holds. */
  onLoadOlder: () => void;
}

/**
 * Every file in the conversation, as far as loaded history reaches: Media as
 * a grid, then Audio and Files as rows. Each section's header carries a
 * "Load older messages" control — "refresh" here honestly means "reach
 * further back".
 */
export function FilesTabView({
  media,
  audio,
  files,
  loadingOlder,
  onLoadOlder,
}: FilesTabViewProps) {
  const head = (label: string, icon: LucideIcon) => (
    <Section label={label} icon={icon} loadingOlder={loadingOlder} onLoadOlder={onLoadOlder} />
  );
  return (
    <div
      data-view="files-tab"
      className="hide-scrollbar flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 pb-3 pt-2"
    >
      {media.length === 0 && audio.length === 0 && files.length === 0 && (
        // Loaded history may simply not reach back far enough: offer the same
        // way further back the section headers do.
        <EmptyState
          icon={Folder}
          title="No files in loaded history."
          description="Files shared here show up as history loads."
          action={
            <Button variant="outline" size="sm" disabled={loadingOlder} onClick={onLoadOlder}>
              {loadingOlder ? <Spinner size="sm" label="" /> : <Icon icon={RefreshCw} size="sm" />}
              Load older messages
            </Button>
          }
        />
      )}

      {media.length > 0 && (
        <>
          {head("Media", ImageIcon)}
          <div className="grid grid-cols-3 gap-1">{media}</div>
        </>
      )}

      {audio.length > 0 && (
        <>
          {head("Audio", Music)}
          <div className="flex flex-col gap-1">{audio}</div>
        </>
      )}

      {files.length > 0 && (
        <>
          {head("Files", FileText)}
          <div className="flex flex-col gap-1">{files}</div>
        </>
      )}
    </div>
  );
}

function Section({
  label,
  icon,
  loadingOlder,
  onLoadOlder,
}: {
  label: string;
  icon: LucideIcon;
  loadingOlder: boolean;
  onLoadOlder: () => void;
}) {
  return (
    <div className="px-1 pt-2">
      <SectionHeader
        title={label}
        icon={icon}
        action={
          <Hint label="Load older messages">
            <IconButton
              icon={RefreshCw}
              label="Load older messages"
              size="xs"
              variant="hairline"
              shape="round"
              loading={loadingOlder}
              disabled={loadingOlder}
              onClick={onLoadOlder}
            />
          </Hint>
        }
      />
    </div>
  );
}

/** One image or video in the Media grid. `src` is null while it resolves. */
export function MediaTile({
  filename,
  title,
  kind,
  src,
  onOpen,
}: {
  filename: string;
  title: string;
  kind: "image" | "video";
  src: string | null;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={() => src && onOpen()}
      className="relative aspect-square cursor-zoom-in overflow-hidden rounded-md border border-border-subtle bg-card"
    >
      {src ? (
        kind === "video" ? (
          <video src={src} muted className="h-full w-full object-cover" />
        ) : (
          <img src={src} alt={filename} className="h-full w-full object-cover" />
        )
      ) : (
        <span className="absolute inset-0 bg-card atlas-marker-running" />
      )}
      {kind === "video" && (
        <span className="absolute bottom-1 right-1 flex rounded-full bg-card/70 p-0.5 text-foreground">
          <Icon icon={Play} size="xs" />
        </span>
      )}
    </button>
  );
}

/** One file in the Files section: the whole row downloads it. */
export function FileRowView({
  filename,
  author,
  authorName,
  when,
  size,
  downloading,
  onDownload,
}: {
  filename: string;
  author: OrgMemberProfile | null;
  authorName: string;
  when: string;
  size: string;
  downloading: boolean;
  onDownload: () => void;
}) {
  return (
    <button
      type="button"
      title={`Download ${filename}`}
      disabled={downloading}
      onClick={onDownload}
      // A surface of its own: on the panel's pure-black card these rows had
      // nothing to sit on and read as floating text.
      className="flex w-full cursor-pointer items-center gap-2 rounded-lg bg-card px-2.5 py-2 text-left transition-colors duration-fast hover:bg-element-hover"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-secondary-foreground">{filename}</span>
        <span className="mt-0.5 flex items-center gap-1 text-2xs text-disabled">
          <CommsAvatar member={author} size={12} />
          <span className="truncate">{authorName}</span>·<span className="shrink-0">{when}</span>·
          <span className="shrink-0">{size}</span>
        </span>
      </span>
    </button>
  );
}
