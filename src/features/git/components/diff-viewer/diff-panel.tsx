import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import type { FileDiffContentsLoader } from "@pierre/diffs";
import { ArrowRight, ChevronDown } from "lucide-react";
import { openReviewFile } from "../../lib/open-review-file";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { formatTime } from "@/lib/format-time";
import type { EditTurn } from "@/features/chat/lib/turn-edits";
import { getDiffFileContents, getDiffPreview, type DiffSource } from "../../lib/git-review-api";
import { fnv1a32 } from "../../lib/diff-rendering";
import { invalidateReviewFiles, useReviewFiles } from "../../lib/use-review-files";
import { combineReviews, useAttachedRootReviews } from "../../lib/use-root-review";
import { useSessionRoots } from "@/features/chat/hooks/use-session-roots";
import { useChatTabOfSession } from "@/features/chat/lib/review-comments";
import { useDiffReviewComments } from "../../lib/use-diff-review-comments";
import {
  useSessionEditTurns,
  useTurnEdits,
  useTurnReviewFiles,
} from "../../lib/use-turn-review-files";
import {
  LATEST_TURN,
  readStoredScope,
  SCOPE_LABEL,
  useDiffPanelStore,
  type DiffScope,
} from "../../stores/diff-panel-store";
import { useGitStore, type BranchInfo } from "../../stores/git-store";
import { BaseRefPicker } from "./base-ref-picker";
import { DiffPanelSkeleton } from "./diff-panel-skeleton";
import {
  DiffEmpty,
  DiffPanelView,
  useDiffIgnoreWhitespace,
  type DiffViewSource,
} from "./diff-panel-view";

/**
 * The review diff: every changed file of the working tree or the branch,
 * stacked in one virtualized viewer, beside a tree of the files.
 *
 * Data: `getDiffPreview` answers both sources at once with a capped patch and
 * a complete file list; `useReviewFiles` fills in the files the cap left out,
 * one at a time as their rows come into view. Beside a session there is also
 * the turn scope, which reads no git at all: one turn's own edits, diffed from
 * the texts its tool calls carried (`use-turn-review-files.ts`). Rendering:
 * `DiffPanelView`, through `StyledCodeView`, which tokenizes in a worker pool
 * and never on this thread.
 *
 * Given a `source` (a pull request's, `pull-request-code-tab.tsx`), the panel
 * reads no git and shows that instead.
 */

/** The scope menu's value for the turn the panel follows. */
const turnValue = (turn: string) => `turn:${turn}`;

export interface DiffPanelProps {
  /** The tab this panel is, so `requestDiffJump` can steer it. */
  tabId: string;
  repoPath: string;
  /** Offer this agent session's turns, and open on the branch's changes. */
  sessionId?: string | null;
  /** Source-control actions (commit, push, branch) go here when they land. */
  actions?: ReactNode;
  /** Heads the header. */
  leading?: ReactNode;
  /** Show this instead of the repository's changes: a pull request's files,
   *  with its Viewed marks and review threads. */
  source?: DiffViewSource;
}

export function DiffPanel({ source, ...props }: DiffPanelProps) {
  if (source) {
    return (
      <DiffPanelView
        tabId={props.tabId}
        repoPath={props.repoPath}
        source={source}
        leading={props.leading}
        actions={props.actions}
      />
    );
  }
  return <GitDiffPanel {...props} />;
}

