import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { createSelectors } from "@/lib/create-selectors";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { logEvent } from "@/features/log/lib/log";
import type { GitErrorPayload } from "../lib/git-errors";

export interface GitFileStatus {
  path: string;
  status: string;
  staged: boolean;
}

interface GitLogEntry {
  hash: string;
  short_hash: string;
  message: string;
  author: string;
  date: string;
}

interface GitBranch {
  name: string;
  is_current: boolean;
}

export interface BranchInfo {
  name: string;
  isCurrent: boolean;
  /** True for remote-tracking branches (e.g. `origin/main`). */
  isRemote: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  subject: string;
  date: string;
}

/** Dry-run result of merging a branch into the current one (pre-merge preview). */
export interface MergePreview {
  /** "clean" | "conflicts" | "uptodate" | "invalid" | "unsupported" */
  kind: "clean" | "conflicts" | "uptodate" | "invalid" | "unsupported";
  /** Commits the merge would bring in (on the source branch, not on current). */
  commitCount: number;
  /** Files that would conflict (only meaningful when kind === "conflicts"). */
  conflictedFiles: number;
}

export interface StashEntry {
  index: number;
  message: string;
  branch: string;
}

export interface RemoteInfo {
  name: string;
  url: string;
}

export interface CommitDetail {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  body: string;
  diff: string;
}

export interface InProgress {
  merge: boolean;
  rebase: boolean;
  cherryPick: boolean;
  revert: boolean;
}

/** Wire shape of the Rust `git_snapshot` command — everything the panel
 *  headers need in one IPC call (~4 concurrent spawns Rust-side, coalesced
 *  across concurrent callers). */
interface GitSnapshotWire {
  isRepo: boolean;
  branch: string;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: {
    path: string;
    status: string;
    staged: boolean;
    origPath?: string;
    conflicted: boolean;
  }[];
  branches: BranchInfo[];
  stashes: StashEntry[];
  inProgress: InProgress | null;
}

/** A long-running git operation streaming through `atlas:git:op`. */
export interface ActiveGitOp {
  opId: string;
  kind: string;
  running: boolean;
  /** Live child output (hooks included), newest last. Capped. */
  lines: { stream: "stdout" | "stderr"; text: string }[];
  /** Weighted progress for network ops (`--progress` stderr parsing). */
  progress: { percent: number; title: string } | null;
  error: GitErrorPayload | null;
}

type GitOpEvent = {
  opId: string;
  repo: string;
  kind: string;
} & (
  | { phase: "started" }
  | { phase: "output"; stream: "stdout" | "stderr"; line: string }
  | { phase: "progress"; percent: number; title: string }
  | { phase: "done"; ok: boolean; error?: GitErrorPayload }
);

const OP_LINES_CAP = 500;

