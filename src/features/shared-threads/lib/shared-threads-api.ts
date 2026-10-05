import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Shared Threads (ATL-395): one piece of work several members and agents carry
 * out together, with its file state held in the cloud. This module mirrors
 * `src-tauri/src/commands/shared_threads.rs`; only Rust holds the bearer.
 */

/** Pushed by Rust whenever a joined thread's status changes. */
export const SHARED_THREADS_EVENT = "atlas:shared-threads";

/** Pushed by Rust for every live frame of somebody else's Run (ATL-405). */
export const SHARED_RUN_FRAME_EVENT = "atlas:shared-run-frame";

/** Pushed by Rust to the owner when somebody asks to join (ATL-406). */
export const SHARED_JOIN_REQUEST_EVENT = "atlas:shared-thread-join-requested";

/** Pushed by Rust when who is here, or what they are doing, changes (ATL-407). */
export const SHARED_PRESENCE_EVENT = "atlas:shared-thread-presence";

/** Pushed by Rust when a file open in the Atlas editor changed (ATL-407). */
export const SHARED_DOC_UPDATE_EVENT = "atlas:shared-doc-update";

/** Pushed by Rust when a joined thread's Thread Versions changed (ATL-419). */
export const SHARED_VERSIONS_EVENT = "atlas:shared-thread-versions";

/** Pushed by Rust when a Remote Run request this person asked or must run changed (ATL-417). */
export const SHARED_REMOTE_RUN_EVENT = "atlas:shared-remote-run";

/** How far a replica is from the thread's head, as it says of itself. */
export type SyncState = "current" | "syncing" | "behind";

/** Somebody else on the thread (ATL-407): a desktop or the web view. */
export interface SharedPeer {
  peerId: string;
  userId: string;
  role: string;
  surface: "desktop" | "web" | (string & {});
  /** The file they are typing in. */
  typing: string | null;
  cursors: Array<{ fileId: number; path: string | null; anchor: number; head: number }>;
  /** Their Runs in flight and the file each is touching. */
  runs: Array<{ runId: string; path: string | null }>;
  sync: SyncState | null;
}

/** A replica file bound to the Atlas editor. */
export interface SharedDoc {
  sharedThreadId: string;
  fileId: number;
  /** The document now: one Yjs update, base64. */
  state: string;
}

/**
 * A Run (ATL-405): one agent turn in the thread, run by a participant in their
 * own Run worktree and merged back when it ends.
 */
export interface SharedThreadRun {
  runId: string;
  /** The thread-local number shown on its chip. */
  runNo: number;
  promptedBy: string;
  runnerId: string;
  agent: string;
  model: string;
  forkSeq: number;
  status: "running" | "merged" | "ended" | "interrupted" | "declined" | (string & {});
  startedAt: number;
  endedAt: number | null;
  mergedVersion: number | null;
  /** The paths its merge changed. */
  files: string[];
  /** The file it is touching now, as its Runner says (ATL-407). */
  currentFile: string | null;
}

/** One live frame: a `SessionDelta` the Runner's agent emitted. */
export interface SharedRunFrame {
  sharedThreadId: string;
  runNo: number;
  delta: { kind: string; delta?: string; [key: string]: unknown };
}

/** Which way a Conflict was, or is to be, resolved (ATL-410). */
export type ConflictSide = "canonical" | "run" | "both" | "edited" | "agent";

/**
 * A Conflict (ATL-410): a hunk where a Run's change and a change canonical
 * state took since the Run forked touch the same lines. Canonical state keeps
 * its version until somebody resolves it. For a binary file the three sides
 * are blob hashes and `lines` is `null`.
 */
export interface SharedThreadConflict {
  conflictId: number;
  fileId: number;
  path: string;
  runId: string;
  status: "open" | "resolved" | (string & {});
  /** Canonical state's lines, 0-based, `end` exclusive, when it was raised. */
  lines: { start: number; end: number } | null;
  binary: boolean;
  base: string | null;
  canonical: string | null;
  run: string | null;
  involved: { runs: string[]; people: string[] };
  raisedBy: string;
  raisedAt: number;
  resolution: {
    text: string;
    side: ConflictSide;
    resolvedBy: string;
    resolvedAt: number;
    version: number;
  } | null;
  /** Who ran the Run whose hunk was held, and its agent. */
  runBy: string | null;
  runAgent: string | null;
  /** Who else changed those lines, and other Runs' agents. */
  canonicalBy: string[];
  canonicalAgents: string[];
  /** The proposed result; `null` for a binary file. */
  proposed: string | null;
}

