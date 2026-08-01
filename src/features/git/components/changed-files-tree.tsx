import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  ChevronDown,
  GitCommit,
  GitBranch,
  Search,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { useGitStore } from "../stores/git-store";
import { openGitDiff, gitCommitChangedFiles } from "../lib/git-diff-api";

const TREE_ROW_H = 22;

interface CommitLite {
  hash: string;
  short_hash: string;
  message: string;
  author?: string;
}

/** Searchable commit combobox with the current branch shown as a pill. Replaces
 *  the plain <select>; "Working tree" is the default (null commit). */
function CommitPicker({
  commit,
  branch,
  log,
  onPick,
}: {
  commit: string | null;
  branch: string;
  log: CommitLite[];
  onPick: (sha: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const selected = commit ? (log.find((c) => c.hash === commit) ?? null) : null;
  const label = commit
    ? selected
      ? `${selected.short_hash} · ${selected.message}`
      : commit.slice(0, 7)
    : "Working tree";

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return log;
    return log.filter(
      (c) =>
        c.short_hash.toLowerCase().includes(s) ||
        c.message.toLowerCase().includes(s) ||
        (c.author ?? "").toLowerCase().includes(s),
    );
  }, [log, q]);

  const pick = (sha: string) => {
    onPick(sha);
    setOpen(false);
    setQ("");
  };

  return (
    <div className="relative min-w-0 flex-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Inspect a commit's changes"
        className="flex h-6 w-full min-w-0 items-center gap-1 rounded border border-[var(--border-default)] bg-[var(--bg-elevated)] px-1.5 text-[10px] text-[var(--text-primary)] outline-none hover:bg-[var(--bg-hover)]"
      >
        {branch && (
          <span className="flex shrink-0 items-center gap-0.5 rounded bg-[var(--bg-secondary)] px-1 py-px text-[9px] text-[var(--text-tertiary)]">
            <GitBranch size={8} />
            <span className="max-w-[70px] truncate">{branch}</span>
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-left font-mono">
          {label}
        </span>
        <ChevronDown
          size={11}
          className="shrink-0 text-[var(--text-tertiary)]"
        />
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-md border border-[var(--border-default)] bg-[var(--bg-elevated)] shadow-[var(--shadow-overlay)]">
            <div className="flex h-7 items-center gap-1.5 border-b border-[var(--border-subtle)] px-2">
              <Search
                size={11}
                className="shrink-0 text-[var(--text-tertiary)]"
              />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search commits…"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-[10px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
              />
            </div>
            <div className="max-h-[280px] overflow-y-auto hide-scrollbar py-1">
              <button
                type="button"
                onClick={() => pick("")}
                className={cn(
                  "flex w-full items-center px-2 py-1.5 text-left text-[10px] hover:bg-[var(--bg-hover)]",
                  !commit
                    ? "text-[var(--text-primary)]"
                    : "text-[var(--text-secondary)]",
                )}
              >
                Working tree
              </button>
              {filtered.map((c) => (
                <button
                  key={c.hash}
                  type="button"
                  onClick={() => pick(c.hash)}
                  className={cn(
                    "flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[10px] hover:bg-[var(--bg-hover)]",
                    c.hash === commit
                      ? "text-[var(--text-primary)]"
                      : "text-[var(--text-secondary)]",
                  )}
                >
                  <span className="shrink-0 font-mono text-[var(--text-tertiary)]">
                    {c.short_hash}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{c.message}</span>
                </button>
              ))}
              {filtered.length === 0 && (
                <div className="px-2 py-2 text-[10px] text-[var(--text-tertiary)]">
                  No commits
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

interface ChangedFilesTreeProps {
  repoPath: string;
  /** Staged-ness of the diff tab — the tree lists files of the same kind and
   *  opens them with the same flag so a click always lands on a real diff. */
  staged: boolean;
  /** Path of the file currently shown in the diff pane (highlighted). */
  currentFile: string;
  /** When set, the tree lists the files changed by this commit (commit-browse
   *  mode) instead of the working tree; the picker at the top switches it. */
  commit?: string | null;
}

interface DirNode {
  name: string;
  path: string;
  isDir: true;
  children: TreeNode[];
}
interface FileNode {
  name: string;
  path: string;
  isDir: false;
  status: string;
}
type TreeNode = DirNode | FileNode;

/** First porcelain char → a tint. Mirrors the Changes-panel status badges. */
function statusColor(status: string): string {
  switch (status[0]) {
    case "A":
    case "?":
      return "var(--status-success, #22c55e)";
    case "M":
      return "var(--status-warning, #f5b43c)";
    case "D":
      return "var(--status-error, #ef4444)";
    case "R":
    case "C":
      return "var(--accent, #6ea8fe)";
    default:
      return "var(--text-tertiary)";
  }
}

/** First porcelain char → the single-letter badge. Untracked (`?`) reads as a
 *  new file, so show "A" (Added) rather than the raw porcelain "?". */
function statusLetter(status: string): string {
  const c = status[0];
  return c === "?" ? "A" : c;
}

function buildTree(files: { path: string; status: string }[]): DirNode {
  const root: DirNode = { name: "", path: "", isDir: true, children: [] };
  for (const { path, status } of files) {
    const parts = path.split("/");
    let dir = root;
    let acc = "";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      acc = acc ? `${acc}/${part}` : part;
      if (i === parts.length - 1) {
        dir.children.push({ name: part, path, isDir: false, status });
      } else {
        let next = dir.children.find(
          (c): c is DirNode => c.isDir && c.name === part,
        );
        if (!next) {
          next = { name: part, path: acc, isDir: true, children: [] };
          dir.children.push(next);
        }
        dir = next;
      }
    }
  }
  collapseChains(root);
  sortTree(root);
  return root;
}

/** Fold single-child directory chains into one row (src ▸ features ▸ git →
 *  "src/features/git"), the way VS Code / JetBrains compact trees do. */
function collapseChains(dir: DirNode) {
  for (const child of dir.children) {
    if (child.isDir) collapseChains(child);
  }
  // Root keeps its (empty) name; only fold interior dirs.
  if (dir.name !== "" && dir.children.length === 1 && dir.children[0].isDir) {
    const only = dir.children[0];
    dir.name = `${dir.name}/${only.name}`;
    dir.path = only.path;
    dir.children = only.children;
  }
}

function sortTree(dir: DirNode) {
  dir.children.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const c of dir.children) if (c.isDir) sortTree(c);
}

interface FlatRow {
  node: TreeNode;
  depth: number;
}

function flatten(
  dir: DirNode,
  collapsed: Set<string>,
  depth: number,
): FlatRow[] {
  const out: FlatRow[] = [];
  for (const child of dir.children) {
    out.push({ node: child, depth });
    if (child.isDir && !collapsed.has(child.path)) {
      out.push(...flatten(child, collapsed, depth + 1));
    }
  }
  return out;
}

export const ChangedFilesTree = memo(function ChangedFilesTree({
  repoPath,
  staged,
  currentFile,
  commit = null,
}: ChangedFilesTreeProps) {
  const files = useGitStore.use.files();
  const log = useGitStore.use.log();
  const branch = useGitStore.use.branch();
  const gitActions = useGitStore.use.actions();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Populate the commit picker (recent history) on first mount.
  useEffect(() => {
    if (repoPath && log.length === 0)
      void gitActions.loadLog(repoPath).catch(() => {});
  }, [repoPath, log.length, gitActions]);

  // In commit-browse mode, list the files that commit changed.
  const commitFilesQuery = useQuery({
    queryKey: ["commit-files", repoPath, commit],
    queryFn: () => gitCommitChangedFiles(repoPath, commit!),
    enabled: !!repoPath && !!commit,
    staleTime: 30_000,
  });

  const openFile = (path: string) =>
    openGitDiff(repoPath, path, staged, commit);

  // Switch the whole diff tab to a different commit (or the working tree) for
  // the currently-open file.
  const onPickCommit = (sha: string) =>
    openGitDiff(repoPath, currentFile, staged, sha || null);

  const tree = useMemo(() => {
    const seen = new Set<string>();
    const source: { path: string; status: string }[] = commit
      ? (commitFilesQuery.data ?? []).map((f) => ({
          path: f.path,
          status: f.status,
        }))
      : files
          .filter((f) => f.staged === staged)
          .map((f) => ({ path: f.path, status: f.status }));
    const scoped = source.filter((f) =>
      seen.has(f.path) ? false : (seen.add(f.path), true),
    );
    // Ensure the open file is present even if the store hasn't caught up.
    if (currentFile && !seen.has(currentFile)) {
      scoped.push({ path: currentFile, status: "M" });
    }
    return buildTree(scoped);
  }, [files, staged, currentFile, commit, commitFilesQuery.data]);

  const rows = useMemo(() => flatten(tree, collapsed, 0), [tree, collapsed]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => TREE_ROW_H,
    overscan: 20,
  });

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className="flex h-full w-full flex-col border-r border-[var(--border-default)] bg-[var(--bg-secondary)]">
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-[var(--border-default)] px-2">
        <GitCommit size={12} className="shrink-0 text-[var(--text-tertiary)]" />
        <CommitPicker
          commit={commit}
          branch={branch}
          log={log}
          onPick={onPickCommit}
        />
        <span className="shrink-0 text-[10px] tabular-nums text-[var(--text-tertiary)]">
          {rows.filter((r) => !r.node.isDir).length}
        </span>
      </div>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto hide-scrollbar py-1"
      >
        <div
          style={{ height: virtualizer.getTotalSize(), position: "relative" }}
        >
          {virtualizer.getVirtualItems().map((vr) => {
            const { node, depth } = rows[vr.index];
            const pad = 6 + depth * 12;
            const common = {
              className:
                "absolute left-0 right-0 flex items-center gap-1 pr-2 text-left hover:bg-[var(--bg-hover)] cursor-pointer",
              style: { top: vr.start, height: TREE_ROW_H, paddingLeft: pad },
            } as const;
            if (node.isDir) {
              const open = !collapsed.has(node.path);
              return (
                <button
                  key={`d:${node.path}`}
                  onClick={() => toggle(node.path)}
                  className={`${common.className} text-[11px] text-[var(--text-tertiary)]`}
                  style={common.style}
                >
                  {open ? (
                    <ChevronDown size={11} />
                  ) : (
                    <ChevronRight size={11} />
                  )}
                  <span className="truncate font-mono">{node.name}</span>
                </button>
              );
            }
            const active = node.path === currentFile;
            return (
              <button
                key={`f:${node.path}`}
                onClick={() => openFile(node.path)}
                title={node.path}
                className={`${common.className} gap-1.5 text-[11px] ${
                  active
                    ? "bg-[var(--bg-active,var(--bg-hover))] text-[var(--text-primary)]"
                    : "text-[var(--text-secondary)]"
                }`}
                style={{ ...common.style, paddingLeft: pad + 12 }}
              >
                <span
                  className="w-2 shrink-0 text-center font-mono text-[9px]"
                  style={{ color: statusColor(node.status) }}
                >
                  {statusLetter(node.status)}
                </span>
                <span className="truncate font-mono">{node.name}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
});