function GitDiffPanel({
  tabId,
  repoPath,
  sessionId = null,
  actions,
  leading,
}: Omit<DiffPanelProps, "source">) {
  // The git scopes the menu lists as items ("Changes", "Uncommitted"); `turn`
  // has its own entries. Beside a session the panel opens on Changes, which
  // holds everything the session left; elsewhere on what is uncommitted.
  const scopes: DiffScope[] = ["branch-range", "working-tree"];
  const storedScope = readStoredScope(useDiffPanelStore((s) => s.scope[tabId]));
  const scope: DiffScope =
    storedScope && (storedScope !== "turn" || sessionId)
      ? storedScope
      : sessionId
        ? "branch-range"
        : "working-tree";
  const turnChoice = useDiffPanelStore((s) => s.turn[tabId] ?? LATEST_TURN);
  const baseRef = useDiffPanelStore((s) => s.baseRef[repoPath] ?? null);
  const ignoreWhitespace = useDiffIgnoreWhitespace();
  const actionsApi = useDiffPanelStore.use.actions();
  const preview = useQuery({
    queryKey: ["git-diff-preview", repoPath, baseRef, ignoreWhitespace],
    queryFn: () => getDiffPreview(repoPath, { baseRef: baseRef ?? undefined, ignoreWhitespace }),
    enabled: !!repoPath,
    placeholderData: keepPreviousData,
    staleTime: 2_000,
  });
  const { refetch } = preview;

  // Live: the git watcher fires on commit/stage/checkout, the explorer on any
  // write under the project. Coalesced, since an edit is a burst of events.
  const queryClient = useQueryClient();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refetch(), 250);
    };
    const offGit = listen<{ project: string }>("atlas:git-changed", (e) => {
      if (e.payload?.project !== repoPath) return;
      // HEAD may have moved under files whose patches are cached by what is
      // on disk; those keys cannot see it.
      invalidateReviewFiles(queryClient, repoPath);
      soon();
    });
    const offFs = listen<{ dirs?: string[]; fullRefresh?: boolean }>(
      "atlas:explorer:changed",
      (e) => {
        const dirs = e.payload?.dirs;
        // An opaque batch (a rename) names no directories: assume it is ours.
        const ours =
          e.payload?.fullRefresh ||
          !dirs?.length ||
          dirs.some((d) => d === repoPath || d.startsWith(`${repoPath}/`));
        if (ours) soon();
      },
    );
    return () => {
      if (timer) clearTimeout(timer);
      void offGit.then((off) => off());
      void offFs.then((off) => off());
    };
  }, [repoPath, refetch, queryClient]);

  const sourceKind = scope === "branch-range" ? "branch-range" : "working-tree";
  const source: DiffSource | null =
    preview.data?.sources.find((s) => s.kind === sourceKind) ?? null;

  // ── The turn scope: one turn's own edits, from the session's message log ──
  // Walked only while something shows them: the turn scope, or its picker.
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const turns = useSessionEditTurns(sessionId, repoPath, scope === "turn" || scopeMenuOpen);
  const latestTurn = turns[0] ?? null;
  const selectedTurn =
    scope !== "turn"
      ? null
      : turnChoice === LATEST_TURN
        ? latestTurn
        : (turns.find((t) => t.turnId === turnChoice) ?? null);
  const turnEdits = useTurnEdits(sessionId, selectedTurn?.turnId ?? null, repoPath);
  const turnReview = useTurnReviewFiles({ edits: turnEdits, ignoreWhitespace });

  const gitReview = useReviewFiles({
    repoPath,
    source: scope === "turn" ? null : source,
    ignoreWhitespace,
  });
  const baseReview = scope === "turn" ? turnReview : gitReview;

  // ── The session's other roots: its attached projects' working trees, and
  // a turn's files grouped by the root that holds them (`use-root-review.ts`).
  // Beside no session there are none, and the list is the main review's. ──
  const roots = useSessionRoots(sessionId, repoPath);
  const attachedRoots = useMemo(
    () => (sessionId ? roots.filter((r) => r.kind === "attached") : []),
    [roots, sessionId],
  );
  const attachedReview = useAttachedRootReviews({
    roots: attachedRoots,
    kind: scope === "turn" ? null : sourceKind,
    ignoreWhitespace,
  });
  // An attached project's repository moving (a commit, a checkout) re-reads
  // its preview, as the main project's does above.
  const refetchAttached = useRef(attachedReview.refetch);
  refetchAttached.current = attachedReview.refetch;
  const attachedKey = attachedRoots.map((r) => r.path).join("\0");
  useEffect(() => {
    if (!attachedKey) return;
    const paths = new Set(attachedKey.split("\0"));
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = listen<{ project: string }>("atlas:git-changed", (e) => {
      const project = e.payload?.project;
      if (!project || !paths.has(project)) return;
      invalidateReviewFiles(queryClient, project);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => refetchAttached.current(), 250);
    });
    return () => {
      if (timer) clearTimeout(timer);
      void off.then((u) => u());
    };
  }, [attachedKey, queryClient]);
  const combined = useMemo(
    () => combineReviews(baseReview.files, scope === "turn" ? [] : attachedReview.reviews, roots),
    [baseReview.files, attachedReview.reviews, roots, scope],
  );
  const { files, stats: treeFiles } = combined;

  // Loading and retrying go to the review the file came from, by the path it
  // knows the file by. Stable: every pending row's header holds them.
  const routeRef = useRef({ combined, baseReview, attached: attachedReview.reviews });
  routeRef.current = { combined, baseReview, attached: attachedReview.reviews };
  const requestFile = useCallback((key: string) => {
    const { combined, baseReview, attached } = routeRef.current;
    const info = combined.keys.get(key);
    if (info && info.slot >= 0) attached[info.slot]?.review.requestFile(info.orig);
    else baseReview.requestFile(info?.orig ?? key);
  }, []);
  const retry = useCallback((key: string) => {
    const { combined, baseReview, attached } = routeRef.current;
    const info = combined.keys.get(key);
    if (info && info.slot >= 0) attached[info.slot]?.review.retry(info.orig);
    else baseReview.retry(info?.orig ?? key);
  }, []);

  const collapseScopeKey =
    scope === "turn"
      ? `${repoPath}\0turn\0${selectedTurn?.turnId ?? ""}\0${sessionId ?? ""}`
      : `${repoPath}\0${scope}\0${baseRef ?? ""}\0${sessionId ?? ""}`;
  const scopeLabel =
    scope !== "turn"
      ? SCOPE_LABEL[scope]
      : selectedTurn && selectedTurn !== latestTurn
        ? `Turn ${selectedTurn.number}`
        : SCOPE_LABEL.turn;
  // Expanding the unchanged lines around a hunk needs both whole sides.
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const loadDiffFiles = useCallback<FileDiffContentsLoader>(
    async (fileDiff) => {
      const path = fileDiff.name;
      const oldPath = fileDiff.prevName ?? path;
      // An attached project's file is read from its own repository, by its
      // path there; the viewer knows it by its key.
      const { combined, attached } = routeRef.current;
      const info = combined.keys.get(path);
      const slot = info && info.slot >= 0 ? attached[info.slot] : null;
      const current = slot ? slot.source : sourceRef.current;
      if (!current) throw new Error("No diff source to load from.");
      const contents = await getDiffFileContents(slot ? slot.root.path : repoPath, {
        sourceKind: current.kind,
        baseRef: current.mergeBase ?? current.baseRef,
        filePath: info?.orig ?? path,
        oldPath: fileDiff.prevName ? (info?.origOld ?? fileDiff.prevName) : null,
      });
      // Keyed by content, so an unchanged side stays cached across refreshes.
      const keyOf = (name: string, text: string) =>
        `review-full:${name}:${text.length}:${fnv1a32(text).toString(36)}`;
      const newFile = {
        name: path,
        contents: contents.newText,
        cacheKey: keyOf(path, contents.newText),
      };
      if (fileDiff.type === "rename-pure") return { oldFile: null, newFile };
      return {
        oldFile: {
          name: oldPath,
          contents: contents.oldText,
          cacheKey: keyOf(oldPath, contents.oldText),
        },
        newFile,
      };
    },
    [repoPath],
  );

  const branches = useGitStore((s) => (s.repoPath === repoPath ? s.branchesFull : null));
  const headRef = branches?.find((b) => b.isCurrent)?.name ?? "HEAD";

  // What is shown: scope or turn on the left, and the refs a branch diff
  // compares. How it is shown is the view's.
  const picker = (
    <DropdownMenu onOpenChange={(open) => setScopeMenuOpen(open)}>
      <DropdownMenuTrigger
        render={
          <Button variant="secondary" size="sm" aria-label={`Diff scope: ${scopeLabel}`}>
            <span className="max-w-40 truncate">{scopeLabel}</span>
            <ChevronDown size={12} className="shrink-0 text-muted-foreground" />
          </Button>
        }
      />
      <DropdownMenuContent align="start" sideOffset={4}>
        <DropdownMenuRadioGroup
          value={
            scope !== "turn" ? scope : selectedTurn === latestTurn ? turnValue(LATEST_TURN) : ""
          }
          onValueChange={(value) => {
            const v = String(value);
            if (v.startsWith("turn:")) actionsApi.setTurn(tabId, v.slice(5));
            else actionsApi.setScope(tabId, v as DiffScope);
          }}
        >
          {scopes.map((s) => (
            <DropdownMenuRadioItem key={s} value={s} closeOnClick>
              {SCOPE_LABEL[s]}
            </DropdownMenuRadioItem>
          ))}
          {sessionId && (
            <DropdownMenuRadioItem
              value={turnValue(LATEST_TURN)}
              disabled={!latestTurn}
              closeOnClick
            >
              {SCOPE_LABEL.turn}
            </DropdownMenuRadioItem>
          )}
        </DropdownMenuRadioGroup>
        {sessionId && (
          <TurnSubmenu
            turns={turns}
            selected={scope === "turn" ? selectedTurn : null}
            onPick={(turnId) => actionsApi.setTurn(tabId, turnId)}
          />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  const info =
    scope === "branch-range" ? (
      <div
        className="flex min-w-0 items-center gap-2 overflow-hidden text-xs text-muted-foreground"
        aria-label={`Comparing ${headRef} against ${source?.baseRef ?? "the base branch"}`}
      >
        <span className="max-w-48 min-w-0 truncate">{headRef}</span>
        <ArrowRight size={12} className="shrink-0" aria-hidden />
        <BaseRefPicker
          current={source?.baseRef ?? null}
          chosen={baseRef}
          branches={branches ?? NO_BRANCHES}
          head={headRef}
          onPick={(ref) => actionsApi.setBaseRef(repoPath, ref)}
        />
      </div>
    ) : null;

  // The turn scope reads the session's record, not git: none of the
  // repository's states below apply to it.
  const git = scope !== "turn";
  let placeholder: ReactNode = null;
  if (!git && !selectedTurn) {
    placeholder = (
      <DiffEmpty>
        {turns.length > 0
          ? "That turn isn't in this session any more."
          : "No turn in this session has changed a file yet."}
      </DiffEmpty>
    );
  } else if (!git && files.length === 0) {
    placeholder = <DiffEmpty>This turn's edits have nothing to show.</DiffEmpty>;
  } else if (git && !repoPath) {
    placeholder = <DiffEmpty>Open a project to review its changes.</DiffEmpty>;
  } else if (git && preview.isError) {
    placeholder = <DiffEmpty>Couldn't read the diff: {String(preview.error)}</DiffEmpty>;
  } else if (git && !preview.data) {
    placeholder = <DiffPanelSkeleton />;
  } else if (git && preview.data?.sources.length === 0 && files.length === 0) {
    placeholder = <DiffEmpty>This project isn't a git repository.</DiffEmpty>;
  } else if (files.length === 0) {
    placeholder = (
      <DiffEmpty>
        {scope === "branch-range"
          ? `No changes against ${source?.baseRef ?? "the base branch"}.`
          : "No uncommitted changes."}
      </DiffEmpty>
    );
  }

  const keysRef = useRef(combined);
  keysRef.current = combined;
  const copyPathOf = useCallback((path: string) => keysRef.current.keys.get(path)?.rel, []);
  const resolvePath = useCallback((path: string) => keysRef.current.keyOf(path), []);
  const openFile = useCallback(
    (file: { stat: { path: string; status: string } }) => {
      // A deleted file has nothing on disk to open; its diff is all there is of it.
      if (file.stat.status === "deleted") return;
      // As a right-panel file tab, or the system editor for a file outside the project.
      void openReviewFile(
        keysRef.current.keys.get(file.stat.path)?.abs ?? `${repoPath}/${file.stat.path}`,
      );
    },
    [repoPath],
  );
  const absPathOf = useCallback(
    (path: string) => keysRef.current.keys.get(path)?.abs ?? `${repoPath}/${path}`,
    [repoPath],
  );
  const tree = useMemo(
    () => ({ files: treeFiles, groups: combined.grouped ? combined.groups : undefined }),
    [treeFiles, combined.grouped, combined.groups],
  );

  // ── Comments on lines, for the session beside the diff. Without one the
  // diff offers none: there is no prompt for a comment to go in. ──
  const chatTabId = useChatTabOfSession(sessionId);
  const section = useMemo(
    () => ({ id: collapseScopeKey, title: scopeLabel }),
    [collapseScopeKey, scopeLabel],
  );
  const annotations = useDiffReviewComments({
    chatTabId,
    section,
    files,
    displayPathOf: copyPathOf,
  });

  return (
    <DiffPanelView
      tabId={tabId}
      repoPath={repoPath}
      leading={leading}
      actions={actions}
      source={{
        key: collapseScopeKey,
        files,
        tree,
        requestFile,
        retry,
        // Unchanged lines around a hunk come from git, which knows nothing of
        // a past turn's texts.
        loadDiffFiles: git ? loadDiffFiles : undefined,
        picker,
        info,
        // A turn's edits are a record, not the disk: nothing to refresh.
        refresh: git
          ? {
              busy: preview.isFetching,
              run: () => {
                void refetch();
                attachedReview.refetch();
              },
            }
          : null,
        placeholder,
        copyPathOf,
        absPathOf,
        resolvePath,
        openFile,
        turn: !git,
        annotations,
      }}
    />
  );
}

/** "Turn ▸": every turn of the session that changed files, newest first, one
 *  line each: its number and when it ended. The prompt that started it is the
 *  row's tooltip. A turn's diff is rebuilt from the agent's own edit calls,
 *  so a change a command made (a formatter, a codegen step, `git mv`) is not
 *  in it; the menu says so once, above the turns. */
function TurnSubmenu({
  turns,
  selected,
  onPick,
}: {
  turns: readonly EditTurn[];
  /** The turn on show, if the scope is a turn. */
  selected: EditTurn | null;
  onPick: (turnId: string) => void;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={turns.length === 0}>Turn</DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-80 overflow-auto">
        <p className="max-w-56 px-2 py-1 text-2xs text-muted-foreground">
          The agent's own edits. Changes made by commands aren't included.
        </p>
        <DropdownMenuRadioGroup
          value={selected ? selected.turnId : ""}
          onValueChange={(value) => onPick(String(value))}
        >
          {turns.map((turn) => (
            <DropdownMenuRadioItem
              key={turn.turnId}
              value={turn.turnId}
              title={turn.prompt || undefined}
              closeOnClick
            >
              <span className="flex flex-1 items-center gap-2">
                <span>Turn {turn.number}</span>
                <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                  {formatTime(turn.timestamp)}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

const NO_BRANCHES: readonly BranchInfo[] = [];