/** Where a Remote Run request stands (ADR-0023). */
export type RemoteRunStatus = "pending" | "approved" | "declined" | "timed_out" | "executed";

/**
 * A Remote Run request (ATL-417): `requestedBy` asks `runnerId`'s desktop to
 * run `prompt` with `agent`, on the Runner's machine and bill.
 */
export interface RemoteRun {
  requestId: string;
  threadId: string;
  requestedBy: string;
  runnerId: string;
  prompt: string;
  agent: string;
  model: string | null;
  status: RemoteRunStatus;
  /** Approved by the Runner's auto-approve rather than by hand. */
  auto: boolean;
  requestedAt: number;
  /** When it times out unless answered (pending) or started (approved). */
  expiresAt: number;
  answeredAt: number | null;
  /** The Run that executed it. */
  runId: string | null;
}

/** Remote Runs as this machine knows them in one thread (ATL-417). */
export interface SharedRemote {
  /** Who this person is on the thread. */
  userId: string | null;
  /** The agents this machine offers for Remote Runs here; empty until it first accepts. */
  agents: string[];
  /** "Accept Remote Runs" in this thread. */
  accept: boolean;
  /** The one person whose requests here are approved without asking. */
  autoApprove: string | null;
  /** Requests this person asked or must run, newest first. */
  requests: RemoteRun[];
}

/** Whom this person may ask now: the gate refusing every ask, or the Runners online. */
export interface RemoteRunners {
  gate: string | null;
  runners: Array<{ userId: string; agents: string[] }>;
}

export interface SharedThreadStatus {
  connected: boolean;
  role: string | null;
  /** The newest change this replica has seen. */
  head: number;
  /** Whether the replica worktree has been checked out yet. */
  materialized: boolean;
  /** Where the replica worktree is (or will be) — never the person's own checkout. */
  worktree: string;
  files: number;
  /** Files kept on this machine because they now look like they hold a secret. */
  held: string[];
  /** The thread's Runs, newest first. */
  runs: SharedThreadRun[];
  /**
   * Why this replica can only watch — the Base never reached this machine,
   * a viewer's role, a closed thread — or `null` when it can edit.
   */
  readOnly: string | null;
  /** Whether this machine sends the repository's history to teammates who lack the Base. */
  servesHistory: boolean;
  /** Teammates waiting for that history while it is not being sent. */
  historyWanted: number;
  /**
   * What was done on the person's behalf — a file of theirs moved aside for a
   * teammate's change, a drifted replica repaired — newest last.
   */
  notices: string[];
  /** Saves kept on this machine because it may not change the thread; they go once it may. */
  unsent: string[];
  /** The thread is closed: read-only on every replica until it is reopened. */
  closed: boolean;
  /** Text files that stopped syncing: they grew past 1 MB or turned binary. */
  outgrown: string[];
  /** The thread's Conflicts, open ones first (ATL-410). */
  conflicts: SharedThreadConflict[];
  /** Everybody else here (ATL-407). */
  peers: SharedPeer[];
  /** Whether this replica is current, syncing or behind. */
  sync: SyncState | null;
  /** Remote Runs here (ATL-417). Absent from a status pushed before it. */
  remote?: SharedRemote;
  error: string | null;
}

export interface BlockedFile {
  path: string;
  /** `name`, or the secret categories the content matched. */
  reason: string;
}

/** One row of the share dialog (ATL-402): a file the share would upload. */
export interface ShareFile {
  path: string;
  /** `text` is co-edited; `binary` (or over 1 MB) syncs as whole bytes. */
  kind: "text" | "binary";
  bytes: number;
  /** Deleted in the working tree: the share deletes it in the thread. */
  deleted: boolean;
  /** Held back unless included anyway: `name`, or the secret categories matched. */
  blocked: string | null;
}

