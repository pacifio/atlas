import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke } from "@tauri-apps/api/core";
import { Popover } from "@base-ui/react/popover";
import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  GitGraph,
  RotateCcw,
  Rows2,
  Sparkles,
  Tag,
  Undo2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { CopyGlyph } from "@/ui/animated-icon";
import { HintGroup, HintItem } from "@/ui/hint-group";
import { useArtifactsStore } from "@/features/artifacts/stores/artifacts-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useGitStore, type CommitDetail } from "../stores/git-store";
import { handleGitError, isGitError } from "../lib/git-errors";
import { highlightDiffLine } from "../lib/diff-highlight";
import {
  parseDiff,
  splitHunkLines,
  type DiffFile,
  type DiffLine,
  type SplitLine,
} from "../lib/diff";
import { CommitAvatar } from "./commit-avatar";
import type { DiffJump } from "../lib/diff-jump";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { useCollapsedFiles } from "../lib/use-collapsed-files";

type ViewMode = "split" | "unified";

const MODE_KEY = "atlas:commit-view-mode";
/** "1" when the commit header shows its body and sessions; collapsed otherwise. */
const HEADER_EXPANDED_KEY = "atlas:commit-header-expanded";
const LINE_H = 20;

/** `id` is stable across collapse and mode changes, so the virtualizer's
 *  measured heights stay with their row instead of with an index. */
type Row = { id: string } & (
  | { kind: "file-header"; file: DiffFile }
  | { kind: "hunk-header"; header: string }
  | { kind: "unified"; line: DiffLine; language: string }
  | { kind: "split"; pair: SplitLine; language: string }
  /** A file with no lines to show — binary, or a rename / mode change only. */
  | { kind: "note"; text: string }
  | { kind: "file-footer" }
);

/** The virtualized rows of a commit: per file a header, then (unless
 *  collapsed) its hunks laid out for `mode`, then a footer. */
function buildCommitRows(files: DiffFile[], collapsed: Set<string>, mode: ViewMode): Row[] {
  const rows: Row[] = [];
  for (const file of files) {
    const p = file.path;
    rows.push({ id: p, kind: "file-header", file });
    if (collapsed.has(p)) continue;
    if (file.binary)
      rows.push({ id: `${p}#note`, kind: "note", text: "Binary file — no text diff." });
    else if (file.hunks.length === 0)
      rows.push({
        id: `${p}#note`,
        kind: "note",
        text: file.oldPath ? "Renamed without changes." : "No text changes.",
      });
    file.hunks.forEach((hunk, h) => {
      rows.push({ id: `${p}#${h}`, kind: "hunk-header", header: hunk.header });
      if (mode === "unified") {
        hunk.lines.forEach((line, i) =>
          rows.push({ id: `${p}#${h}:u${i}`, kind: "unified", line, language: file.language }),
        );
      } else {
        splitHunkLines(hunk).forEach((pair, i) =>
          rows.push({ id: `${p}#${h}:s${i}`, kind: "split", pair, language: file.language }),
        );
      }
    });
    rows.push({ id: `${p}#end`, kind: "file-footer" });
  }
  return rows;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-10-08 14:23` (what `git_show` asks git for) → `8 Oct 2026`, the same
 *  on every system locale. */
function formatCommitDate(date: string): string {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  if (!m || !month) return date;
  return `${Number(m[3])} ${month} ${m[1]}`;
}

function lineBg(type: DiffLine["type"] | undefined): string {
  if (type === "add") return "var(--atlas-diff-added-background)";
  if (type === "remove") return "var(--atlas-diff-removed-background)";
  if (type === undefined) return "color-mix(in srgb, var(--foreground) 1.8%, transparent)";
  return "var(--atlas-diff-context-background)";
}

/**
 * One commit, read in full: who wrote it and why, then every file it changed
 * as a collapsible section, side by side or unified. Opened as a centre tab
 * from Source Control → History and the Git Graph.
 */
export function CommitView({ repoPath, sha }: { repoPath: string; sha: string }) {
  // `diffIgnoreWhitespace`: a commit is only read here, never staged from.
  const ignoreWhitespace = useSettingsStore((s) => s.settings.diffIgnoreWhitespace);
  const {
    data: detail,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["git-show", repoPath, sha, ignoreWhitespace],
    queryFn: () => invoke<CommitDetail>("git_show", { path: repoPath, sha, ignoreWhitespace }),
    // A commit never changes under its sha.
    staleTime: Infinity,
    enabled: !!repoPath && !!sha,
  });

  const files = useMemo(() => parseDiff(detail?.diff ?? ""), [detail?.diff]);
  if (isLoading || !detail) {
    return (
      <div className="px-3 py-8 text-center text-xs text-muted-foreground">
        {isLoading
          ? "Loading commit…"
          : `Couldn't load this commit${error ? `: ${isGitError(error) ? error.message : String(error)}` : "."}`}
      </div>
    );
  }

  return (
    <DiffFilesView
      files={files}
      header={<CommitHeader detail={detail} repoPath={repoPath} />}
      toolbarEnd={<CommitActions repoPath={repoPath} sha={detail.hash} />}
      emptyText="No file changes"
    />
  );
}

