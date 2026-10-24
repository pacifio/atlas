// The pull request's Code tab: its files in the diff panel (`DiffPanel` with
// a pull request source), GitHub's Viewed marks on every file, review
// threads on their lines, and new line comments from the gutter.
//
//  - Files come a page at a time (`usePrDiffPages`): the first page at once,
//    the next as the reader nears the end of what has loaded.
//  - "All commits" or one commit, picked where the session diff's turn picker
//    sits. A commit's diff counts lines within that commit, and a review
//    thread is anchored to the whole change, so on a commit every thread is
//    listed above the diff rather than pinned to a line that may hold other
//    code, and no new line comment can be started.
//  - Unchanged lines around a hunk expand from both sides of the file at the
//    pull request's base and head (`pr_diff_file_contents`).
//  - Files read source first, each after what it imports, then tests, then
//    generated files (`pull-request-file-order.ts`).
//  - Picked lines open a box that comments on them or asks an agent session
//    about them ("Ask about these lines"); a reader who may not comment can
//    still ask.

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type {
  CodeViewItem,
  DiffLineAnnotation,
  FileDiffContentsLoader,
  LineAnnotation,
  SelectedLineRange,
} from "@pierre/diffs";
import { ChevronDown, ChevronRight, Info, MessageSquareOff, TriangleAlert } from "lucide-react";

import { DiffPanel } from "@/features/git/components/diff-viewer/diff-panel";
import { DiffPanelSkeleton } from "@/features/git/components/diff-viewer/diff-panel-skeleton";
import {
  DiffEmpty,
  itemIdOf,
  useDiffIgnoreWhitespace,
  type DiffAnnotation,
  type DiffAnnotationSource,
  type DiffViewSource,
} from "@/features/git/components/diff-viewer/diff-panel-view";
import { fnv1a32 } from "@/features/git/lib/diff-rendering";
import type { ReviewFile } from "@/features/git/lib/use-review-files";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { Hint } from "@/ui/tooltip";

import { classifyPrError } from "../lib/pr-errors";
import { fileDiffLines, orderDiffFiles } from "../lib/pull-request-file-order";
import { fileDiffRows, pickedLines } from "../lib/pull-request-guide-tour";
import type { PickedLines } from "../lib/pull-request-handoff";
import {
  isLineInFileDiff,
  pendingCommentPlacement,
  positionAnchor,
  prDiffFiles,
  resolveReviewPosition,
  viewerSideOf,
  type PrReviewFile,
} from "../lib/pull-request-diff";
import { prDiffFileContents } from "../lib/pull-requests-api";
import {
  usePrCommitPages,
  usePrDiffPages,
  usePrSubmitReviewMutation,
} from "../lib/pull-requests-queries";
import type {
  PrActivity,
  PrCommit,
  PrDetail,
  PrDiffSide,
  PrFileChangeType,
  PrReviewPosition,
  PrReviewThread,
} from "../lib/pull-requests-types";
import { useAutoNextPage } from "../lib/use-auto-next-page";
import { readableFailure } from "../lib/use-pull-request-actions";
import { usePullRequestFilesViewed } from "../lib/use-pull-request-files-viewed";
import {
  nextPendingCommentId,
  reviewKeyOf,
  usePendingReviewComments,
  usePullRequestReviewStore,
  type PendingReviewComment,
} from "../stores/pull-request-review-store";
import {
  patchPullRequestTabDraft,
  readPullRequestTabDraft,
} from "../stores/pull-request-tab-draft-store";
import {
  DraftCommentCard,
  PendingCommentCard,
  ReviewThreadCard,
} from "./pull-request-review-thread";

/** Commits the picker lists before "Show more". */
const COMMIT_PAGE = 10;

/** What a line's annotation carries. */
interface LineGroup {
  threads: PrReviewThread[];
  pending: PendingReviewComment[];
  draft: boolean;
}

interface Draft {
  id: string;
  path: string;
  position: PrReviewPosition;
  range: SelectedLineRange;
}

type Selection = { id: string; range: SelectedLineRange } | null;