export interface SharedThreadView {
  sharedThreadId: string;
  orgId: string;
  workspaceId: string;
  title: string;
  /** The commit the thread's canonical state starts from. */
  base: string;
  role: string;
  /**
   * The person's own checkout of the project, when they have one. Only ever
   * read. `null` for somebody who joined with no copy of the repository.
   */
  projectPath: string | null;
  clientId: string;
  /** Whether this machine sends the repository's history to teammates who need it. */
  serveHistory: boolean;
  /** What to send a teammate. */
  link: string;
  status: SharedThreadStatus;
  /** The local chat session shared as this thread, when shared from this machine. */
  sessionId: string | null;
  /** On a share: what was uploaded and what was held back. Empty otherwise. */
  sharedFiles: string[];
  blockedFiles: BlockedFile[];
  /** This thread's Run worktree on this machine: a session there runs in the thread. */
  runWorktree: string;
}

/** What the owner manages (ATL-406). */
export interface OwnerView {
  joinPolicy: "auto" | "approval" | (string & {});
  status: "open" | "closed" | (string & {});
  closedAt: number | null;
  purgeAt: number | null;
  participants: Array<{ userId: string; role: string; joinedAt: number }>;
  requests: Array<{ userId: string; requestedAt: number }>;
}

/** A refusal Rust (or the server) explained. `code` is stable; branch on it. */
export interface SharedThreadError {
  code: string;
  message: string;
}

export function sharedThreadError(e: unknown): SharedThreadError {
  if (e && typeof e === "object" && "code" in e && "message" in e) {
    return {
      code: String((e as SharedThreadError).code),
      message: String((e as SharedThreadError).message),
    };
  }
  return { code: "unknown", message: e instanceof Error ? e.message : String(e) };
}

/**
 * What sharing `projectPath` would upload, and what it holds back as
 * secret-shaped. The dialog lists exactly these files. Only reads.
 */
export function previewShare(projectPath: string) {
  return invoke<ShareFile[]>("shared_thread_share_preview", { projectPath });
}

/**
 * Share the thread behind an ACP session. `include` names blocked files the
 * person chose to include anyway. Refused for a Local-mode project
 * (`workspace_local`).
 */
export function shareThread(args: {
  sessionId: string;
  projectPath: string;
  title: string;
  include: string[];
  /** Let teammates without the starting commit fetch the history from here. */
  serveHistory: boolean;
}) {
  return invoke<SharedThreadView>("shared_thread_share", args);
}

/**
 * Send (or stop sending) this repository's history to teammates who lack the
 * thread's starting commit. Never sent without the person's say-so.
 */
export function setServeHistory(sharedThreadId: string, on: boolean) {
  return invoke<void>("shared_thread_serve_history", { sharedThreadId, on });
}

/**
 * Join from a teammate's link. `projectPath` narrows which local project to
 * use; with none, or one without the thread's Base, the Base arrives as a
 * bundle — or the thread is followed read-only and `status.readOnly` says why.
 */
export function joinThread(link: string, projectPath?: string) {
  return invoke<SharedThreadView>("shared_thread_join", { link, projectPath: projectPath ?? null });
}

/** Check the replica out (first file open or prompt) and answer its path. */
export function openThread(sharedThreadId: string) {
  return invoke<string>("shared_thread_open", { sharedThreadId });
}

/**
 * The thread's Run worktree on this machine, holding canonical state now. An
 * agent session opened there runs every prompt as a Run in the thread.
 */
export function runWorktree(sharedThreadId: string) {
  return invoke<string>("shared_thread_run_worktree", { sharedThreadId });
}

export function listThreads() {
  return invoke<SharedThreadView[]>("shared_thread_list");
}

/** Stop syncing on this machine. The replica worktree stays on disk. */
export function leaveThread(sharedThreadId: string) {
  return invoke<void>("shared_thread_leave", { sharedThreadId });
}

/** The owner's view: participants, join requests, join policy, open or closed. */
export function ownerView(sharedThreadId: string) {
  return invoke<OwnerView>("shared_thread_owner_view", { sharedThreadId });
}

