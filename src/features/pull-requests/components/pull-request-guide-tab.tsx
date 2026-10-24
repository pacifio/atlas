// The Guide tab: an agent-written tour of the pull request in numbered stops,
// read in order with J and K.
//
// No guide yet → what a guide is, and "Write guide" naming the agent that
// will. Writing → the run's progress, and any permission its background
// session asks for, answered here (no tab shows that session). Written → the
// tour; a banner says when it was written before the latest push, or when a
// rewrite is running or failed. The guide is kept per head commit
// (`guide-run-store.ts`), so it survives a restart and costs nothing to read.
//
// While the tour shows, the surfaces pane takes the whole centre (and gives
// it back after, if it was the tour that took it), and the run store knows
// this pull request's Guide is on screen (`shownKey`), so a run ending here
// raises no notification. Excerpts take line comments into the review in
// progress and questions for an agent (`ExcerptCommenting`).

import { useEffect, useRef, useState } from "react";
import type { FileDiffMetadata } from "@pierre/diffs";
import { Loader2, ShieldQuestion, Sparkles, TriangleAlert } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { agents } from "@/features/chat/lib/agents-api";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { agentMeta } from "@/features/agents/lib/agent-meta";
import { openReviewFile } from "@/features/git/lib/open-review-file";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { getRenderablePatch, resolveFileDiffPath } from "@/features/git/lib/diff-rendering";

import { stepTourPosition, stopFilePaths } from "../lib/pull-request-guide-tour";
import type { ToolCallRef } from "@/types/acp";

import type { PullRequestGuide } from "../lib/pull-request-guide-types";
import { usePrDiff } from "../lib/pull-requests-queries";
import type { PrDiffResult } from "../lib/pull-requests-types";
import type { PullRequestAgentActions } from "../lib/use-pull-request-agent-actions";
import { guideRunKey, useGuideRunStore, type GuideRun } from "../stores/guide-run-store";
import {
  nextPendingCommentId,
  reviewKeyOf,
  usePendingReviewComments,
  usePullRequestReviewStore,
} from "../stores/pull-request-review-store";
import { GuideRail, GuideStop, type ExcerptCommenting } from "./pull-request-guide-stop";

const NO_FILES: ReadonlyMap<string, FileDiffMetadata> = new Map();

/** The pull request's diff, a page at a time, until every path the stop
 *  shows is loaded. */
