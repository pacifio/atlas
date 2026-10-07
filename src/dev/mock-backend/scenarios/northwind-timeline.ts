// The `northwind` scenario's Timeline: the board, each Session's detail, the
// Recent checkpoints picker, comments, and the live Session that keeps
// growing while a video records.
//
// Rows are folded out of the steps in `northwind-content.ts`, the same way
// `fixtures/artifacts.ts` folds its own: a row that says "6 tool calls" opens
// a detail that has six.

import { emit } from "@tauri-apps/api/event";
import type {
  BoardCheckpoint,
  BoardPage,
  BoardSession,
  EntryCounts,
  SessionDetail,
  SessionSummary,
  TimelineEntry,
  ToolTally,
} from "@/features/artifacts/types";
import type { Comment, CommentThreads } from "@/features/artifacts/lib/comments-api";
import type { MockResponses, TypedHandlers } from "../types";
import { artifactsHandlers } from "../fixtures/artifacts";
import type { CommentContent, PersonKey, Step } from "./northwind-content-types";
import {
  chatIdOf,
  commentTargetFor,
  toolArgsOf,
  toolCallOf,
  toolResultOf,
} from "./northwind-agent";
import {
  abs,
  addComment,
  advanceLive,
  AGENT_SOURCE,
  checkpointCommit,
  comments,
  iso,
  ME,
  nowWhen,
  patchComment,
  PEOPLE,
  presence,
  PROJECT,
  REMOTE_PROJECT_ID,
  rowId,
  session,
  sessions,
  stepMs,
  userIdOf,
  whenMs,
  type SessionState,
} from "./northwind-world";

// ── Entries ───────────────────────────────────────────────────────────────

function blank(
  id: string,
  kind: TimelineEntry["kind"],
  at: string,
  turnSeq: number,
): TimelineEntry {
  return {
    id,
    kind,
    at,
    turnSeq,
    text: null,
    truncated: false,
    bodyBytes: 0,
    bodyRef: null,
    toolName: null,
    toolTitle: null,
    toolStatus: null,
    paths: [],
    arguments: null,
    argumentsRef: null,
    result: null,
    resultRef: null,
    resultBinary: false,
    commitSha: null,
    commitSubject: null,
    branch: null,
    linkState: null,
    insertions: 0,
    deletions: 0,
    files: [],
  };
}

/** Lines added and removed by an edit, when the content does not say. */
export function lineStats(step: Extract<Step, { kind: "tool" }>): {
  insertions: number;
  deletions: number;
} {
  if (step.insertions !== undefined || step.deletions !== undefined) {
    return { insertions: step.insertions ?? 0, deletions: step.deletions ?? 0 };
  }
  if (!step.diff) return { insertions: 0, deletions: 0 };
  const before = step.diff.before?.split("\n") ?? [];
  const after = step.diff.after.split("\n");
  const kept = new Set(before);
  const insertions = after.filter((l) => !kept.has(l)).length;
  const added = new Set(after);
  return { insertions, deletions: before.filter((l) => !added.has(l)).length };
}