/** Approve a join request or promote (`participant`), or take edit rights away (`viewer`). */
export function setRole(sharedThreadId: string, userId: string, role: "participant" | "viewer") {
  return invoke<OwnerView>("shared_thread_set_role", { sharedThreadId, userId, role });
}

/** Decline a join request: they stay a viewer. */
export function declineJoin(sharedThreadId: string, userId: string) {
  return invoke<OwnerView>("shared_thread_decline", { sharedThreadId, userId });
}

/** Turn "approval required" on or off. */
export function setJoinPolicy(sharedThreadId: string, joinPolicy: "auto" | "approval") {
  return invoke<OwnerView>("shared_thread_set_join_policy", { sharedThreadId, joinPolicy });
}

/** Close the thread (read-only everywhere) or reopen it. */
export function setThreadOpen(sharedThreadId: string, open: boolean) {
  return invoke<OwnerView>("shared_thread_set_open", { sharedThreadId, open });
}

/** Resolve a Conflict on every replica; answers the Thread Version it recorded. */
export function resolveConflict(
  sharedThreadId: string,
  conflictId: number,
  side: Exclude<ConflictSide, "agent">,
  text?: string,
) {
  return invoke<number>("shared_thread_resolve_conflict", {
    sharedThreadId,
    conflictId,
    side,
    text: text ?? null,
  });
}

/**
 * Mark the thread's next Run as resolving `conflictId`, and get where to run
 * it and what to ask: the agent's rewrite of the hunk becomes the resolution.
 */
export function askAgentToResolve(sharedThreadId: string, conflictId: number) {
  return invoke<{ cwd: string; prompt: string }>("shared_thread_ask_agent_to_resolve", {
    sharedThreadId,
    conflictId,
  });
}

/**
 * "Continue from here" (ATL-411): the thread's next Run starts with its
 * context up to Run `runNo` — that Run's prompt, answer and files and
 * everything before — while its files still fork from canonical state now.
 * Answers the Run worktree to prompt in.
 */
export function continueFrom(sharedThreadId: string, runNo: number) {
  return invoke<string>("shared_thread_continue_from", { sharedThreadId, runNo });
}

/**
 * This Runner's Remote Run choices in one thread (ATL-417): accept them or
 * not, the agents this machine runs them with (a change reconnects the
 * thread), and whose requests to approve without asking.
 */
export function setRemoteSettings(
  sharedThreadId: string,
  settings: { accept?: boolean; agents?: string[]; autoApprove?: string | null },
) {
  return invoke<void>("shared_thread_remote_settings", {
    sharedThreadId,
    accept: settings.accept ?? null,
    agents: settings.agents ?? null,
    autoApprove: settings.autoApprove ?? null,
    clearAutoApprove: settings.autoApprove === null,
  });
}

/** Approve or decline a Remote Run this person was asked to run; answers where it stands. */
export function answerRemoteRun(sharedThreadId: string, requestId: string, approve: boolean) {
  return invoke<RemoteRunStatus>("shared_thread_answer_remote_run", {
    sharedThreadId,
    requestId,
    approve,
  });
}

/**
 * Execute an approved Remote Run in `sessionId`, an agent session opened in
 * the thread's Run worktree with the request's agent: answers the exact
 * prompt to send there, which starts the Run that executes it.
 */
export function executeRemoteRun(sharedThreadId: string, requestId: string, sessionId: string) {
  return invoke<string>("shared_thread_execute_remote_run", { sharedThreadId, requestId, sessionId });
}

/** Whom this person may ask for a Remote Run in this thread now. */
export function remoteRunners(sharedThreadId: string) {
  return invoke<RemoteRunners>("shared_thread_remote_runners", { sharedThreadId });
}

/** Ask `runner`'s desktop to run `prompt` with `agent`, on their machine and bill. */
export function requestRemoteRun(sharedThreadId: string, runner: string, agent: string, prompt: string) {
  return invoke<RemoteRun>("shared_thread_request_remote_run", {
    sharedThreadId,
    runner,
    agent,
    prompt,
  });
}