/** Everything a group shows, so its item re-renders when any of it moves. */
function groupSignature(side: string, line: number, group: LineGroup): string {
  const threads = group.threads
    .map(
      (t) =>
        `${t.id}:${t.isResolved ? "r" : ""}${t.isOutdated ? "o" : ""}:${t.commentCount}:${t.comments
          .map(
            (c) =>
              `${c.id}:${c.editedAt ?? ""}:${c.body.length}:${fnv1a32(c.body)}:${c.reactions
                .map((r) => `${r.content}${r.count}${r.viewerHasReacted ? "v" : ""}`)
                .join(",")}`,
          )
          .join(";")}`,
    )
    .join(",");
  const pending = group.pending.map((c) => `${c.id}:${fnv1a32(c.body)}`).join(",");
  return `${side}:${line}:${group.draft ? "d" : ""}:${pending}:${threads}`;
}

/** The newest first, by instant: two commits written in different zones sort
 *  by when they landed, not how their dates were written. */
function newestFirst(commits: readonly PrCommit[]): PrCommit[] {
  return [...commits].sort((a, b) => Date.parse(b.committedDate) - Date.parse(a.committedDate));
}

export function PullRequestCodeTab({
  tabId,
  scrollerRef,
  repoPath,
  detail,
  activity,
  commit,
  onCommitChange,
  onAskAboutLines,
}: {
  tabId: string;
  /** The viewer's scroller, so the tab's header folds as the diff scrolls. */
  scrollerRef?: (node: HTMLDivElement | null) => void;
  repoPath: string;
  detail: PrDetail;
  activity: PrActivity | null;
  /** The commit on show; `null` for all of them. */
  commit: string | null;
  onCommitChange: (oid: string | null) => void;
  /** "Ask about these lines": a question about picked lines, in a session. */
  onAskAboutLines?: (lines: PickedLines, question: string) => void;
}) {
  const number = detail.number;
  const ignoreWhitespace = useDiffIgnoreWhitespace();
  const scopeKey = `pull-request\0${repoPath}\0${number}\0${commit ?? "all"}`;

  // ── files, a page at a time ──────────────────────────────────────────
  const pagesQuery = usePrDiffPages(repoPath, number, commit);
  const { fetchNextPage, hasNextPage, isFetchingNextPage, refetch } = pagesQuery;
  const pages = pagesQuery.data?.pages;
  const diff = useMemo(
    () => prDiffFiles(pages ?? [], `pull-request:${repoPath}:${number}`, ignoreWhitespace),
    [pages, repoPath, number, ignoreWhitespace],
  );
  // Reading order, not the host's: source, then tests, then generated.
  const files = useMemo(
    () =>
      orderDiffFiles(
        diff.files,
        (file) => file.stat.path,
        (file) => (file.state === "ready" ? fileDiffLines(file.source) : []),
      ),
    [diff.files],
  );
  const pageError = pagesQuery.error;

  // ── viewed, kept by GitHub ───────────────────────────────────────────
  const viewed = usePullRequestFilesViewed(
    repoPath,
    number,
    detail.capabilities.viewedFiles !== null,
  );

  // ── commits ──────────────────────────────────────────────────────────
  const commitsQuery = usePrCommitPages(repoPath, number);
  const commits = useMemo(
    () => newestFirst(commitsQuery.data?.pages.flatMap((p) => p.commits) ?? []),
    [commitsQuery.data],
  );
  const selectedCommit = commit ? commits.find((c) => c.oid === commit) : undefined;
  // A rebase or force-push can take the picked commit out of the change; the
  // scope goes back to the whole of it rather than sit under a name nothing
  // matches. Only once every page of commits has been read.
  const commitsSettled = commitsQuery.isSuccess && !commitsQuery.hasNextPage;
  useEffect(() => {
    if (commit && commitsSettled && !selectedCommit) onCommitChange(null);
  }, [commit, commitsSettled, selectedCommit, onCommitChange]);
  // The picked commit may be on a page not read yet (a link from the
  // Timeline to an old one): read on until it turns up. A failed page is not
  // asked for again on its own, or it would be retried as fast as it fails;
  // the picker's "Show more" asks again.
  useAutoNextPage(commitsQuery, !!commit && !selectedCommit);

  // ── review threads, pending comments and the draft ──────────────────
  const review = {
    inlineComment: detail.capabilities.review.inlineComment && detail.viewerPermissions.comment,
    reply: detail.capabilities.review.reply && detail.viewerPermissions.comment,
    resolve: detail.capabilities.review.resolve && detail.viewerPermissions.resolve,
  };
  const canComment = review.inlineComment && commit === null;
  // Asking needs no permission on the host: lines can be picked for it
  // wherever a comment could sit, on all commits.
  const canAsk = onAskAboutLines !== undefined && commit === null;
  const canPick = canComment || canAsk;
  const threads = useMemo(() => activity?.reviewThreads ?? [], [activity]);
  const pendingComments = usePendingReviewComments(repoPath, number);
  const reviewActions = usePullRequestReviewStore.use.actions();
  const reviewKey = reviewKeyOf(repoPath, number);
  // The line comment being written, kept per tab (`pull-request-tab-draft-
  // store.ts`) so leaving the tab and coming back finds it as it was.
  const [saved] = useState(() => {
    const line = readPullRequestTabDraft(tabId).lineComment;
    return line && line.scopeKey === scopeKey ? line : null;
  });
  const [draft, setDraftState] = useState<Draft | null>(() =>
    saved ? { id: saved.id, path: saved.path, position: saved.position, range: saved.range } : null,
  );
  const draftTextRef = useRef(saved?.text ?? "");
  const scopeKeyRef = useRef(scopeKey);
  scopeKeyRef.current = scopeKey;
  const setDraft = useCallback(
    (next: Draft | null) => {
      setDraftState(next);
      draftTextRef.current = "";
      patchPullRequestTabDraft(tabId, {
        lineComment: next ? { ...next, scopeKey: scopeKeyRef.current, text: "" } : null,
      });
    },
    [tabId],
  );
  const setDraftText = useCallback(
    (text: string) => {
      draftTextRef.current = text;
      const line = readPullRequestTabDraft(tabId).lineComment;
      if (line) patchPullRequestTabDraft(tabId, { lineComment: { ...line, text } });
    },
    [tabId],
  );
  const [selectedLines, setSelectedLines] = useState<Selection>(null);
  // A draft belongs to one diff: another commit or another pull request
  // drops it, rather than attach it to whatever is on screen when sent.
  const [draftScope, setDraftScope] = useState(scopeKey);
  if (draftScope !== scopeKey) {
    setDraftScope(scopeKey);
    setDraftState(null);
    setSelectedLines(null);
  }
  useEffect(() => {
    const line = readPullRequestTabDraft(tabId).lineComment;
    if (line && line.scopeKey !== scopeKey) patchPullRequestTabDraft(tabId, { lineComment: null });
  }, [tabId, scopeKey]);

  const placement = useMemo(() => {
    const byPath = new Map<string, PrReviewFile>(files.map((f) => [f.stat.path, f]));
    const groups = new Map<string, Map<string, LineGroup & { side: PrDiffSide; line: number }>>();
    const groupAt = (path: string, side: PrDiffSide, line: number) => {
      let file = groups.get(path);
      if (!file) groups.set(path, (file = new Map()));
      const key = `${side}:${line}`;
      let group = file.get(key);
      if (!group) file.set(key, (group = { side, line, threads: [], pending: [], draft: false }));
      return group;
    };
    const off: PrReviewThread[] = [];
    for (const thread of threads) {
      const file = byPath.get(thread.path);
      // Placing a thread takes more than its file being in the diff: its
      // line has to fall in a hunk that was rendered.
      if (
        commit === null &&
        file?.state === "ready" &&
        thread.line !== null &&
        isLineInFileDiff(file.source, thread.side, thread.line)
      ) {
        groupAt(thread.path, thread.side, thread.line).threads.push(thread);
      } else off.push(thread);
    }
    // A pending comment whose line has left the diff cannot be drawn on it,
    // and GitHub would refuse a review carrying it: it is listed above the
    // diff instead, where it can be discarded.
    const offPending: PendingReviewComment[] = [];
    if (commit === null) {
      for (const comment of pendingComments) {
        if (pendingCommentPlacement(comment, byPath, !hasNextPage) === "off") {
          offPending.push(comment);
          continue;
        }
        const { side, line } = positionAnchor(comment.position);
        groupAt(comment.path, side, line).pending.push(comment);
      }
    }
    if (draft) {
      const { side, line } = positionAnchor(draft.position);
      groupAt(draft.path, side, line).draft = true;
    }
    const byFile = new Map<string, { annotations: DiffAnnotation[]; version: string }>();
    for (const [path, lines] of groups) {
      const annotations: DiffAnnotation[] = [];
      const signature: string[] = [];
      for (const group of lines.values()) {
        const metadata: LineGroup = {
          threads: group.threads,
          pending: group.pending,
          draft: group.draft,
        };
        annotations.push({ side: viewerSideOf(group.side), lineNumber: group.line, metadata });
        signature.push(groupSignature(group.side, group.line, metadata));
      }
      byFile.set(path, { annotations, version: fnv1a32(signature.join("|")).toString(36) });
    }
    return { byFile, off, offPending };
  }, [files, threads, pendingComments, draft, commit, hasNextPage]);

  // ── writing a line comment ───────────────────────────────────────────
  const submitReview = usePrSubmitReviewMutation(repoPath, number);
  const filesRef = useRef(files);
  filesRef.current = files;
  const canPickRef = useRef(canPick);
  canPickRef.current = canPick;
  const beginComment = useCallback(
    (range: SelectedLineRange | null, context: { item: CodeViewItem<unknown> }) => {
      if (!range || !canPickRef.current || context.item.type !== "diff") return;
      const file = filesRef.current.find((f) => itemIdOf(f) === context.item.id);
      if (!file || file.state !== "ready") return;
      // A range comes down to its last line: a one-line comment GitHub
      // takes is better than a range that loses its start.
      const position = resolveReviewPosition(file.source, range.end, range.endSide ?? range.side);
      if (!position) {
        toast.info("Comments go on changed lines and the lines around them.");
        return;
      }
      setDraft({ id: context.item.id, path: file.stat.path, position, range });
    },
    [setDraft],
  );
  const closeDraft = useCallback(() => {
    setDraft(null);
    setSelectedLines(null);
  }, [setDraft]);
  const askAbout = useCallback(
    (target: Draft, question: string) => {
      const file = filesRef.current.find((f) => f.stat.path === target.path);
      if (!file || file.state !== "ready" || !onAskAboutLines) return;
      onAskAboutLines(pickedLines(target.path, fileDiffRows(file.source), target.range), question);
      closeDraft();
    },
    [onAskAboutLines, closeDraft],
  );

  const deps = {
    draft,
    review,
    canComment,
    askAbout: canAsk ? askAbout : null,
    canReact: detail.capabilities.reactions,
    submitReview,
    reviewKey,
    reviewActions,
    closeDraft,
    draftTextRef,
    setDraftText,
  };
  const renderDeps = useRef(deps);
  renderDeps.current = deps;
  const renderAnnotation = useCallback(
    (annotation: LineAnnotation<unknown> | DiffLineAnnotation<unknown>) => {
      const group = annotation.metadata as LineGroup | undefined;
      if (!group) return null;
      const {
        draft,
        review,
        canComment,
        askAbout,
        canReact,
        submitReview,
        reviewKey,
        reviewActions,
        closeDraft,
        draftTextRef,
        setDraftText,
      } = renderDeps.current;
      return (
        <div className="py-1">
          {group.threads.map((thread) => (
            <ReviewThreadCard
              key={thread.id}
              thread={thread}
              canReply={review.reply}
              canResolve={review.resolve && thread.canResolve !== false}
              canReact={canReact}
            />
          ))}
          {group.pending.map((comment) => (
            <PendingCommentCard
              key={comment.id}
              comment={comment}
              onRemove={() => reviewActions.remove(reviewKey, comment.id)}
            />
          ))}
          {group.draft && draft ? (
            <DraftCommentCard
              label={`${draft.path}:${positionAnchor(draft.position).line}`}
              initialText={draftTextRef.current}
              onTextChange={setDraftText}
              onCancel={closeDraft}
              canComment={canComment}
              onAsk={askAbout ? (question) => askAbout(draft, question) : undefined}
              onAddToReview={(body) => {
                reviewActions.add(reviewKey, {
                  id: nextPendingCommentId(),
                  path: draft.path,
                  position: draft.position,
                  body,
                });
                closeDraft();
              }}
              onPostNow={(body) =>
                submitReview
                  .mutateAsync({
                    verdict: "comment",
                    body: "",
                    comments: [{ path: draft.path, position: draft.position, body }],
                  })
                  .then(
                    () => {
                      closeDraft();
                      toast.success("Comment posted");
                    },
                    (raw: unknown) => {
                      toast.error("The comment could not be posted", {
                        description: readableFailure(
                          classifyPrError(raw),
                          "GitHub refused the comment.",
                        ),
                      });
                    },
                  )
              }
            />
          ) : null}
        </div>
      );
    },
    [],
  );
  const gutterOptions = useMemo(
    () => ({
      enableGutterUtility: canPick && draft === null,
      enableLineSelection: canPick && draft === null,
      onGutterUtilityClick: beginComment,
      onLineSelectionEnd: beginComment,
    }),
    [canPick, draft, beginComment],
  );
  const byFile = placement.byFile;
  const annotationsOf = useCallback(
    (file: ReviewFile) => byFile.get(file.stat.path) ?? null,
    [byFile],
  );
  const annotations = useMemo<DiffAnnotationSource>(
    () => ({
      of: annotationsOf,
      render: renderAnnotation,
      options: gutterOptions as DiffAnnotationSource["options"],
      selectedLines,
      onSelectedLinesChange: setSelectedLines,
    }),
    [annotationsOf, renderAnnotation, gutterOptions, selectedLines],
  );

  // ── expanding the unchanged lines around a hunk ──────────────────────
  const loadDiffFiles = useCallback<FileDiffContentsLoader>(
    async (fileDiff) => {
      const newPath = fileDiff.name ?? fileDiff.prevName ?? "";
      const oldPath = fileDiff.prevName ?? newPath;
      const contents = await prDiffFileContents(
        repoPath,
        number,
        fileDiff.type as PrFileChangeType,
        oldPath,
        newPath,
        commit,
      );
      const key = `pull-request:${repoPath}:${number}:${detail.headSha ?? detail.updatedAt}:${commit ?? "all"}`;
      const newFile = {
        name: newPath,
        contents: contents.newContents,
        cacheKey: `${key}:new:${newPath}`,
      };
      if (fileDiff.type === "rename-pure") return { oldFile: null, newFile };
      return {
        oldFile: {
          name: oldPath,
          contents: contents.oldContents,
          cacheKey: `${key}:old:${oldPath}`,
        },
        newFile,
      };
    },
    [repoPath, number, commit, detail.headSha, detail.updatedAt],
  );

  // ── paging: the next page as the end of what has loaded nears ────────
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  // A failed page is not asked for again on its own: the loaded files keep
  // the sentinel on screen, so re-arming would ask for it forever.
  const canLoadMore = hasNextPage && !isFetchingNextPage && !pageError;
  useEffect(() => {
    if (!sentinel || !canLoadMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void fetchNextPage();
      },
      { rootMargin: "600px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sentinel, canLoadMore, fetchNextPage]);
  const failed = !!pageError && !!pages?.length;
  // A new identity only when what the footer says changes: the viewer
  // re-renders its footer, not its files, for it.
  const renderFooter = useCallback(
    () => (
      <PagingFooter
        state={{ hasNextPage, isFetchingNextPage, failed }}
        sentinelRef={setSentinel}
        onLoad={() => void fetchNextPage()}
      />
    ),
    [hasNextPage, isFetchingNextPage, failed, fetchNextPage],
  );

  // ── the header ───────────────────────────────────────────────────────
  const picker = (
    <CommitPicker
      commits={commits}
      selected={selectedCommit ?? null}
      hasMore={commitsQuery.hasNextPage}
      loadingMore={commitsQuery.isFetchingNextPage}
      onLoadMore={() => void commitsQuery.fetchNextPage()}
      onPick={onCommitChange}
    />
  );
  const shownOf = hasNextPage ? `${files.length} of ${detail.changedFiles} files` : null;
  const info = (
    <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      {shownOf ? <span className="min-w-0 truncate tabular-nums">{shownOf}</span> : null}
      {viewed?.error ? (
        <Hint
          label={`Your viewed marks could not be read; the boxes show the last read. ${viewed.error}`}
        >
          <TriangleAlert
            aria-label="Viewed marks could not be read"
            className="size-3.5 shrink-0 text-warning"
          />
        </Hint>
      ) : null}
      {viewed?.truncated ? (
        <Hint label="This change has more files than GitHub reports viewed marks for in one read, so some boxes start empty.">
          <TriangleAlert
            aria-label="Viewed count covers part of the change"
            className="size-3.5 shrink-0 text-warning"
          />
        </Hint>
      ) : null}
      {diff.withheld ? (
        <Hint label="GitHub withheld part of this diff: a binary file, or a change too large to show inline.">
          <Info aria-label="Some of this diff is not shown" className="size-3.5 shrink-0" />
        </Hint>
      ) : null}
      {commit !== null && review.inlineComment ? (
        <Hint label="A comment is anchored to the whole change: pick All commits to write one.">
          <MessageSquareOff
            aria-label="Line comments are written on all commits"
            className="size-3.5 shrink-0"
          />
        </Hint>
      ) : null}
    </span>
  );

  let placeholder: ReactNode = null;
  if (!pages?.length) {
    placeholder = pageError ? (
      <DiffEmpty>
        <span className="flex flex-col items-center gap-2">
          <span>
            The diff could not be loaded.{" "}
            {readableFailure(classifyPrError(pageError), "GitHub did not send it.")}
          </span>
          <Button size="xs" variant="outline" onClick={() => void refetch()}>
            Retry
          </Button>
        </span>
      </DiffEmpty>
    ) : (
      <DiffPanelSkeleton />
    );
  } else if (files.length === 0 && diff.raw.length > 0 && !hasNextPage) {
    placeholder = (
      <div className="min-h-0 flex-1 space-y-2 overflow-auto px-4 py-3">
        <p className="text-xs text-muted-foreground">
          This patch could not be read as files; here it is as text.
        </p>
        {diff.raw.map((text) => (
          <pre key={text.slice(0, 64)} className="font-mono text-xs whitespace-pre-wrap">
            {text}
          </pre>
        ))}
      </div>
    );
  } else if (files.length === 0 && !hasNextPage) {
    placeholder = (
      <DiffEmpty>
        {commit === null
          ? "This pull request has no file changes."
          : "This commit has no file changes."}
      </DiffEmpty>
    );
  }

  const source: DiffViewSource = {
    key: scopeKey,
    files,
    loadDiffFiles: detail.capabilities.fileContents ? loadDiffFiles : undefined,
    picker,
    info,
    refresh: {
      busy: pagesQuery.isFetching && !isFetchingNextPage,
      run: () => void refetch(),
    },
    placeholder,
    viewed,
    annotations,
    banner:
      placement.off.length > 0 || placement.offPending.length > 0 ? (
        <OffDiffThreads
          threads={placement.off}
          pending={placement.offPending}
          onDiscardPending={(id) => reviewActions.remove(reviewKey, id)}
          complete={!hasNextPage}
          commit={commit !== null}
          canReply={review.reply}
          canResolve={review.resolve}
          canReact={detail.capabilities.reactions}
        />
      ) : null,
    renderFooter,
    scrollerRef,
  };

  return <DiffPanel tabId={tabId} repoPath={repoPath} source={source} />;
}

/** The end of the loaded files: the sentinel that asks for the next page as
 *  it nears the viewport, and what that read is doing. */
function PagingFooter({
  state,
  sentinelRef,
  onLoad,
}: {
  state: { hasNextPage: boolean; isFetchingNextPage: boolean; failed: boolean };
  sentinelRef: (node: HTMLDivElement | null) => void;
  onLoad: () => void;
}) {
  if (!state.hasNextPage) return null;
  return (
    <div
      ref={sentinelRef}
      className="flex items-center justify-center gap-2 py-3 font-sans text-xs text-muted-foreground"
    >
      {state.failed ? (
        <>
          <span>The rest of this diff could not be loaded.</span>
          <Button size="xs" variant="outline" onClick={onLoad}>
            Retry
          </Button>
        </>
      ) : state.isFetchingNextPage ? (
        "Loading more files…"
      ) : (
        <Button size="xs" variant="ghost" onClick={onLoad}>
          Load more files
        </Button>
      )}
    </div>
  );
}

/** "All commits", or one commit: newest first, ten at a time. */
const CommitPicker = memo(function CommitPicker({
  commits,
  selected,
  hasMore,
  loadingMore,
  onLoadMore,
  onPick,
}: {
  commits: readonly PrCommit[];
  selected: PrCommit | null;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onPick: (oid: string | null) => void;
}) {
  const [visible, setVisible] = useState(COMMIT_PAGE);
  const label = selected ? selected.messageHeadline : "All commits";
  const hidden = commits.length - visible;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="secondary" size="sm" aria-label={`Diff scope: ${label}`}>
            <span className="max-w-56 truncate">{label}</span>
            <ChevronDown size={12} className="shrink-0 text-muted-foreground" />
          </Button>
        }
      />
      <DropdownMenuContent align="start" sideOffset={4} className="max-h-96 w-80 overflow-auto">
        <DropdownMenuRadioGroup
          value={selected?.oid ?? "all"}
          onValueChange={(value) => onPick(value === "all" ? null : String(value))}
        >
          <DropdownMenuRadioItem value="all" closeOnClick>
            All commits
          </DropdownMenuRadioItem>
          {commits.slice(0, visible).map((c) => (
            <DropdownMenuRadioItem key={c.oid} value={c.oid} title={c.messageHeadline} closeOnClick>
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span className="min-w-0 truncate">{c.messageHeadline}</span>
                <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
                  {c.oid.slice(0, 7)}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {hidden > 0 || hasMore ? (
          <DropdownMenuItem
            closeOnClick={false}
            disabled={loadingMore}
            onClick={() => {
              setVisible((n) => n + COMMIT_PAGE);
              if (hidden <= COMMIT_PAGE && hasMore) onLoadMore();
            }}
          >
            <span className="text-muted-foreground">
              {loadingMore ? "Loading…" : hidden > 0 ? `Show more (${hidden} left)` : "Show more"}
            </span>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

/** Review threads the diff cannot place: outdated, on a line outside the
 *  hunks, in a file not loaded yet, or (on one commit) all of them. */
function OffDiffThreads({
  threads,
  pending,
  onDiscardPending,
  complete,
  commit,
  canReply,
  canResolve,
  canReact,
}: {
  threads: readonly PrReviewThread[];
  /** Line comments of the review in progress whose line left the diff. */
  pending: readonly PendingReviewComment[];
  onDiscardPending: (id: string) => void;
  complete: boolean;
  commit: boolean;
  canReply: boolean;
  canResolve: boolean;
  canReact: boolean;
}) {
  const [open, setOpen] = useState(false);
  const byPath = new Map<string, PrReviewThread[]>();
  for (const thread of threads) {
    const list = byPath.get(thread.path);
    if (list) list.push(thread);
    else byPath.set(thread.path, [thread]);
  }
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="shrink-0 border-b border-border-subtle">
      {pending.length > 0 ? (
        // Always open: GitHub refuses the review until these are discarded.
        <div className="max-h-72 overflow-auto pb-1">
          <p className="flex items-center gap-1.5 px-3 pt-1.5 text-xs text-warning">
            <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
            {pending.length === 1
              ? "1 pending line comment is no longer on the diff"
              : `${pending.length} pending line comments are no longer on the diff`}
          </p>
          {pending.map((comment) => (
            <div key={comment.id}>
              <p
                className="truncate px-3 pt-1 font-mono text-2xs text-muted-foreground"
                title={comment.path}
              >
                {comment.path}:{positionAnchor(comment.position).line}
              </p>
              <PendingCommentCard
                comment={comment}
                stale
                onRemove={() => onDiscardPending(comment.id)}
              />
            </div>
          ))}
        </div>
      ) : null}
      {threads.length === 0 ? null : (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
        >
          <Chevron aria-hidden className="size-3.5" />
          <span>
            {commit
              ? "Review threads (on all commits)"
              : complete
                ? "Review threads not on the diff"
                : "Review threads not on the diff loaded so far"}
          </span>
          <span className="tabular-nums">{threads.length}</span>
        </button>
      )}
      {open && threads.length > 0 ? (
        <div className={cn("max-h-72 space-y-3 overflow-auto pb-2")}>
          {[...byPath].map(([path, list]) => (
            <div key={path}>
              <p className="truncate px-3 font-mono text-xs text-muted-foreground" title={path}>
                {path}
              </p>
              {list.map((thread) => (
                <div key={thread.id}>
                  {thread.line !== null ? (
                    <p className="px-3 pt-1 text-2xs text-muted-foreground">Line {thread.line}</p>
                  ) : null}
                  <ReviewThreadCard
                    thread={thread}
                    canReply={canReply}
                    canResolve={canResolve && thread.canResolve !== false}
                    canReact={canReact}
                  />
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default PullRequestCodeTab;
