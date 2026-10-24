/**
 * The foot of the Details card's Session section: where this session's
 * project lives (shared as, folder, origin, root commit), and the session's
 * own actions: comments, share, open in the Timeline, find. The card never
 * repeats the session's name; the title bar shows it.
 *
 * Comments and Share are the Timeline reader's own morphs, not copies. They
 * grow out of a round button IN PLACE, which the card cannot host: it scrolls,
 * and a box growing inside it would be clipped by it. So a click pins the morph
 * over the button in a portal, closed, and opens it the next frame — the same
 * growth, out of the same circle, down and to the left. Closing shrinks it back
 * onto the button before the portal goes.
 *
 * The cloud actions need a synced session (`chat_comment_target`, resolved by
 * `ChatCommentsController`); without one they are disabled, and say why.
 * Find is the thread's own search and works either way.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import { safeUnlistenPromise } from "@/lib/safe-unlisten";
import {
  FolderGit2,
  GitCommitHorizontal,
  Layers,
  MessageCircleDashedCheck,
  Link,
  MessageSquareMore,
  Search,
  type LucideIcon,
} from "lucide-react";
import { GithubIcon } from "@/components/github-icon";
import { CommentsMorph } from "@/features/artifacts/components/comments-morph";
import { ShareMorph } from "@/features/artifacts/components/share-morph";
import type { RowComments } from "@/features/artifacts/components/session-detail";
import { EMPTY_DIRECTORY } from "@/features/artifacts/lib/author-directory";
import { readCachedDetail, writeCachedDetail } from "@/features/artifacts/lib/detail-cache";
import { readSessionDetail } from "@/features/artifacts/lib/read-session-detail";
import { useArtifactsStore } from "@/features/artifacts/stores/artifacts-store";
import type { SessionDetail } from "@/features/artifacts/types";
import { StatusRow } from "@/features/capture/components/status-row";
import { useProjectFacts } from "@/features/capture/lib/project-facts";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { cn } from "@/lib/utils";
import { HintGroup, HintItem } from "@/ui/hint-group";
import { jumpToCommentAnchor } from "@/features/chat/lib/jump-to-comment";
import {
  useChatCommentsStore,
  useCommentCount,
  type CommentTargetIds,
} from "@/features/chat/stores/chat-comments-store";

/** `--morph-close-dur` plus a beat: the portal outlives the shrink. */
const MORPH_UNMOUNT_MS = 300;

type Popup = "comments" | "share";