/** A Thread Version (ATL-415): a merge, a Conflict resolution, a Restore, or a mark. */
export interface ThreadVersion {
  version: number;
  kind: "merge" | "resolve" | "restore" | "mark" | (string & {});
  runId: string | null;
  conflictId: number | null;
  /** The Version a Restore set its files back to. */
  restoredFrom: number | null;
  authorId: string;
  at: number;
  files: Array<{ fileId: number; blob: string }>;
  mark: { label: string | null; by: string; at: number } | null;
}

/** One file's difference from the diff base (ATL-419). */
export interface FileDiff {
  fileId: number;
  path: string;
  change: "added" | "modified" | "deleted" | "binary" | "unavailable";
  /** A git-style unified diff section; empty for a binary or unavailable file. */
  diff: string;
  /** Restore to the chosen Version can set it back. */
  restorable: boolean;
}

/** The thread's Thread Versions, newest first. */
export function listVersions(sharedThreadId: string) {
  return invoke<ThreadVersion[]>("shared_thread_versions", { sharedThreadId });
}

/**
 * The thread's files against the Base (no `version`) or a Thread Version.
 * A Version made a moment ago is refused `version_pending` until captured.
 */
export function diffAgainst(sharedThreadId: string, version: number | null) {
  return invoke<FileDiff[]>("shared_thread_diff", { sharedThreadId, version });
}

/** Restore these files to Thread Version `version`: a new change everyone sees. */
export function restoreToVersion(sharedThreadId: string, version: number, fileIds: number[]) {
  return invoke<{ version: number | null; files: Array<{ fileId: number; version: number }> }>(
    "shared_thread_restore",
    { sharedThreadId, version, fileIds },
  );
}

/** Mark the thread as it is now as a Version. */
export function markVersion(sharedThreadId: string, label?: string) {
  return invoke<ThreadVersion>("shared_thread_mark_version", { sharedThreadId, label: label ?? null });
}

export function onVersionsChanged(apply: (event: { sharedThreadId: string }) => void): Promise<UnlistenFn> {
  return listen<{ sharedThreadId: string }>(SHARED_VERSIONS_EVENT, (event) => apply(event.payload));
}

/** Lines of a file, 1-based and inclusive. */
export interface LineSpan {
  start: number;
  end: number;
}

/**
 * A comment on lines of a thread's file (ATL-413, ATL-416), as the server
 * keeps it, and — for a root on lines — where those lines are in the text
 * now; `lines` is `null` when its text is gone: it is outdated, show `quote`.
 */
export interface LineComment {
  id: string;
  parentId: string | null;
  authorId: string;
  body: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  votes?: { up: string[]; down: string[] };
  threadRange: {
    threadId: string;
    fileId: number;
    path: string;
    start: string;
    end: string;
    quote: string;
  } | null;
  lines: LineSpan | null;
}

/** The thread's line comments, each root placed on its lines as this replica's text has them. */
export function listLineComments(sharedThreadId: string) {
  return invoke<LineComment[]>("shared_thread_comments", { sharedThreadId });
}

/** Comment on lines (1-based) of one of the thread's text files, by its id or its path in the thread. */
export function commentOnLines(
  sharedThreadId: string,
  file: { fileId: number } | { path: string },
  lines: LineSpan,
  body: string,
) {
  return invoke<unknown>("shared_thread_comment_lines", {
    sharedThreadId,
    fileId: "fileId" in file ? file.fileId : null,
    path: "path" in file ? file.path : null,
    start: lines.start,
    end: lines.end,
    body,
  });
}

export function replyToLineComment(sharedThreadId: string, parentId: string, body: string) {
  return invoke<unknown>("shared_thread_comment_reply", { sharedThreadId, parentId, body });
}

export function resolveLineComment(sharedThreadId: string, commentId: string, resolved: boolean) {
  return invoke<unknown>("shared_thread_comment_resolve", { sharedThreadId, commentId, resolved });
}

/** `1`, `-1`, or `0` to take a vote back. */
export function voteLineComment(sharedThreadId: string, commentId: string, value: 1 | -1 | 0) {
  return invoke<unknown>("shared_thread_comment_vote", { sharedThreadId, commentId, value });
}