function entriesOf(s: SessionState): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  let turn = 0;
  for (const step of s.steps) {
    if (step.kind === "prompt") turn += 1;
    const id = rowId(s.content.id, step.id);
    const at = iso(stepMs(s, step));
    const seq = Math.max(1, turn);
    switch (step.kind) {
      case "prompt":
      case "thinking":
      case "response": {
        const e = blank(id, step.kind, at, seq);
        e.text = step.text;
        e.bodyBytes = step.text.length;
        out.push(e);
        break;
      }
      case "tool": {
        const e = blank(id, "tool_call", at, seq);
        const call = toolCallOf(chatIdOf(s.content.id, step.id), s.content.agent, step);
        const stats = step.tool === "edit" || step.tool === "write" ? lineStats(step) : null;
        e.toolName = call.tool_name;
        e.toolTitle = step.title;
        e.toolStatus = step.status ?? "completed";
        e.paths = step.path ? [abs(step.path)] : [];
        e.arguments = JSON.stringify(toolArgsOf(step), null, 2);
        e.result = toolResultOf(step);
        e.insertions = stats?.insertions ?? 0;
        e.deletions = stats?.deletions ?? 0;
        e.files = stats && step.path ? [step.path] : [];
        out.push(e);
        break;
      }
      case "checkpoint": {
        const commit = checkpointCommit(s.content.id, step.commit);
        // A commit made on camera does not exist until it is made.
        if (!commit) break;
        const e = blank(id, "checkpoint", iso(Math.max(stepMs(s, step), whenMs(commit.when))), seq);
        e.commitSha = commit.sha;
        e.commitSubject = commit.subject;
        e.branch = "main";
        e.linkState = "linked";
        e.insertions = commit.files.reduce((n, f) => n + f.insertions, 0);
        e.deletions = commit.files.reduce((n, f) => n + f.deletions, 0);
        e.files = commit.files.map((f) => f.path);
        out.push(e);
        break;
      }
    }
  }
  return out;
}

function countsOf(entries: TimelineEntry[]): EntryCounts {
  const n = (kind: TimelineEntry["kind"]) => entries.filter((e) => e.kind === kind).length;
  return {
    prompts: n("prompt"),
    responses: n("response"),
    thinking: n("thinking"),
    toolCalls: n("tool_call"),
    checkpoints: n("checkpoint"),
  };
}

function toolsOf(entries: TimelineEntry[]): ToolTally[] {
  const tally = new Map<string, number>();
  for (const e of entries) {
    if (e.kind === "tool_call")
      tally.set(e.toolName ?? "Other", (tally.get(e.toolName ?? "Other") ?? 0) + 1);
  }
  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([toolName, count]) => ({ toolName, count }));
}

function summaryOf(s: SessionState): SessionSummary {
  const entries = entriesOf(s);
  const counts = countsOf(entries);
  const c = s.content;
  // A live Session was written to just now; the board's dot is a 90 s window.
  const last = s.live ? Date.now() : s.lastMs;
  const wall = Math.max(60, Math.round((last - s.startMs) / 1000));
  return {
    id: c.id,
    title: c.title,
    agent: c.agent,
    model: c.model,
    source: c.imported ? "external_jsonl" : AGENT_SOURCE[c.agent],
    startedAt: iso(s.startMs),
    updatedAt: iso(last),
    lastActivityAt: iso(last),
    activeSeconds: Math.round(wall * 0.7),
    wallSeconds: wall,
    messageCount: counts.prompts + counts.responses,
    toolCallCount: counts.toolCalls,
    checkpointCount: counts.checkpoints,
    branches: [c.branch],
    insertions: entries.reduce((n, e) => n + (e.kind === "tool_call" ? e.insertions : 0), 0),
    deletions: entries.reduce((n, e) => n + (e.kind === "tool_call" ? e.deletions : 0), 0),
    filesTouched: new Set(entries.flatMap((e) => (e.kind === "tool_call" ? e.files : []))).size,
    totalTokens: c.tokens.input + c.tokens.output,
    inputTokens: c.tokens.input,
    outputTokens: c.tokens.output,
    cacheCreationTokens: c.tokens.cacheWrite,
    cacheReadTokens: c.tokens.cacheRead,
    contextUsed: null,
    contextSize: null,
    needsAttention: false,
    attentionReason: null,
  };
}

function detailOf(s: SessionState): SessionDetail {
  const entries = entriesOf(s);
  return { summary: summaryOf(s), entries, counts: countsOf(entries), tools: toolsOf(entries) };
}

/** Your own Sessions were captured on this machine; everyone else's are the server's. */
const mine = (s: SessionState) => s.content.author === ME.key;

function boardRow(s: SessionState): BoardSession {
  return {
    ...summaryOf(s),
    projectPath: PROJECT.path,
    projectName: PROJECT.name,
    synced: true,
    origin: mine(s) ? "both" : "remote",
    remoteProjectId: REMOTE_PROJECT_ID,
    authorId: mine(s) ? null : userIdOf(s.content.author),
  };
}