/**
 * A set of changed files, read in full: a toolbar (collapse all, unified or
 * split), an optional header, then every file as a collapsible section. The
 * body of the commit tab, and of a thread's changes tab — which is why it
 * takes parsed files rather than a sha.
 *
 * `jump` scrolls to a file's section (expanding it) each time its nonce
 * changes; a file not in `files` yet is scrolled to once it arrives.
 */
export function DiffFilesView({
  files,
  header,
  toolbarEnd,
  emptyText,
  jump,
}: {
  files: DiffFile[];
  header?: React.ReactNode;
  toolbarEnd?: React.ReactNode;
  emptyText: string;
  jump?: DiffJump | null;
}) {
  const [mode, setMode] = useState<ViewMode>(() =>
    localStorage.getItem(MODE_KEY) === "unified" ? "unified" : "split",
  );
  const chooseMode = (m: ViewMode) => {
    setMode(m);
    localStorage.setItem(MODE_KEY, m);
  };

  const paths = useMemo(() => files.map((f) => f.path), [files]);
  const [collapsed, setCollapsed] = useCollapsedFiles(paths);
  const rows = useMemo(() => buildCommitRows(files, collapsed, mode), [files, collapsed, mode]);
  const totalAdd = useMemo(() => files.reduce((s, f) => s + f.additions, 0), [files]);
  const totalDel = useMemo(() => files.reduce((s, f) => s + f.deletions, 0), [files]);
  const anyExpanded = files.some((f) => !collapsed.has(f.path));

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getItemKey: (i) => rows[i].id,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const k = rows[i].kind;
      if (k === "file-header") return 44;
      if (k === "file-footer") return 12;
      if (k === "hunk-header" || k === "note") return 24;
      return LINE_H;
    },
    overscan: 30,
  });

  const toggleFile = (path: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  // Expand the target, then scroll once its header row exists.
  useEffect(() => {
    if (!jump) return;
    setCollapsed((s) => {
      if (!s.has(jump.path)) return s;
      const next = new Set(s);
      next.delete(jump.path);
      return next;
    });
  }, [jump]);
  const jumpedRef = useRef(0);
  useEffect(() => {
    if (!jump || jumpedRef.current === jump.nonce) return;
    const i = rows.findIndex((r) => r.kind === "file-header" && r.id === jump.path);
    if (i < 0) return;
    jumpedRef.current = jump.nonce;
    virtualizer.scrollToIndex(i, { align: "start" });
  }, [jump, rows, virtualizer]);

  return (
    <div className="flex h-full min-w-0 flex-col bg-[var(--background)]">
      {/* Toolbar */}
      <HintGroup>
        <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-border px-2">
          <HintItem label={anyExpanded ? "Collapse all files" : "Expand all files"}>
            <button
              onClick={() =>
                setCollapsed(anyExpanded ? new Set(files.map((f) => f.path)) : new Set())
              }
              className="rounded p-1 text-muted-foreground hover:bg-element-hover hover:text-foreground"
            >
              {anyExpanded ? <ChevronsDownUp size={13} /> : <ChevronsUpDown size={13} />}
            </button>
          </HintItem>
          <HintItem label="Unified">
            <button
              onClick={() => chooseMode("unified")}
              className={cn(
                "rounded p-1 hover:bg-element-hover",
                mode === "unified"
                  ? "bg-element-selected text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Rows2 size={13} />
            </button>
          </HintItem>
          <HintItem label="Split">
            <button
              onClick={() => chooseMode("split")}
              className={cn(
                "rounded p-1 hover:bg-element-hover",
                mode === "split"
                  ? "bg-element-selected text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Columns2 size={13} />
            </button>
          </HintItem>
          <div className="ml-auto flex items-center gap-0.5">
            <span className="mr-1.5 font-mono text-2xs">
              <span className="text-success">+{totalAdd}</span>{" "}
              <span className="text-error">−{totalDel}</span>
            </span>
            {toolbarEnd}
          </div>
        </div>
      </HintGroup>

      {header}

      {/* Files */}
      {files.length === 0 ? (
        <div className="px-3 py-8 text-center text-xs text-muted-foreground">{emptyText}</div>
      ) : (
        <div
          ref={scrollRef}
          className="min-h-0 min-w-0 flex-1 overflow-auto hide-scrollbar px-2 py-2"
        >
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((vr) => {
              const row = rows[vr.index];
              const base = {
                position: "absolute" as const,
                top: 0,
                transform: `translateY(${vr.start}px)`,
                width: "100%",
              };
              const measured = { "data-index": vr.index, ref: virtualizer.measureElement };

              if (row.kind === "file-header") {
                const file = row.file;
                const isCollapsed = collapsed.has(file.path);
                const slash = file.path.lastIndexOf("/");
                const name = file.path.slice(slash + 1);
                const dir = slash >= 0 ? file.path.slice(0, slash + 1) : "";
                return (
                  <div key={vr.key} {...measured} style={{ ...base, paddingTop: 4 }}>
                    <HintGroup>
                      <div
                        onClick={() => toggleFile(file.path)}
                        className={cn(
                          "group flex h-9 cursor-pointer items-center gap-2 border border-border bg-card px-2 hover:bg-element-hover",
                          isCollapsed ? "rounded-md" : "rounded-t-md",
                        )}
                      >
                        <ChevronRight
                          size={12}
                          className={cn(
                            "shrink-0 text-muted-foreground transition-transform",
                            !isCollapsed && "rotate-90",
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate font-mono text-xs select-text">
                          <span className="text-foreground">{name}</span>
                          {dir && <span className="ml-2 text-muted-foreground">{dir}</span>}
                          {file.oldPath && (
                            <span className="ml-2 text-muted-foreground">
                              renamed from {file.oldPath}
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 font-mono text-2xs">
                          <span className="text-success">+{file.additions}</span>{" "}
                          <span className="text-error">−{file.deletions}</span>
                        </span>
                      </div>
                    </HintGroup>
                  </div>
                );
              }

              if (row.kind === "hunk-header") {
                return (
                  <div
                    key={vr.key}
                    {...measured}
                    style={{ ...base, backgroundColor: "var(--atlas-diff-context-background)" }}
                    className="flex h-6 items-center border-x border-border px-2 font-mono text-2xs"
                  >
                    <span className="truncate text-[var(--atlas-status-info-foreground)]/70 select-text">
                      {row.header}
                    </span>
                  </div>
                );
              }

              if (row.kind === "note") {
                return (
                  <div
                    key={vr.key}
                    {...measured}
                    style={{ ...base, backgroundColor: "var(--atlas-diff-context-background)" }}
                    className="flex h-6 items-center border-x border-border px-3 text-2xs text-muted-foreground"
                  >
                    {row.text}
                  </div>
                );
              }

              if (row.kind === "file-footer") {
                return (
                  <div key={vr.key} {...measured} style={{ ...base, height: 12 }}>
                    <div
                      className="h-2 rounded-b-md border-x border-b border-border"
                      style={{ backgroundColor: "var(--atlas-diff-context-background)" }}
                    />
                  </div>
                );
              }

              if (row.kind === "unified") {
                const line = row.line;
                return (
                  <div
                    key={vr.key}
                    {...measured}
                    style={{ ...base, backgroundColor: lineBg(line.type) }}
                    className="flex overflow-hidden border-x border-border font-mono text-xs leading-[20px] select-text"
                  >
                    <ChangeBar type={line.type} />
                    <LineNo n={line.oldLine} />
                    <LineNo n={line.newLine} />
                    <Code content={line.content} language={row.language} />
                  </div>
                );
              }

              const { left, right } = row.pair;
              return (
                <div
                  key={vr.key}
                  {...measured}
                  style={base}
                  className="grid grid-cols-2 border-x border-border font-mono text-xs leading-[20px] select-text"
                >
                  <SplitSide line={left} n={left?.oldLine} language={row.language} />
                  <SplitSide
                    line={right}
                    n={right?.newLine}
                    language={row.language}
                    className="border-l border-border"
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function ChangeBar({ type }: { type: DiffLine["type"] | undefined }) {
  return (
    <span
      className={cn(
        "w-[3px] shrink-0",
        type === "add" && "bg-success",
        type === "remove" && "bg-error",
      )}
    />
  );
}

function LineNo({ n }: { n: number | undefined }) {
  return (
    <span className="w-[44px] shrink-0 select-none pr-2 text-right text-2xs text-muted-foreground">
      {n ?? ""}
    </span>
  );
}

function SplitSide({
  line,
  n,
  language,
  className,
}: {
  line: DiffLine | undefined;
  n: number | undefined;
  language: string;
  className?: string;
}) {
  return (
    <div
      className={cn("flex min-w-0 overflow-hidden", className)}
      style={{ backgroundColor: lineBg(line?.type) }}
    >
      <ChangeBar type={line?.type} />
      <LineNo n={line ? n : undefined} />
      {line && <Code content={line.content} language={language} />}
    </div>
  );
}

/** A diff line's code, syntax-highlighted; long lines clip (this is a
 *  commit summary; the review panel's viewer shows them whole). */
function Code({ content, language }: { content: string; language: string }) {
  const tokens = highlightDiffLine(language, content);
  return (
    <span className="diff-syntax min-w-0 flex-1 overflow-hidden whitespace-pre pr-3 pl-1 text-secondary-foreground">
      {tokens
        ? tokens.map((t, i) => (
            <span key={i} className={t.cls ?? undefined}>
              {t.text}
            </span>
          ))
        : content}
    </span>
  );
}

/**
 * Author, date and subject — always. The body and the sessions that produced
 * the commit can run tall enough to push the diff off screen, so they sit
 * behind the expand toggle, collapsed until asked for (and remembered).
 */
function CommitHeader({ detail, repoPath }: { detail: CommitDetail; repoPath: string }) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(() => localStorage.getItem(HEADER_EXPANDED_KEY) === "1");
  const toggleExpanded = () => {
    setExpanded((e) => {
      localStorage.setItem(HEADER_EXPANDED_KEY, e ? "0" : "1");
      return !e;
    });
  };
  return (
    <div className="shrink-0 border-b border-border px-4 py-3">
      <div className="flex items-start gap-3">
        <CommitAvatar email={detail.email} repoPath={repoPath} size={36} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">{detail.author}</div>
          <div className="text-2xs text-muted-foreground">
            {formatCommitDate(detail.date)}
            {detail.email && ` · ${detail.email}`}
          </div>
          <div className="mt-1.5 text-sm text-foreground select-text">{detail.subject}</div>
          {expanded && detail.body && (
            <pre className="mt-1 max-h-32 overflow-y-auto hide-scrollbar whitespace-pre-wrap break-words font-sans text-xs text-muted-foreground select-text">
              {detail.body}
            </pre>
          )}
          {expanded && <CommitSessions repoPath={repoPath} sha={detail.hash} />}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <HintGroup>
            <HintItem label={expanded ? "Collapse details" : "Expand details"}>
              <button
                onClick={toggleExpanded}
                aria-expanded={expanded}
                aria-label={expanded ? "Collapse details" : "Expand details"}
                className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border text-secondary-foreground hover:bg-element-hover hover:text-foreground"
              >
                {expanded ? <ChevronsDownUp size={12} /> : <ChevronsUpDown size={12} />}
              </button>
            </HintItem>
          </HintGroup>
          <button
            onClick={() => {
              void navigator.clipboard.writeText(detail.hash).catch(() => {});
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
            title={detail.hash}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 h-6 text-2xs text-secondary-foreground hover:bg-element-hover hover:text-foreground"
          >
            <CopyGlyph copied={copied} size="sm" className={copied ? "text-success" : undefined} />
            Commit SHA
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Cherry-pick / revert / reset / tag. The store's actions run against the
 * active repository, so they only show while that is the repository this tab
 * was opened from.
 */
function CommitActions({ repoPath, sha }: { repoPath: string; sha: string }) {
  const activeRepo = useGitStore.use.repoPath();
  const actions = useGitStore.use.actions();
  const [tagging, setTagging] = useState(false);
  const [tagName, setTagName] = useState("");

  if (activeRepo !== repoPath) return null;

  const run = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      handleGitError(e);
    }
  };

  return (
    <>
      <HintItem label="Cherry-pick onto current branch">
        <button
          onClick={() => run(() => actions.cherryPick(sha))}
          className="rounded p-1 text-muted-foreground hover:bg-element-hover hover:text-foreground"
        >
          <GitGraph size={12} />
        </button>
      </HintItem>
      <HintItem label="Revert this commit">
        <button
          onClick={() => run(() => actions.revert(sha))}
          className="rounded p-1 text-muted-foreground hover:bg-element-hover hover:text-foreground"
        >
          <Undo2 size={12} />
        </button>
      </HintItem>
      <ResetMenu onReset={(mode) => run(() => actions.reset(sha, mode))} />
      <Popover.Root
        open={tagging}
        onOpenChange={(open) => {
          setTagging(open);
          if (!open) setTagName("");
        }}
      >
        <HintItem label="Tag this commit">
          <Popover.Trigger
            render={
              <button
                className={cn(
                  "rounded p-1 hover:bg-element-hover",
                  tagging ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Tag size={12} />
              </button>
            }
          />
        </HintItem>
        <Popover.Portal>
          <Popover.Positioner className="z-popover" side="bottom" align="end" sideOffset={4}>
            <Popover.Popup className="w-[220px] rounded-lg border border-border bg-[var(--card)] p-2 shadow-md">
              <input
                value={tagName}
                onChange={(e) => setTagName(e.target.value)}
                autoFocus
                placeholder="tag name → Enter"
                className="h-7 w-full rounded border border-border bg-panel-input px-2 font-mono text-xs text-foreground outline-none focus:border-border-strong"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && tagName.trim()) {
                    void run(() => actions.createTag(tagName.trim(), sha));
                    setTagging(false);
                    setTagName("");
                  }
                }}
              />
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </>
  );
}

function ResetMenu({ onReset }: { onReset: (mode: "soft" | "mixed" | "hard") => void }) {
  const [open, setOpen] = useState(false);
  const item = (mode: "soft" | "mixed" | "hard", label: string, desc: string) => (
    <button
      onClick={() => {
        onReset(mode);
        setOpen(false);
      }}
      className="w-full text-left px-3 py-1.5 hover:bg-element-hover"
    >
      <div className="text-xs text-foreground">{label}</div>
      <div className="text-3xs text-muted-foreground">{desc}</div>
    </button>
  );
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <HintItem label="Reset current branch to this commit">
        <Popover.Trigger
          render={
            <button
              className={cn(
                "p-1 rounded hover:bg-element-hover",
                open ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <RotateCcw size={12} />
            </button>
          }
        />
      </HintItem>
      <Popover.Portal>
        <Popover.Positioner className="z-popover" side="bottom" align="end" sideOffset={4}>
          <Popover.Popup className="w-[200px] rounded-lg border border-border bg-[var(--card)] shadow-md py-1">
            <div className="px-3 py-1 text-3xs uppercase tracking-wider text-muted-foreground">
              Reset to here
            </div>
            {item("soft", "Soft", "keep changes staged")}
            {item("mixed", "Mixed", "keep changes unstaged")}
            {item("hard", "Hard", "discard all changes")}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** One Session that produced this commit. */
export interface CommitSession {
  sessionId: string;
  title: string | null;
  messageCount: number;
  toolCallCount: number;
  files: string[];
}

/**
 * The Sessions behind this commit — the answer to "why is this written
 * this way", offered where the question actually gets asked.
 *
 * Renders nothing at all when the commit has no recorded Session, which is the
 * common case: capture may be off, the commit may predate it, or it may be
 * human work the link rule deliberately did not attribute to an agent.
 */
function CommitSessions({ repoPath, sha }: { repoPath: string; sha: string }) {
  const addTab = useLayoutStore.use.actions().addTab;
  const [sessions, setSessions] = useState<CommitSession[]>([]);

  useEffect(() => {
    if (!repoPath) return;
    let cancelled = false;
    setSessions([]);
    invoke<CommitSession[]>("capture_commit_sessions", { projectPath: repoPath, commitSha: sha })
      .then((found) => {
        // Typed as an array, but guard the null a future backend change (or an
        // unmocked dev command) could send instead of throwing — `sessions.length`
        // below would otherwise crash on it.
        if (!cancelled) setSessions(found ?? []);
      })
      // A Project with capture off returns an empty list rather than failing,
      // so reaching here means a store-level problem. The commit tab is not the
      // place to report it — capture health already owns that signal.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [repoPath, sha]);

  if (sessions.length === 0) return null;

  const open = (sessionId: string) => {
    // The sha travels with the request so the Session lands on this commit's
    // Checkpoint rather than at the top of a conversation that may have
    // produced several.
    useArtifactsStore
      .getState()
      .actions.openSession({ sessionId, projectPath: repoPath, commitSha: sha });
    addTab({
      id: "artifacts",
      type: "artifacts",
      title: "Timeline",
      closable: true,
      dirty: false,
      data: {},
    });
  };

  return (
    <div className="mt-2 max-w-xl border-t border-border-subtle pt-2">
      <div className="text-3xs uppercase tracking-wider text-muted-foreground">
        Produced by {sessions.length} session{sessions.length === 1 ? "" : "s"}
      </div>
      {sessions.map((s) => (
        <button
          key={s.sessionId}
          onClick={() => open(s.sessionId)}
          className="mt-1 w-full rounded border border-border bg-card px-2 py-1.5 text-left hover:bg-element-hover group"
          title="Open this Session in the Timeline"
        >
          <div className="flex items-start gap-1.5">
            <Sparkles size={11} className="mt-0.5 shrink-0 text-muted-foreground" />
            <span className="text-xs text-secondary-foreground group-hover:text-foreground line-clamp-2">
              {s.title ?? "Untitled session"}
            </span>
          </div>
          <div className="mt-0.5 pl-[18px] text-3xs text-muted-foreground truncate">
            {s.messageCount} message{s.messageCount === 1 ? "" : "s"} · {s.toolCallCount} tool call
            {s.toolCallCount === 1 ? "" : "s"}
            {s.files.length > 0 && ` · ${s.files.join(", ")}`}
          </div>
        </button>
      ))}
    </div>
  );
}