/** What Apply did to the person's checkout (ATL-408). */
export interface Applied {
  /** Written, created or deleted cleanly. */
  files: string[];
  /** Left with conflict markers, or kept as the checkout had them. */
  conflicted: string[];
  /** For a binary conflict: where the thread's version was put beside yours. */
  beside: string[];
  /** The stash the person's own edits went into, when they asked for it. */
  stashed: string | null;
  /** Ignored files of theirs that were in the way, moved under `.git/atlas-set-aside/` (absolute paths). */
  setAside: string[];
}

/** Apply's answer: done, or refused with what to do about it. */
export type ApplyOutcome =
  | ({ outcome: "applied" } & Applied)
  | { outcome: "dirty"; files: string[] }
  | { outcome: "conflictsOpen"; count: number };

/**
 * Write the thread's changes since its Base into this person's checkout as
 * uncommitted changes. `stash` sets aside their own uncommitted edits to the
 * same files first. Never commits, pushes or closes the thread.
 */
export function applyThread(sharedThreadId: string, stash = false) {
  return invoke<ApplyOutcome>("shared_thread_apply", { sharedThreadId, stash });
}

/**
 * Bind the Atlas editor to `path` when it is a text file of a joined thread's
 * replica; `null` for any other file.
 */
export function openSharedDoc(path: string) {
  return invoke<SharedDoc | null>("shared_thread_doc_open", { path });
}

export function closeSharedDoc(sharedThreadId: string, fileId: number) {
  return invoke<void>("shared_thread_doc_close", { sharedThreadId, fileId });
}

/** Keystrokes, as one batched Yjs update (base64). Rejects `not_syncing`. */
export function sendDocUpdate(sharedThreadId: string, fileId: number, update: string) {
  return invoke<void>("shared_thread_doc_update", { sharedThreadId, fileId, update });
}

/** The person's selections in one file, `[anchor, head]`, and whether they type there. */
export function sendCursors(
  sharedThreadId: string,
  fileId: number,
  cursors: Array<[number, number]>,
  typing: boolean,
) {
  return invoke<void>("shared_thread_cursors", { sharedThreadId, fileId, cursors, typing });
}

/** `atlas:shared-thread-presence`: who is on one thread now. */
export interface SharedPresenceEvent {
  sharedThreadId: string;
  peers: SharedPeer[];
}

/** `atlas:shared-doc-update`: a change to a file bound to the editor, base64 Yjs. */
export interface SharedDocUpdateEvent {
  sharedThreadId: string;
  fileId: number;
  update: string;
}

export function onSharedPresence(apply: (event: SharedPresenceEvent) => void): Promise<UnlistenFn> {
  return listen<SharedPresenceEvent>(SHARED_PRESENCE_EVENT, (e) => apply(e.payload));
}

export function onSharedDocUpdate(apply: (event: SharedDocUpdateEvent) => void): Promise<UnlistenFn> {
  return listen<SharedDocUpdateEvent>(SHARED_DOC_UPDATE_EVENT, (e) => apply(e.payload));
}

export function onJoinRequested(
  apply: (request: { sharedThreadId: string; userId: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ sharedThreadId: string; userId: string }>(SHARED_JOIN_REQUEST_EVENT, (event) =>
    apply(event.payload),
  );
}

export function onRemoteRun(
  apply: (event: { sharedThreadId: string; request: RemoteRun }) => void,
): Promise<UnlistenFn> {
  return listen<{ sharedThreadId: string; request: RemoteRun }>(SHARED_REMOTE_RUN_EVENT, (event) =>
    apply(event.payload),
  );
}

export function onSharedRunFrame(apply: (frame: SharedRunFrame) => void): Promise<UnlistenFn> {
  return listen<SharedRunFrame>(SHARED_RUN_FRAME_EVENT, (event) => apply(event.payload));
}

export function onSharedThreadsChanged(
  apply: (threads: SharedThreadView[]) => void,
): Promise<UnlistenFn> {
  return listen<SharedThreadView[]>(SHARED_THREADS_EVENT, (event) => apply(event.payload));
}