export function SessionActions({
  tabId,
  projectPath,
  onOpenSearch,
  showProject = true,
}: {
  tabId: string;
  projectPath: string | null;
  onOpenSearch?: () => void;
  /** The project rows. Dropped when the card is short of height (its
   *  `compact` density), which keeps the actions. */
  showProject?: boolean;
}) {
  const target = useChatCommentsStore((s) => s.byTab[tabId]?.target ?? null);
  const commentCount = useCommentCount(tabId);
  const findHint = useActionShortcut("chat.find")?.label;
  const detail = useTargetDetail(target, projectPath);

  // Which morph is pinned over its button, and where. `seq` tells a closing
  // morph's unmount timer apart from the morph opened after it.
  const [popup, setPopup] = useState<{ kind: Popup; rect: DOMRect; seq: number } | null>(null);
  const [morphOpen, setMorphOpen] = useState(false);
  const seq = useRef(0);
  const show = (kind: Popup, button: HTMLElement) => {
    const n = ++seq.current;
    setMorphOpen(false);
    setPopup({ kind, rect: button.getBoundingClientRect(), seq: n });
  };
  useEffect(() => {
    if (!popup) return;
    // Mounted closed this frame; open it the next, so it grows.
    const id = requestAnimationFrame(() => setMorphOpen(true));
    return () => cancelAnimationFrame(id);
  }, [popup]);
  const onOpenChange = (open: boolean) => {
    if (open) return;
    setMorphOpen(false);
    const n = seq.current;
    window.setTimeout(() => setPopup((p) => (p?.seq === n ? null : p)), MORPH_UNMOUNT_MS);
  };

  const comments = useRowComments(tabId);
  const ready = !!target && !!detail;
  const why = "Share this project to Atlas Cloud to use this";

  const openInTimeline = () => {
    if (!target) return;
    useArtifactsStore.getState().actions.openSession({
      sessionId: target.sessionId,
      projectPath: projectPath ?? "",
      remoteProjectId: target.remoteProjectId,
    });
    useLayoutStore.getState().actions.addTab({
      id: "artifacts",
      type: "artifacts",
      title: "Timeline",
      closable: true,
      dirty: false,
      data: {},
    });
  };

  // The project, then a footer: what the actions act on ("Session") on the
  // left, every action together on the right.
  return (
    <>
      {showProject && (
        <div className="space-y-1.5 px-2.5 pt-0.5">
          <ProjectFacts projectPath={projectPath} />
        </div>
      )}

      <HintGroup>
        <div
          className={cn(
            "flex items-center gap-1.5 px-2.5 pb-0.5",
            showProject ? "pt-2.5" : "pt-0.5",
          )}
        >
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
            <MessageCircleDashedCheck size={12} className="shrink-0" aria-hidden />
            <span className="truncate">Session</span>
          </span>
          <RoundButton
            icon={MessageSquareMore}
            label={target ? "Comments" : why}
            disabled={!ready || !comments}
            badge={commentCount ?? 0}
            onClick={(e) => show("comments", e.currentTarget)}
          />
          <RoundButton
            icon={Link}
            label={target ? "Share" : why}
            disabled={!ready}
            onClick={(e) => show("share", e.currentTarget)}
          />
          <RoundButton
            icon={Layers}
            label={target ? "Open in Timeline" : why}
            disabled={!target}
            onClick={openInTimeline}
          />
          <RoundButton
            icon={Search}
            label={findHint ? `Find in session (${findHint})` : "Find in session"}
            disabled={!onOpenSearch}
            onClick={() => onOpenSearch?.()}
          />
        </div>
      </HintGroup>

      {popup &&
        detail &&
        target &&
        createPortal(
          // Pinned by its top-right corner to the button's, so the box grows
          // down and to the left — into the conversation, not off the window.
          <div
            data-session-details-portal
            className="fixed z-popover"
            style={
              {
                top: popup.rect.top,
                right: window.innerWidth - popup.rect.right,
                // Start (and end) the morph at the button's own size.
                "--morph-closed": `${popup.rect.width}px`,
              } as React.CSSProperties
            }
          >
            {popup.kind === "comments" && comments ? (
              <CommentsMorph
                detail={detail}
                comments={comments}
                open={morphOpen}
                onOpenChange={onOpenChange}
                anchorY="top"
                onJump={(anchorId) => jumpToCommentAnchor(tabId, anchorId, detail.summary.id)}
              />
            ) : popup.kind === "share" ? (
              <ShareMorph
                detail={detail}
                projectId={target.remoteProjectId}
                directory={comments?.directory ?? EMPTY_DIRECTORY}
                open={morphOpen}
                onOpenChange={onOpenChange}
                anchorY="top"
                anchorX="end"
              />
            ) : null}
          </div>,
          document.body,
        )}
    </>
  );
}

/** The card's outlined circle — the project sidebar's help button, sized to
 *  the 12px header text it sits beside. */
function RoundButton({
  icon: Icon,
  label,
  disabled,
  badge = 0,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  disabled?: boolean;
  badge?: number;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <HintItem label={label}>
      <button
        type="button"
        aria-label={label}
        // `aria-disabled`, not `disabled`: a disabled button takes no hover,
        // and its tooltip is the only place that says WHY it is off.
        aria-disabled={disabled || undefined}
        onClick={disabled ? undefined : onClick}
        className={cn(
          "relative flex size-[22px] shrink-0 items-center justify-center rounded-full",
          // The page's own fill (black in a dark theme, white in a light one)
          // so the circle reads against the card; the strong border outlines it.
          "border border-border-strong bg-background text-[var(--muted-foreground)] outline-none transition-colors",
          disabled
            ? "cursor-default opacity-40"
            : "cursor-pointer hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]",
        )}
      >
        {/* 10px in a 22px circle: the glyph sits inside the ring with air
            around it, the way the sidebar's help button reads. */}
        <Icon size={10} strokeWidth={2} />
        {badge > 0 && !disabled && (
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center",
              // ratchet-allow: the Timeline's comment count, copied exactly — a count on a
              // saturated red fill needs a fixed light ink, and the theme's destructive
              // foreground is black in every dark theme here.
              "rounded-full bg-[var(--destructive)] px-0.5 text-3xs leading-none font-semibold tabular-nums text-white",
              "ring-2 ring-[var(--card)]",
            )}
          >
            {badge > 9 ? "9+" : badge}
          </span>
        )}
      </button>
    </HintItem>
  );
}

