// The session composer's mention chip, on the shared composer core
// (`components/composer/composer-chip.tsx`): a node carrying the whole
// `MentionData`, writing its short form (`composer-short-forms.ts`).
//
// File and folder chips wear the active icon theme's icon for their path —
// the same icon the explorer shows for it. A media `@file` chip previews its
// image or video on hover in place of the path tooltip, but only a chip the
// user picked or dropped (`picked`): a video preview allow-lists the file's
// directory for the asset protocol, and a path typed or pasted as text must
// not be able to do that. A chip rebuilt from text shows its icon and name.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import {
  BookOpen,
  Boxes,
  Bot,
  ClipboardPaste,
  Eye,
  FolderGit2,
  GitBranch,
  Hash,
  Layers,
  MessageSquare,
  MessageSquareCode,
  MessageSquareQuote,
  MessagesSquare,
  PencilLine,
  Quote,
  Scale,
  SquareSlash,
  User,
  X,
} from "lucide-react";

import {
  ComposerChip,
  ComposerPathIcon,
  createChipNode,
  type ComposerChipViewProps,
} from "@/components/composer/composer-chip";
import { SESSION_MENTION } from "../lib/composer-short-forms";
import { toShortForm, type MentionData } from "../lib/mentions";
import { markPicked } from "../lib/picked-mentions";
import { changeProjectAccess, useComposerSessionId } from "../hooks/use-session-projects";
import { useAttachedProject } from "../stores/session-projects-store";

/**
 * What a session chip node carries: the mention, plus whether it came from
 * the picker or a drop. The flag never leaves the composer: `mentionOf`
 * strips it before the mention goes anywhere.
 */
export type SessionChipRecord = MentionData & { picked?: true };

/** A mention the user picked or dropped, as the chip records it. */
export function pickedChip(mention: MentionData): SessionChipRecord {
  return { ...mention, picked: true };
}

/** The mention a chip stands for, without the composer's own flag. */
export function mentionOf(record: SessionChipRecord): MentionData {
  const { picked, ...mention } = record;
  // The flag stays out of the mention, but the send still needs to know
  // which outside paths the user picked (`picked-mentions.ts`).
  if (picked) markPicked(mention as MentionData);
  return mention as MentionData;
}

export const SessionMention = createChipNode<SessionChipRecord>({
  name: SESSION_MENTION,
  toText: toShortForm,
  view: SessionMentionChip,
  // A record in HTML is never trusted: its label could name one file and its
  // data another. The span stays text, as a paste's text would come back.
  fromHTML: () => null,
});

function SessionMentionChip({
  data: mention,
  selected,
  remove,
}: ComposerChipViewProps<SessionChipRecord>) {
  const media = mention.kind === "file" && mention.picked ? mediaKindOf(mention.absPath) : null;
  const preview = useMediaPreview(mention.kind === "file" ? mention.absPath : null, media);
  return (
    <ComposerChip
      icon={<ChipIcon mention={mention} />}
      label={mention.displayName}
      selected={selected}
      title={media ? undefined : chipTitle(mention)}
      data-mention-kind={mention.kind}
      data-mention-id={mention.id}
      onMouseEnter={preview.onEnter}
      onMouseLeave={preview.onLeave}
    >
      {preview.card}
      {(mention.kind === "workspace" || mention.kind === "repo") && (
        <ProjectAccessToggle path={mention.absPath} name={mention.displayName} />
      )}
      {mention.kind === "review_comment" && remove && (
        <ChipRemoveButton
          label={`Remove the comment on ${mention.displayName}`}
          onRemove={remove}
        />
      )}
    </ComposerChip>
  );
}

/**
 * The access a project chip's session holds on it, as a one-click toggle:
 * read-only (the default an `@` mention attaches with) or read and write.
 * Shown only once the project is attached — a chip in a session that has not
 * bound yet is attached, read-only, when the message is sent.
 */
function ProjectAccessToggle({ path, name }: { path: string; name: string }) {
  const sessionId = useComposerSessionId();
  const attached = useAttachedProject(sessionId, path.replace(/\/+$/, ""));
  if (!sessionId || !attached) return null;
  const writable = attached.access === "read_write";
  const label = writable
    ? `${name}: the agent can edit files here. Click to make it read-only.`
    : `${name}: read-only for the agent. Click to let it edit files here.`;
  return (
    <button
      type="button"
      className="inline-flex items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
      title={label}
      aria-label={label}
      aria-pressed={writable}
      data-project-access={attached.access}
      // Keep the caret in the composer: a press must not take focus from it.
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation();
        void changeProjectAccess(sessionId, attached.path, writable ? "read_only" : "read_write");
      }}
    >
      {writable ? <PencilLine size={10} /> : <Eye size={10} />}
    </button>
  );
}

/**
 * A review comment's ×: the comment was written elsewhere (the diff, the file
 * view), so taking it back out of the prompt gets a button of its own rather
 * than only a Backspace beside it. Its annotation goes with it, since the
 * diff and the file view read the draft.
 */
function ChipRemoveButton({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <button
      type="button"
      className="inline-flex items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
      title={label}
      aria-label={label}
      data-chip-remove
      // Keep the caret in the composer: a press must not take focus from it.
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation();
        onRemove();
      }}
    >
      <X size={10} />
    </button>
  );
}