function newOpId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `op-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Subscribe once (lazily) to the Rust-side git events. `atlas:git-status-fresh`
 * patches the stale-while-revalidate status; `atlas:git-changed` (fired by the
 * watcher after any mutation, including our own `emit_synthetic_change`) drives
 * a live refresh of the things that change frequently.
 */
let gitStatusFreshListenerInit = false;
function ensureGitStatusFreshListener(): void {
  if (gitStatusFreshListenerInit) return;
  gitStatusFreshListenerInit = true;
  void listen<{
    path: string;
    status: {
      is_repo: boolean;
      branch: string;
      files: GitFileStatus[];
      ahead: number;
      behind: number;
    };
  }>("atlas:git-status-fresh", (e) => {
    const current = useGitStore.getState().repoPath;
    if (!current || current !== e.payload.path) return;
    useGitStore.setState((s) => {
      s.isRepo = e.payload.status.is_repo;
      s.branch = e.payload.status.branch;
      s.files = e.payload.status.files;
      s.ahead = e.payload.status.ahead;
      s.behind = e.payload.status.behind;
    });
  });

  // Live updates from the git watcher — commit / checkout / branch / fetch /
  // stage / push all fire `atlas:git-changed`. One snapshot call covers
  // status, branches, ahead/behind, stashes and in-progress state (the old
  // six-loader fan-out was 10-25 git spawns per change); the log and the
  // working diff are the only extra loads.
  void listen<{ project: string }>("atlas:git-changed", (e) => {
    const current = useGitStore.getState().repoPath;
    if (!current || current !== e.payload.project) return;
    const actions = useGitStore.getState().actions;
    void actions.refresh(current).catch(() => {});
    // The log MUST refresh here. Every action that rewrites history —
    // commit, reset, revert, cherry-pick, merge, pull — mutates `.git/refs`
    // and so lands on this event, and none of them reload the log
    // themselves.
    void actions.loadLog(current).catch(() => {});
    void actions.loadDiff().catch(() => {});
  });

  // Streaming output from long git operations (commit hooks today; push/
  // pull progress later). Drives the commit busy state and the live output
  // strip under the commit box.
  void listen<GitOpEvent>("atlas:git:op", (e) => {
    const p = e.payload;
    useGitStore.setState((s) => {
      switch (p.phase) {
        case "started":
          s.activeOp = {
            opId: p.opId,
            kind: p.kind,
            running: true,
            lines: [],
            progress: null,
            error: null,
          };
          break;
        case "output":
          if (s.activeOp?.opId === p.opId) {
            s.activeOp.lines.push({ stream: p.stream, text: p.line });
            if (s.activeOp.lines.length > OP_LINES_CAP) {
              s.activeOp.lines.splice(0, s.activeOp.lines.length - OP_LINES_CAP);
            }
          }
          break;
        case "progress":
          if (s.activeOp?.opId === p.opId) {
            s.activeOp.progress = { percent: p.percent, title: p.title };
          }
          break;
        case "done":
          if (s.activeOp?.opId === p.opId) {
            if (p.ok) {
              // Success: the refresh + cleared form already signal it.
              s.activeOp = null;
            } else {
              s.activeOp.running = false;
              s.activeOp.error = p.error ?? null;
            }
          }
          break;
      }
    });
  });

  // Workspace edits Atlas didn't originate (terminal git, external editor).
  // Editor saves inside Atlas refresh directly (see editor-panel) and don't
  // depend on this. Short debounce just coalesces fs-event bursts.
  let workspaceDebounce: ReturnType<typeof setTimeout> | null = null;
  void listen("atlas:explorer:changed", () => {
    const current = useGitStore.getState().repoPath;
    if (!current) return;
    if (workspaceDebounce) clearTimeout(workspaceDebounce);
    workspaceDebounce = setTimeout(() => {
      workspaceDebounce = null;
      const repoPath = useGitStore.getState().repoPath;
      if (!repoPath) return;
      const actions = useGitStore.getState().actions;
      void actions.refreshStatusNow(repoPath).catch(() => {});
      void actions.loadDiff().catch(() => {});
    }, 120);
  });
}

interface GitState {
  isRepo: boolean;
  branch: string;
  branches: GitBranch[];
  branchesFull: BranchInfo[];
  files: GitFileStatus[];
  log: GitLogEntry[];
  diff: string;
  ahead: number;
  behind: number;
  loading: boolean;
  repoPath: string | null;
  stashes: StashEntry[];
  remotes: RemoteInfo[];
  tags: string[];
  selectedCommit: CommitDetail | null;
  inProgress: InProgress | null;
  /** Live streaming git operation (commit with hooks, later push/pull). */
  activeOp: ActiveGitOp | null;
  /** Typed git error currently shown in the error dialog. */
  errorDialog: GitErrorPayload | null;
}

interface GitActions {
  actions: {
    loadStatus: (path: string) => Promise<void>;
    /** One-shot snapshot refresh (status + branches + ahead/behind +
     *  stashes + in-progress) — a single IPC call, coalesced Rust-side.
     *  Defaults to the active `repoPath`. */
    refresh: (path?: string) => Promise<void>;
    /** Force-fresh status refresh for changes Atlas originates (git
     *  mutations, editor saves). Patches in place — no `loading` flicker.
     *  Now snapshot-backed; defaults to the active `repoPath`. */
    refreshStatusNow: (path?: string) => Promise<void>;
    showErrorDialog: (payload: GitErrorPayload) => void;
    dismissErrorDialog: () => void;
    loadLog: (path: string) => Promise<void>;
    loadDiff: () => Promise<void>;
    listBranches: () => Promise<void>;
    loadBranchesFull: () => Promise<void>;
    loadStashes: () => Promise<void>;
    loadRemotes: () => Promise<void>;
    loadTags: () => Promise<void>;
    loadInProgress: () => Promise<void>;
    loadCommit: (sha: string) => Promise<void>;
    clearSelectedCommit: () => void;
    /** Load everything (mount / panel open). */
    refreshAll: (path: string) => Promise<void>;
    // mutations
    checkout: (branch: string) => Promise<void>;
    createBranch: (name: string) => Promise<void>;
    renameBranch: (oldName: string, newName: string) => Promise<void>;
    deleteBranch: (name: string, force?: boolean) => Promise<void>;
    mergeBranch: (branch: string) => Promise<void>;
    /** Rebase the current branch onto `base` (streams via activeOp). */
    rebase: (base: string) => Promise<void>;
    /** Undo the last (unpushed) commit — `reset --soft HEAD~1`. */
    undoCommit: () => Promise<void>;
    /** Squash the last `count` (unpushed) commits into one. */
    squashLast: (count: number, summary: string, description?: string) => Promise<void>;
    /** Read-only dry run: what merging `branch` into current would do. */
    mergePreview: (branch: string) => Promise<MergePreview>;
    stageFiles: (paths: string[]) => Promise<void>;
    unstageFiles: (paths: string[]) => Promise<void>;
    discard: (paths: string[]) => Promise<void>;
    /** Revert ADDED files by deleting them (no HEAD to restore to). */
    discardAdded: (paths: string[]) => Promise<void>;
    commit: (
      summary: string,
      description?: string,
      amend?: boolean,
      coAuthors?: string[],
    ) => Promise<void>;
    fetch: () => Promise<void>;
    pull: (rebase: boolean) => Promise<void>;
    push: (forceWithLease?: boolean, followTags?: boolean) => Promise<void>;
    publishBranch: () => Promise<void>;
    remoteAdd: (name: string, url: string) => Promise<void>;
    remoteRemove: (name: string) => Promise<void>;
    stashPush: (message?: string) => Promise<void>;
    stashApply: (index: number) => Promise<void>;
    stashPop: (index: number) => Promise<void>;
    stashDrop: (index: number) => Promise<void>;
    reset: (target: string, mode: "soft" | "mixed" | "hard") => Promise<void>;
    revert: (sha: string) => Promise<void>;
    cherryPick: (sha: string) => Promise<void>;
    createTag: (name: string, target?: string, message?: string) => Promise<void>;
    deleteTag: (name: string) => Promise<void>;
    opControl: (
      kind: "merge" | "rebase" | "cherry-pick" | "revert",
      action: "abort" | "continue",
    ) => Promise<void>;
  };
}

export const useGitStore = createSelectors(
  create<GitState & GitActions>()(
    immer((set, get) => {
      const repo = () => get().repoPath;

      return {
        isRepo: false,
        branch: "",
        branches: [],
        branchesFull: [],
        files: [],
        log: [],
        diff: "",
        ahead: 0,
        behind: 0,
        loading: false,
        repoPath: null,
        stashes: [],
        remotes: [],
        tags: [],
        selectedCommit: null,
        inProgress: null,
        activeOp: null,
        errorDialog: null,
        actions: {
          loadStatus: async (path) => {
            ensureGitStatusFreshListener();
            set((s) => {
              s.loading = true;
              s.repoPath = path;
            });
            await get().actions.refresh(path);
            set((s) => {
              s.loading = false;
            });
          },
          refresh: async (path) => {
            ensureGitStatusFreshListener();
            const p = path ?? get().repoPath;
            if (!p) return;
            // No `loading = true` here — in-place patch, no flicker.
            set((s) => {
              s.repoPath = p;
            });
            try {
              const snap = await invoke<GitSnapshotWire>("git_snapshot", { path: p });
              set((s) => {
                s.isRepo = snap.isRepo;
                s.branch = snap.branch;
                s.files = snap.files.map((f) => ({
                  path: f.path,
                  status: f.status,
                  staged: f.staged,
                }));
                s.ahead = snap.ahead;
                s.behind = snap.behind;
                s.branchesFull = snap.branches;
                s.branches = snap.branches
                  .filter((b) => !b.isRemote)
                  .map((b) => ({ name: b.name, is_current: b.isCurrent }));
                s.stashes = snap.stashes;
                s.inProgress = snap.inProgress;
              });
            } catch {
              /* not a repo / transient — leave prior state */
            }
          },
          refreshStatusNow: async (path) => {
            await get().actions.refresh(path);
          },
          showErrorDialog: (payload) =>
            set((s) => {
              s.errorDialog = payload;
            }),
          dismissErrorDialog: () =>
            set((s) => {
              s.errorDialog = null;
            }),
          loadLog: async (path) => {
            try {
              const entries = await invoke<GitLogEntry[]>("git_log", { path, limit: 100 });
              set((s) => {
                s.log = entries;
              });
            } catch {
              /* not a repo */
            }
          },
          loadDiff: async () => {
            const p = repo();
            if (!p) return;
            try {
              const diff = await invoke<string>("git_diff_all", { path: p });
              set((s) => {
                s.diff = diff;
              });
            } catch {
              /* ignore */
            }
          },
          listBranches: async () => {
            const p = repo();
            if (!p) return;
            try {
              const branches = await invoke<GitBranch[]>("git_list_branches", { path: p });
              set((s) => {
                s.branches = branches;
              });
            } catch {
              /* ignore */
            }
          },
          loadBranchesFull: async () => {
            const p = repo();
            if (!p) return;
            try {
              const b = await invoke<BranchInfo[]>("git_branches_full", { path: p });
              set((s) => {
                s.branchesFull = b;
              });
            } catch {
              /* ignore */
            }
          },
          loadStashes: async () => {
            const p = repo();
            if (!p) return;
            try {
              const stashes = await invoke<StashEntry[]>("git_stash_list", { path: p });
              set((s) => {
                s.stashes = stashes;
              });
            } catch {
              /* ignore */
            }
          },
          loadRemotes: async () => {
            const p = repo();
            if (!p) return;
            try {
              const remotes = await invoke<RemoteInfo[]>("git_remotes", { path: p });
              set((s) => {
                s.remotes = remotes;
              });
            } catch {
              /* ignore */
            }
          },
          loadTags: async () => {
            const p = repo();
            if (!p) return;
            try {
              const tags = await invoke<string[]>("git_tags", { path: p });
              set((s) => {
                s.tags = tags;
              });
            } catch {
              /* ignore */
            }
          },
          loadInProgress: async () => {
            const p = repo();
            if (!p) return;
            try {
              const ip = await invoke<InProgress>("git_inprogress", { path: p });
              set((s) => {
                s.inProgress = ip.merge || ip.rebase || ip.cherryPick || ip.revert ? ip : null;
              });
            } catch {
              /* ignore */
            }
          },
          loadCommit: async (sha) => {
            const p = repo();
            if (!p) return;
            try {
              const detail = await invoke<CommitDetail>("git_show", { path: p, sha });
              set((s) => {
                s.selectedCommit = detail;
              });
            } catch {
              /* ignore */
            }
          },
          clearSelectedCommit: () =>
            set((s) => {
              s.selectedCommit = null;
            }),
          refreshAll: async (path) => {
            const a = get().actions;
            // The snapshot covers status/branches/stashes/in-progress;
            // only the diff, remotes, tags and log are separate loads.
            await a.loadStatus(path);
            await Promise.all([a.loadDiff(), a.loadRemotes(), a.loadTags(), a.loadLog(path)]);
          },

          checkout: async (branch) => {
            const p = repo();
            if (!p) return;
            await invoke("git_checkout", { path: p, branch });
            logEvent({ source: "git", kind: "checkout", summary: branch, payload: { branch } });
            // Switching branches changes HEAD + working-tree status — update
            // now; the watcher (HEAD move) reconciles branch lists shortly.
            await get().actions.refreshStatusNow(p);
            void get().actions.loadDiff();
          },
          createBranch: async (name) => {
            const p = repo();
            if (!p) return;
            await invoke("git_create_branch", { path: p, name });
            logEvent({ source: "git", kind: "branch-create", summary: name, payload: { name } });
          },
          renameBranch: async (oldName, newName) => {
            const p = repo();
            if (!p) return;
            await invoke("git_rename_branch", { path: p, oldName, newName });
          },
          deleteBranch: async (name, force = false) => {
            const p = repo();
            if (!p) return;
            await invoke("git_branch_delete", { path: p, name, force });
            logEvent({ source: "git", kind: "branch-delete", summary: name, payload: { name } });
          },
          mergeBranch: async (branch) => {
            const p = repo();
            if (!p) return;
            await invoke("git_merge_branch", { path: p, branch });
          },
          rebase: async (base) => {
            const p = repo();
            if (!p) return;
            await invoke("git_rebase", { path: p, base, opId: newOpId() });
            logEvent({ source: "git", kind: "rebase", summary: base, payload: { base } });
          },
          undoCommit: async () => {
            const p = repo();
            if (!p) return;
            await invoke("git_undo_commit", { path: p });
            await get().actions.refresh(p);
            void get().actions.loadLog(p);
            void get().actions.loadDiff();
          },
          squashLast: async (count, summary, description) => {
            const p = repo();
            if (!p) return;
            await invoke("git_squash_last", {
              path: p,
              count,
              summary,
              description: description ?? null,
            });
            await get().actions.refresh(p);
            void get().actions.loadLog(p);
          },
          mergePreview: async (branch) => {
            const p = repo();
            if (!p) {
              return { kind: "invalid", commitCount: 0, conflictedFiles: 0 };
            }
            return invoke<MergePreview>("git_merge_preview", { path: p, branch });
          },
          stageFiles: async (paths) => {
            const p = repo();
            if (!p) return;
            await invoke("git_stage", { path: p, files: paths });
            // Refresh immediately — don't wait for the `.git/index` fs
            // watcher (FSEvents latency + 200 ms debounce + stale round-trip).
            await get().actions.refreshStatusNow(p);
            void get().actions.loadDiff();
          },
          unstageFiles: async (paths) => {
            const p = repo();
            if (!p) return;
            await invoke("git_unstage", { path: p, files: paths });
            await get().actions.refreshStatusNow(p);
            void get().actions.loadDiff();
          },
          discard: async (paths) => {
            const p = repo();
            if (!p) return;
            await invoke("git_discard", { path: p, files: paths });
            await get().actions.refreshStatusNow(p);
            void get().actions.loadDiff();
          },
          discardAdded: async (paths) => {
            const p = repo();
            if (!p) return;
            await invoke("git_delete_added", { path: p, files: paths });
            await get().actions.refreshStatusNow(p);
            void get().actions.loadDiff();
          },
          commit: async (summary, description, amend = false, coAuthors) => {
            const p = repo();
            if (!p) return;
            // v2 commit: message over stdin (`commit -F -`), hooks run and
            // their output streams live as `atlas:git:op` events (the
            // `activeOp` slice), typed errors instead of raw stderr.
            const opId = newOpId();
            await invoke("git_commit_v2", {
              path: p,
              summary,
              description: description ?? null,
              amend,
              coAuthors: coAuthors && coAuthors.length > 0 ? coAuthors : null,
              opId,
            });
            logEvent({
              source: "git",
              kind: "commit",
              summary: summary.slice(0, 120),
              payload: {},
            });
            // Commit clears the staged set and moves HEAD — one snapshot
            // covers status, ahead/behind and branches.
            await get().actions.refresh(p);
            void get().actions.loadDiff();
          },
          fetch: async () => {
            const p = repo();
            if (!p) return;
            await invoke("git_fetch", { path: p, opId: newOpId() });
          },
          pull: async (rebase) => {
            const p = repo();
            if (!p) return;
            await invoke("git_pull", { path: p, rebase, remote: null, opId: newOpId() });
          },
          push: async (forceWithLease = false, followTags = false) => {
            const p = repo();
            if (!p) return;
            await invoke("git_push", {
              path: p,
              forceWithLease,
              followTags,
              remote: null,
              opId: newOpId(),
            });
          },
          publishBranch: async () => {
            const p = repo();
            if (!p) return;
            await invoke("git_publish_branch", { path: p, remote: null, opId: newOpId() });
          },
          remoteAdd: async (name, url) => {
            const p = repo();
            if (!p) return;
            await invoke("git_remote_add", { path: p, name, url });
            await get().actions.loadRemotes();
          },
          remoteRemove: async (name) => {
            const p = repo();
            if (!p) return;
            await invoke("git_remote_remove", { path: p, name });
            await get().actions.loadRemotes();
          },
          stashPush: async (message) => {
            const p = repo();
            if (!p) return;
            await invoke("git_stash_push", { path: p, message: message ?? null });
            await get().actions.loadStashes();
          },
          stashApply: async (index) => {
            const p = repo();
            if (!p) return;
            await invoke("git_stash_apply", { path: p, index });
          },
          stashPop: async (index) => {
            const p = repo();
            if (!p) return;
            await invoke("git_stash_pop", { path: p, index });
            await get().actions.loadStashes();
          },
          stashDrop: async (index) => {
            const p = repo();
            if (!p) return;
            await invoke("git_stash_drop", { path: p, index });
            await get().actions.loadStashes();
          },
          reset: async (target, mode) => {
            const p = repo();
            if (!p) return;
            await invoke("git_reset", { path: p, target, mode });
          },
          revert: async (sha) => {
            const p = repo();
            if (!p) return;
            await invoke("git_revert", { path: p, sha });
          },
          cherryPick: async (sha) => {
            const p = repo();
            if (!p) return;
            await invoke("git_cherry_pick", { path: p, sha });
          },
          createTag: async (name, target, message) => {
            const p = repo();
            if (!p) return;
            await invoke("git_create_tag", {
              path: p,
              name,
              target: target ?? null,
              message: message ?? null,
            });
            await get().actions.loadTags();
          },
          deleteTag: async (name) => {
            const p = repo();
            if (!p) return;
            await invoke("git_delete_tag", { path: p, name });
            await get().actions.loadTags();
          },
          opControl: async (kind, action) => {
            const p = repo();
            if (!p) return;
            await invoke("git_op_control", { path: p, kind, action });
          },
        },
      };
    }),
  ),
);