/** The project this session runs in — the capture card's "This project" rows,
 *  plus where it is shared. */
function ProjectFacts({ projectPath }: { projectPath: string | null }) {
  // Cached project-wide (`project-facts.ts`): this body remounts on every
  // expand, and a per-mount read flashed "Reading project…" before the rows.
  const facts = useProjectFacts(projectPath);
  const orgName = useOrgStore((s) =>
    facts?.binding?.orgId
      ? (s.organisations.find((o) => o.remoteId === facts.binding?.orgId)?.name ?? null)
      : null,
  );

  if (!projectPath) return <p className="text-2xs text-[var(--muted-foreground)]">No project</p>;
  if (!facts) return <p className="text-2xs text-[var(--muted-foreground)]">Reading project…</p>;

  const { binding, detection } = facts;
  const root = binding?.root ?? detection?.root ?? projectPath;
  const gitUrl = binding?.gitUrl ?? detection?.gitUrl ?? null;
  const rootSha = binding?.rootCommitSha ?? detection?.rootCommitSha ?? null;
  const cloud = binding?.mode === "cloud" && !!binding.slug;

  return (
    <>
      <StatusRow
        icon={Layers}
        ok={cloud}
        value={cloud ? (orgName ? `${orgName} / ${binding.slug}` : binding.slug!) : "Local only"}
        caption={cloud ? "shared as" : "not shared"}
        mono={false}
      />
      <StatusRow
        icon={FolderGit2}
        ok
        value={root.split("/").pop() ?? root}
        caption="folder"
        mono={false}
      />
      {gitUrl && (
        <StatusRow
          icon={GithubIcon}
          ok
          value={gitUrl.replace(/^https?:\/\//, "")}
          caption="origin"
        />
      )}
      {rootSha && (
        <StatusRow
          icon={GitCommitHorizontal}
          ok
          value={rootSha.slice(0, 7)}
          caption="root commit"
        />
      )}
    </>
  );
}

/** The comments the store holds for this chat, in the Timeline's shape. */
function useRowComments(tabId: string): RowComments | null {
  const tab = useChatCommentsStore((s) => s.byTab[tabId]);
  return useMemo(
    () =>
      tab?.actions && tab.directory
        ? {
            byAnchor: tab.byAnchor,
            session: tab.session,
            actions: tab.actions,
            directory: tab.directory,
          }
        : null,
    [tab?.byAnchor, tab?.session, tab?.actions, tab?.directory],
  );
}

/** The synced session's full record — what the morphs label anchors and
 *  excerpt from. Read through the Timeline's own loader and cache. */
function useTargetDetail(
  target: CommentTargetIds | null,
  projectPath: string | null,
): SessionDetail | null {
  const sessionId = target?.sessionId ?? null;
  const remoteProjectId = target?.remoteProjectId ?? null;
  const ref = useMemo(
    () => (sessionId ? { sessionId, projectPath: projectPath ?? "", remoteProjectId } : null),
    [sessionId, projectPath, remoteProjectId],
  );
  // Seeded from the Timeline's cache, so a remount (every expand) paints the
  // answer it already had instead of reading again.
  const [detail, setDetail] = useState<SessionDetail | null>(() =>
    ref ? (readCachedDetail(ref) ?? null) : null,
  );
  useEffect(() => {
    if (!ref) {
      setDetail(null);
      return;
    }
    let alive = true;
    const load = () =>
      void readSessionDetail(ref)
        .then((d) => {
          if (!alive || !d) return;
          writeCachedDetail(ref, d);
          setDetail(d);
        })
        .catch(() => {});
    const cached = readCachedDetail(ref);
    setDetail(cached ?? null);
    if (!cached) load();
    // Re-read only when capture says THIS session moved (or every cached one
    // is stale — a commit was linked). Everything else is someone else's turn.
    const un = listen<{ sessionIds?: string[]; all?: boolean } | null>(
      "atlas:capture-changed",
      (e) => {
        if (e.payload?.all || e.payload?.sessionIds?.includes(ref.sessionId)) load();
      },
    );
    return () => {
      alive = false;
      safeUnlistenPromise(un);
    };
  }, [ref]);
  return detail;
}