function checkpointsOf(): BoardCheckpoint[] {
  const out: BoardCheckpoint[] = [];
  for (const s of sessions()) {
    for (const e of entriesOf(s)) {
      if (e.kind !== "checkpoint" || !e.commitSha) continue;
      out.push({
        sessionId: s.content.id,
        sessionTitle: s.content.title,
        commitSha: e.commitSha,
        commitSubject: e.commitSubject,
        branch: e.branch,
        linkState: "linked",
        insertions: e.insertions,
        deletions: e.deletions,
        files: e.files.length,
        at: e.at,
        projectPath: PROJECT.path,
        projectName: PROJECT.name,
      });
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

// ── Comments ──────────────────────────────────────────────────────────────

function wireComment(c: CommentContent & { deleted?: boolean }): Comment {
  const anchorId = c.anchor.kind === "session" ? c.session : rowId(c.session, c.anchor.step ?? "");
  return {
    id: c.id,
    sessionId: c.session,
    anchorKind:
      c.anchor.kind === "session"
        ? "session"
        : c.anchor.kind === "tool_call"
          ? "tool_call"
          : "message",
    anchorId,
    parentId: c.parent ?? null,
    authorId: userIdOf(c.author),
    guestName: null,
    body: c.deleted ? null : c.body,
    mentions: c.deleted ? [] : [...c.body.matchAll(/<@([^>]+)>/g)].map((m) => m[1]),
    createdAt: iso(whenMs(c.when)),
    editedAt: null,
    deletedAt: c.deleted ? iso(Date.now()) : null,
    resolvedAt: c.resolved ? iso(whenMs(c.resolved.when)) : null,
    resolvedBy: c.resolved ? userIdOf(c.resolved.by) : null,
  };
}

function threadsFor(sessionId: string): CommentThreads {
  const byAnchor: Record<string, Comment[]> = {};
  const top: Comment[] = [];
  for (const c of comments()) {
    if (c.session !== sessionId) continue;
    const wire = wireComment(c);
    if (wire.anchorKind === "session") top.push(wire);
    else (byAnchor[wire.anchorId] ??= []).push(wire);
  }
  return { byAnchor, session: top };
}

function findComment(id: string) {
  return comments().find((c) => c.id === id);
}

/** Tell every open surface about a comment, the way the realtime socket does. */
function announce(c: CommentContent & { deleted?: boolean }): Comment {
  const wire = wireComment(c);
  void emit("atlas:artifacts-cloud", {
    kind: "commentUpsert",
    sessionId: c.session,
    comment: wire,
  });
  return wire;
}

let commentSeq = 0;

/** A comment from someone else arrives (a cue). */
export function commentAs(
  author: PersonKey,
  sessionId: string,
  step: string,
  body: string,
  parent?: string,
): void {
  const target = session(sessionId)?.steps.find((s) => s.id === step);
  const kind: CommentContent["anchor"]["kind"] =
    target?.kind === "prompt"
      ? "prompt"
      : target?.kind === "tool" || !target
        ? "tool_call"
        : "response";
  const comment: CommentContent = {
    id: `cm-live-${++commentSeq}`,
    session: sessionId,
    anchor: { kind, step },
    author,
    body,
    when: nowWhen(),
    ...(parent ? { parent } : {}),
  };
  addComment(comment);
  announce(comment);
}

// ── The live Session ──────────────────────────────────────────────────────

let liveTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Stream the live Session's remaining steps, one every few seconds, and tell
 * the board each time (`atlas:capture-changed`, as the capture worker does).
 * The Session keeps its pulsing dot until the last step lands.
 */
export function streamLiveSession(everyMs = 9_000): void {
  const live = sessions().find((s) => s.live);
  if (!live || liveTimer) return;
  const id = live.content.id;
  const tick = () => {
    const next = advanceLive(id);
    void emit("atlas:capture-changed", {});
    if (!next && liveTimer) {
      clearInterval(liveTimer);
      liveTimer = null;
    }
  };
  tick();
  liveTimer = setInterval(tick, everyMs);
}

/**
 * Keep the live Session live while nothing streams: its `updatedAt` is stamped
 * at read time, but the board only re-reads on an event, so nudge it inside
 * the 90-second window.
 */
export function keepLiveFresh(): void {
  setInterval(() => {
    if (sessions().some((s) => s.live)) void emit("atlas:capture-changed", {});
  }, 45_000);
}

/** The Timeline header's "online" faces: the Project socket's roster. */
export function announcePresence(): void {
  void emit("atlas:artifacts-cloud", {
    kind: "presence",
    projectId: REMOTE_PROJECT_ID,
    online: [...presence.online].map((p) => PEOPLE[p].userId),
  });
}

// ── Handlers ──────────────────────────────────────────────────────────────

export const northwindTimelineCommands: Partial<TypedHandlers<MockResponses>> = {
  artifacts_board: ({ projects }): BoardPage => {
    const paths = Array.isArray(projects) ? (projects as string[]) : [];
    if (!paths.includes(PROJECT.path))
      return artifactsHandlers.artifacts_board({ projects }) as BoardPage;
    return { sessions: sessions().map(boardRow), cloudPending: false, cloudFailed: false };
  },
  // Only your own Sessions are on this disk; a teammate's is read from the server.
  artifacts_session: ({ projectPath, sessionId }): SessionDetail | null => {
    if (projectPath !== PROJECT.path) return null;
    const s = session(String(sessionId));
    return s && mine(s) ? detailOf(s) : null;
  },
  artifacts_cloud_session: ({ sessionId }): SessionDetail => {
    const s = session(String(sessionId));
    if (!s) throw new Error("session not found");
    return detailOf(s);
  },
  artifacts_cloud_session_url: ({ sessionId }): string =>
    `https://app.tryatlas.cc/timeline?workspace=${REMOTE_PROJECT_ID}&session=${String(sessionId)}`,
  artifacts_checkpoints: ({ projects }): BoardCheckpoint[] => {
    const paths = Array.isArray(projects) ? (projects as string[]) : [];
    return paths.includes(PROJECT.path) ? checkpointsOf() : [];
  },
  artifacts_cloud_retarget: (): null => {
    setTimeout(announcePresence, 300);
    return null;
  },
  chat_comment_target: ({ nativeSessionId }) => commentTargetFor(String(nativeSessionId)),

  artifacts_cloud_comments: ({ sessionId }): CommentThreads => threadsFor(String(sessionId)),
  artifacts_cloud_comment_create: ({
    sessionId,
    anchorKind,
    anchorId,
    parentId,
    body,
  }): Comment => {
    const sid = String(sessionId);
    const step = String(anchorId).startsWith(`${sid}:`)
      ? String(anchorId).slice(sid.length + 1)
      : undefined;
    const comment: CommentContent = {
      id: `cm-mine-${++commentSeq}`,
      session: sid,
      anchor: {
        kind:
          anchorKind === "session"
            ? "session"
            : anchorKind === "tool_call"
              ? "tool_call"
              : "prompt",
        ...(step ? { step } : {}),
      },
      author: ME.key,
      body: String(body),
      when: nowWhen(),
      ...(parentId ? { parent: String(parentId) } : {}),
    };
    addComment(comment);
    return wireComment(comment);
  },
  artifacts_cloud_comment_update: ({ commentId, body, resolved }): Comment => {
    const id = String(commentId);
    if (body != null) patchComment(id, { body: String(body) });
    if (resolved != null) {
      patchComment(id, { resolved: resolved ? { by: ME.key, when: nowWhen() } : undefined });
    }
    const c = findComment(id);
    if (!c) throw new Error("not found");
    return announce(c);
  },
  artifacts_cloud_comment_delete: ({ commentId }): Comment => {
    const id = String(commentId);
    patchComment(id, { deleted: true });
    const c = findComment(id);
    if (!c) throw new Error("not found");
    return announce(c);
  },
};