function useGuideDiffFiles(
  repoPath: string,
  number: number,
  headSha: string,
  wantedPaths: readonly string[],
) {
  const key = `${repoPath}:${number}:${headSha}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    cursor: string | null;
    done: boolean;
    files: ReadonlyMap<string, FileDiffMetadata>;
    folded: PrDiffResult | null;
  }>({ key, cursor: null, done: false, files: NO_FILES, folded: null });
  const current =
    loaded.key === key ? loaded : { key, cursor: null, done: false, files: NO_FILES, folded: null };
  const missing = wantedPaths.some((path) => !current.files.has(path));
  const loading = missing && !current.done;
  const query = usePrDiff(loading ? repoPath : null, number, current.cursor);

  // Each page is folded in once, during the render that first sees it.
  const data = query.data ?? null;
  if (data !== null && !current.done && current.folded !== data) {
    const parsed = getRenderablePatch(
      data.patch,
      `pull-request-guide:${key}:${current.cursor ?? "first"}`,
    );
    const files = new Map(current.files);
    if (parsed?.kind === "files") {
      for (const file of parsed.files) files.set(resolveFileDiffPath(file), file);
    }
    setLoaded({
      key,
      cursor: data.nextCursor,
      done: data.nextCursor === null,
      files,
      folded: data,
    });
  }

  return {
    files: current.files,
    loading: loading && !query.error,
    error: loading && query.error ? (query.error.message ?? "The diff could not be read.") : null,
  };
}

/** A tool call's input as the agent sent it, whole, or `null` for none. */
export function toolInputText(toolCall: ToolCallRef): string | null {
  const raw = toolCall.rawInput ?? (toolCall as Record<string, unknown>).input;
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return String(raw);
  }
}

/** "Write guide" on a pull request from a fork: the reader's yes first. */
function ForkConfirm({
  agentLabel,
  onConfirm,
  onCancel,
}: {
  agentLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="alertdialog"
      aria-label="Write a guide for a pull request from a fork"
      className="flex w-full max-w-md flex-col gap-2 rounded-lg border border-warning bg-warning-muted px-3 py-2.5 text-left"
    >
      <p className="flex items-center gap-2 text-sm font-medium text-foreground">
        <TriangleAlert aria-hidden className="size-4 shrink-0 text-warning" />
        This pull request comes from a fork
      </p>
      <p className="text-xs text-secondary-foreground">
        {agentLabel} will read its code in a checkout of the fork's head. That code is its author's,
        and can include agent instructions or configuration written to steer {agentLabel}. Check
        every permission it asks for.
      </p>
      <div className="flex flex-wrap gap-1.5">
        <Button size="xs" onClick={onConfirm}>
          Write guide
        </Button>
        <Button size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** A permission the run's session is waiting on, answered inline. */
function RunPermission({ run }: { run: Extract<GuideRun, { status: "running" }> }) {
  const sessionId = run.session?.session_id ?? null;
  const request = useChatStore((s) => (sessionId ? s.pendingPermissions[sessionId]?.[0] : null));
  if (!request || !run.session) return null;
  const key = run.session;
  const input = toolInputText(request.toolCall);
  const answer = (optionId: string | null) =>
    void agents
      .respondPermission(
        key.agent_id,
        key.session_id,
        request.requestId,
        optionId === null ? { kind: "cancelled" } : { kind: "selected", option_id: optionId },
      )
      .then(() => useChatStore.getState().actions.popPermission(key.session_id, request.requestId))
      .catch(() => undefined);
  return (
    <div className="flex w-full max-w-md flex-col gap-2 rounded-lg border border-warning bg-warning-muted px-3 py-2.5 text-left">
      <p className="flex items-center gap-2 text-sm font-medium text-foreground">
        <ShieldQuestion aria-hidden className="size-4 shrink-0 text-warning" />
        {run.agentLabel} asks to run something
      </p>
      <p className="font-mono text-xs break-words whitespace-pre-wrap text-secondary-foreground">
        {request.toolCall.title ?? "A tool call"}
      </p>
      {input !== null ? (
        // The whole input, untrimmed: the run reads code its author wrote,
        // so a title alone could hide what is really being asked.
        <pre
          aria-label="Tool input"
          className="max-h-60 overflow-auto rounded border border-border bg-background px-2 py-1.5 font-mono text-2xs leading-snug whitespace-pre-wrap text-secondary-foreground"
        >
          {input}
        </pre>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        {request.options.map((option) => (
          <Button
            key={option.optionId}
            size="xs"
            variant={option.kind.startsWith("allow") ? "default" : "outline"}
            onClick={() => answer(option.optionId)}
          >
            {option.name}
          </Button>
        ))}
        <Button size="xs" variant="ghost" onClick={() => answer(null)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

const PHASE_LABELS = {
  checkout: "Checking out the pull request's head…",
  reading: "Reading the change…",
  saving: "Saving the guide…",
} as const;

function GuideTour({
  repoPath,
  number,
  guide,
  banner,
  active,
  commenting,
  onAsk,
  onFinish,
  scrollerRef,
}: {
  scrollerRef?: (node: HTMLDivElement | null) => void;
  repoPath: string;
  number: number;
  guide: PullRequestGuide;
  banner: React.ReactNode;
  active: boolean;
  commenting: ExcerptCommenting | null;
  onAsk: ((index: number, question: string) => void) | null;
  onFinish: (() => void) | null;
}) {
  const [position, setPosition] = useState(0);
  const [seen, setSeen] = useState<ReadonlySet<number>>(() => new Set());
  const stopCount = guide.stops.length;
  const at = Math.max(Math.min(position, stopCount - 1), 0);
  const stop = guide.stops[at] ?? null;
  const diff = useGuideDiffFiles(repoPath, number, guide.headSha, stop ? stopFilePaths(stop) : []);
  const scrollRef = useRef<HTMLDivElement>(null);

  const goTo = (next: number) => {
    if (next > at) setSeen((current) => new Set(current).add(at));
    setPosition(next);
    scrollRef.current?.scrollTo({ top: 0 });
  };
  const step = (delta: 1 | -1) => goTo(stepTourPosition(at, delta, stopCount));
  const stepRef = useRef(step);
  stepRef.current = step;

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.key !== "j" && event.key !== "k") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true'], .cm-editor")) return;
      event.preventDefault();
      stepRef.current(event.key === "j" ? 1 : -1);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active]);

  const openFile = (path: string) => void openReviewFile(`${repoPath}/${path}`);

  return (
    <div
      ref={(node) => {
        scrollRef.current = node;
        scrollerRef?.(node);
      }}
      className="@container/guide h-full overflow-y-auto"
    >
      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-4 pb-20 @min-[48rem]/guide:grid-cols-[14rem_minmax(0,1fr)]">
        <aside className="sticky top-4 self-start @max-[48rem]/guide:hidden">
          <GuideRail stops={guide.stops} position={at} seen={seen} onSelect={goTo} />
        </aside>
        <main className="flex min-w-0 flex-col gap-4">
          {banner}
          {diff.error !== null ? (
            <p className="text-xs text-muted-foreground">
              The diff could not be loaded, so excerpts are missing: {diff.error}
            </p>
          ) : null}
          {stop === null ? (
            <p className="text-sm text-muted-foreground">This change has no files to tour.</p>
          ) : (
            <GuideStop
              key={at}
              stop={stop}
              index={at}
              stopCount={stopCount}
              nextTitle={guide.stops[at + 1]?.title ?? null}
              files={diff.files}
              diffLoading={diff.loading}
              commenting={commenting}
              onStep={step}
              onAsk={onAsk === null ? null : (question) => onAsk(at, question)}
              onFinish={
                onFinish === null
                  ? null
                  : () => {
                      setSeen((current) => new Set(current).add(at));
                      onFinish();
                    }
              }
              onDone={() => setSeen((current) => new Set(current).add(at))}
              onOpenFile={openFile}
            />
          )}
          <p className="text-2xs text-muted-foreground">
            Written by {agentMeta(guide.agent).label}
            {guide.generatedAt ? ` · ${new Date(guide.generatedAt).toLocaleString()}` : ""} · for{" "}
            <span className="font-mono">{guide.headSha.slice(0, 7)}</span>
          </p>
        </main>
      </div>
    </div>
  );
}

/**
 * The surfaces pane expanded while `on`, when this tab sits in it; given back
 * once `on` ends or the tab goes, unless the reader changed it meanwhile.
 */
function useExpandedWhile(tabId: string | undefined, on: boolean) {
  const inSurfaces = useLayoutStore((s) => {
    if (!tabId) return false;
    const tab = s.tabs.find((t) => t.id === tabId);
    const group = tab?.groupId ?? "main";
    return tab !== undefined && group !== s.groupOrder[0] && s.activeByGroup[group] === tabId;
  });
  const expand = on && inSurfaces;
  useEffect(() => {
    if (!expand) return;
    const layout = useLayoutStore.getState();
    if (layout.surfaces !== "shown") return;
    layout.actions.setSurfaces("expanded");
    return () => {
      const now = useLayoutStore.getState();
      if (now.surfaces === "expanded") now.actions.setSurfaces("shown");
    };
  }, [expand]);
}

/** Tells the run store this pull request's Guide is on screen while it is. */
function useGuideShown(runKey: string, shown: boolean) {
  useEffect(() => {
    if (!shown) return;
    useGuideRunStore.getState().setShown(runKey);
    return () => {
      if (useGuideRunStore.getState().shownKey === runKey) {
        useGuideRunStore.getState().setShown(null);
      }
    };
  }, [runKey, shown]);
}

export function PullRequestGuideTab({
  tabId,
  repoPath,
  number,
  agent,
  active,
  canComment,
  onFinishReview,
  scrollerRef,
}: {
  /** The surface tab it sits in: the pane it expands while the tour shows. */
  tabId?: string;
  repoPath: string;
  number: number;
  agent: PullRequestAgentActions;
  active: boolean;
  /** Line comments can go into the review in progress. */
  canComment: boolean;
  /** Opens the composer at the review; `null` when the reader cannot review. */
  onFinishReview: (() => void) | null;
  scrollerRef?: (node: HTMLDivElement | null) => void;
}) {
  const { guide, loading, run, running, stale, canWrite, write, forkConfirm } = agent.guide;
  const runKey = guideRunKey(repoPath, number);
  const onScreen = useLayoutStore((s) => {
    if (!tabId) return true;
    const tab = s.tabs.find((t) => t.id === tabId);
    return tab !== undefined && s.activeByGroup[tab.groupId ?? "main"] === tabId;
  });
  useGuideShown(runKey, active && onScreen);
  const tourShown = active && guide !== null;
  useExpandedWhile(tabId, tourShown);

  const reviewKey = reviewKeyOf(repoPath, number);
  const pending = usePendingReviewComments(repoPath, number);
  const reviewActions = usePullRequestReviewStore.use.actions();
  // Asking is open to every reader; adding to the review needs the right to.
  const commenting: ExcerptCommenting = {
    canComment,
    pending,
    onComment: ({ path, position, body }) =>
      reviewActions.add(reviewKey, { id: nextPendingCommentId(), path, position, body }),
    onRemove: (id) => reviewActions.remove(reviewKey, id),
    onAskAgent: agent.askAboutLines,
  };
  const failure = run?.status === "failed" ? run.detail : null;
  const forkPrompt = forkConfirm ? (
    <ForkConfirm
      agentLabel={agent.guide.agentLabel}
      onConfirm={forkConfirm.confirm}
      onCancel={forkConfirm.cancel}
    />
  ) : null;
  const writeButton = (label: string, size: "sm" | "xs") =>
    canWrite ? (
      <Button size={size} variant="outline" disabled={running} onClick={write}>
        {running ? (
          <Loader2 aria-hidden className="size-3.5 animate-spin" />
        ) : (
          <Sparkles aria-hidden className="size-3.5" />
        )}
        {running ? "Reading the change…" : label}
      </Button>
    ) : null;

  if (guide === null) {
    if (loading) {
      return (
        <div className="flex h-full items-center justify-center">
          <Loader2 aria-hidden className="size-4 animate-spin text-muted-foreground" />
        </div>
      );
    }
    return (
      <div
        ref={scrollerRef}
        className="flex h-full flex-col items-center justify-center gap-3 overflow-y-auto px-6 py-10 text-center"
      >
        <Sparkles aria-hidden className="size-6 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">
          {running ? "Writing a review guide" : "No review guide yet"}
        </p>
        <p className="max-w-md text-xs text-muted-foreground">
          {failure ??
            (run?.status === "running"
              ? `${run.agentLabel} is reading the change in a checkout of its own. ${PHASE_LABELS[run.phase]} A large change takes a few minutes; you can leave, and you will be told when it is ready.`
              : `A guide is a tour of the change: stops through the code in reading order, with the calls only a maintainer can make. ${agent.guide.agentLabel} writes it, reading a checkout of the pull request's head.`)}
        </p>
        {run?.status === "running" ? <RunPermission run={run} /> : null}
        {forkPrompt ??
          writeButton(
            failure === null ? `Write guide with ${agent.guide.agentLabel}` : "Try again",
            "sm",
          )}
      </div>
    );
  }

  const banner = forkPrompt ? (
    forkPrompt
  ) : stale || failure !== null || running ? (
    <div
      role="status"
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs",
        running ? "border-info bg-info-muted" : "border-warning bg-warning-muted",
      )}
    >
      {running ? (
        <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin text-info" />
      ) : (
        <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-warning" />
      )}
      <span className="min-w-0 flex-1 text-foreground">
        {running
          ? "Rewriting this guide. You will be told when the new one is ready."
          : (failure ?? "Written before the latest push.")}
      </span>
      {!running ? writeButton("Rewrite", "xs") : null}
      {run?.status === "running" ? <RunPermission run={run} /> : null}
    </div>
  ) : null;

  return (
    <GuideTour
      repoPath={repoPath}
      number={number}
      guide={guide}
      banner={banner}
      active={active}
      scrollerRef={scrollerRef}
      commenting={commenting}
      onAsk={(index, question) => {
        const stop = guide.stops[index];
        if (stop) agent.askAboutStop(stop, index, question);
      }}
      onFinish={onFinishReview}
    />
  );
}