/** Paths wear the icon theme; every other kind its picker glyph. */
function ChipIcon({ mention }: { mention: MentionData }) {
  const size = 11;
  switch (mention.kind) {
    case "file":
      return <ComposerPathIcon path={mention.absPath} />;
    case "folder":
      return <ComposerPathIcon path={mention.absPath} folder />;
    case "component":
      switch (mention.componentKind) {
        case "command":
          return <SquareSlash size={size} />;
        case "agent":
          return <Bot size={size} />;
        case "rule":
          return <Scale size={size} />;
      }
      return <Hash size={size} />;
    case "symbol":
      return <Hash size={size} />;
    case "knowledge":
      return <BookOpen size={size} />;
    case "repo":
      return <FolderGit2 size={size} />;
    case "workspace":
      return <Boxes size={size} />;
    case "branch":
      return <GitBranch size={size} />;
    case "past_message":
    case "past_session":
      return <MessageSquare size={size} />;
    // Organisation kinds wear their surfaces' icons, so a recorded session
    // never reads as a past session (same choice as the picker).
    case "member":
      return <User size={size} />;
    case "conversation":
      return <MessagesSquare size={size} />;
    case "recorded_session":
      return <Layers size={size} />;
    case "comment":
      return <MessageSquareQuote size={size} />;
    case "pasted_text":
      return <ClipboardPaste size={size} />;
    case "cited_text":
      return <Quote size={size} />;
    case "review_comment":
      return <MessageSquareCode size={size} />;
  }
}

function chipTitle(m: MentionData): string {
  switch (m.kind) {
    case "file":
    case "folder":
    case "repo":
    case "workspace":
      return m.absPath;
    case "symbol":
      return `${m.symbolKind} · ${m.filePath}:${m.line}`;
    case "knowledge":
      return `${m.source} · ${m.filePath}`;
    case "component":
      return m.description || m.displayName;
    case "branch":
      return `${m.refKind} · ${m.sha.slice(0, 7)}`;
    case "past_message":
      return m.sessionTitle;
    case "past_session":
      return `session · ${m.sessionTitle}`;
    case "member":
      return `member · ${m.email}`;
    case "conversation":
      return `conversation · ${m.displayName}`;
    case "recorded_session":
      return `recorded session · ${m.displayName}`;
    case "comment":
      return `${m.parentId ? "reply" : "comment"} on ${m.anchorLabel} · ${m.authorName}: ${m.body}`;
    case "pasted_text":
      // The first lines, so a hover tells two pastes apart.
      return m.text.split("\n").slice(0, 12).join("\n");
    case "cited_text": {
      // The passage, then the note: what the agent will be pointed at.
      const quote = m.text.split("\n").slice(0, 12).join("\n");
      return m.note ? `${quote}\n\nNote: ${m.note}` : quote;
    }
    case "review_comment": {
      // The comment, then the lines it is on: what the agent will be sent.
      const lines = m.diff.split("\n").slice(0, 12).join("\n");
      return `${m.text}\n\n${m.filePath} ${m.rangeLabel}\n${lines}`;
    }
  }
}

// ── Media hover preview (image/video `@file` chips) ──────────────────────────

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "bmp",
  "svg",
  "heic",
  "heif",
]);
const VIDEO_EXTS = new Set(["mp4", "mov", "webm", "m4v", "avi", "mkv", "ogv"]);

function mediaKindOf(path: string): "image" | "video" | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  return null;
}

function imageMime(path: string): string {
  switch (path.split(".").pop()?.toLowerCase() ?? "") {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "bmp":
      return "image/bmp";
    case "avif":
      return "image/avif";
    case "heic":
    case "heif":
      return "image/heic";
    default:
      return "image/png";
  }
}

/** Images come in as base64 (small, and the asset protocol 403s `.atlas`
 *  paths); video streams through `convertFileSrc` once its directory is
 *  allow-listed, so a whole video is never read into memory. */
async function mediaSrc(path: string, media: "image" | "video"): Promise<string | null> {
  if (media === "image") {
    try {
      const b64 = await invoke<string>("read_file_base64", { path });
      return `data:${imageMime(path)};base64,${b64}`;
    } catch {
      return null;
    }
  }
  const i = path.lastIndexOf("/");
  try {
    await invoke("asset_allow_dir", { path: i > 0 ? path.slice(0, i) : path });
  } catch {
    /* may already be allowed, or denied — try to render anyway */
  }
  return convertFileSrc(path);
}

/** A preview card above a media chip after a short hover, portalled to the
 *  body and clamped into the viewport. Nothing loads until the hover lands. */
function useMediaPreview(path: string | null, media: "image" | "video" | null) {
  const [card, setCard] = useState<{ src: string; left: number; bottom: number } | null>(null);
  const hovering = useRef(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      hovering.current = false;
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  if (!path || !media) return { onEnter: undefined, onLeave: undefined, card: null };

  const onEnter = (e: React.MouseEvent<HTMLElement>) => {
    const anchor = e.currentTarget;
    hovering.current = true;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      const src = await mediaSrc(path, media);
      if (!src || !hovering.current) return;
      const r = anchor.getBoundingClientRect();
      setCard({
        src,
        left: Math.max(8, Math.min(r.left, window.innerWidth - 436)),
        bottom: Math.max(8, window.innerHeight - r.top + 6),
      });
    }, 200);
  };
  const onLeave = () => {
    hovering.current = false;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    setCard(null);
  };

  return {
    onEnter,
    onLeave,
    card: card
      ? createPortal(
          <div
            className="atlas-mention-preview"
            style={{ position: "fixed", left: card.left, bottom: card.bottom }}
          >
            {media === "image" ? (
              <img src={card.src} alt="" className="atlas-mention-preview__media" />
            ) : (
              <video
                src={card.src}
                muted
                autoPlay
                loop
                playsInline
                className="atlas-mention-preview__media"
              />
            )}
          </div>,
          document.body,
        )
      : null,
  };
}
