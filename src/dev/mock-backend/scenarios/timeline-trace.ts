// The Timeline's Trace view over a week of a busy Organisation: about forty
// Sessions across three projects by six people, three of them still running,
// and Checkpoints that land in bursts the way real commits do — a quiet hour
// of reading, then five commits in ten minutes.
//
// Teammates' Checkpoints arrive with an `authorId`, as the server half of
// `artifacts_trace` will send them. One Session hands over mid-way, so its
// Checkpoints carry two faces; one belongs to someone who has since left the
// Organisation, so the chart has to draw a person the roster cannot name.
//
// Your own Sessions arrive twice, as `artifacts_trace` sends them: the
// server's row, and the row read from this disk, which alone carries the
// commit subjects. So your Checkpoints are titled on the chart and a
// teammate's show their short sha. Two teammates have photos; everyone else
// is an initial.
//
// Everything is generated from a fixed seed relative to "now", so the week is
// always the week you open it in and the picture is the same every reload.

import type {
  BoardPage,
  BoardSession,
  ProjectFilter,
  SessionDetail,
  TimelineEntry,
  TraceCheckpointRow,
  TracePage,
  TraceSessionRow,
} from "@/features/artifacts/types";
import type { OrgMember } from "@/features/auth/lib/auth-api";
import { streamDetail } from "../fixtures/artifacts";
import { seedAsset } from "../fixtures/files";
import { integrationsHandlers } from "../fixtures/integrations";
import {
  UZAYER_AVATAR_JPEG_BASE64,
  ZUHAYER_AVATAR_JPEG_BASE64,
} from "../fixtures/northwind-avatars";
import { ALL_PROJECTS } from "../project";
import type { Scenario } from "../types";

const HOUR = 3_600_000;
const MIN = 60_000;

/** Server ids for the three projects; `acme-app`'s matches the base fixture. */
const REMOTE_ID: Record<string, string> = {
  [ALL_PROJECTS[0].path]: "rw_1d55e903",
  [ALL_PROJECTS[1].path]: "rw_8c41f20b",
  [ALL_PROJECTS[2].path]: "rw_docs_5e10",
};

/** `null` is the signed-in account (a local row); the rest are roster ids from
 *  `fixtures/integrations.ts`, plus one who has left (`usr_gone`). */
const PEOPLE: (string | null)[] = [
  null,
  "usr_priya",
  "usr_mira",
  "usr_sam",
  "usr_tobi",
  "usr-unknown",
];

const AGENTS = ["claude-code", "codex", "atlas-agent", "opencode"];

const TITLES = [
  "Move invoice totals to integer cents",
  "Retry the billing webhook with backoff",
  "Split the PDF renderer out of the API worker",
  "Audit feature flags still reading v1 config",
  "Fix the flaky checkout e2e on Safari",
  "Stream the export instead of buffering it",
  "Add rate limits to the public share door",
  "Document the sync handshake",
  "Migrate the sessions table to the new schema",
  "Tidy the onboarding copy",
  "Cache the roster photos on disk",
  "Port the settings sheet to the new primitives",
  "Find why the search index drifts overnight",
  "Write the release notes for 0.4.1",
];

const SUBJECTS = [
  "Store invoice totals as integer cents",
  "Guard the batch writer against an empty batch",
  "Retry webhook delivery with jittered backoff",
  "Move the PDF renderer into its own worker",
  "Cover the retry path in the billing tests",
  "Drop the v1 config reader behind the flag",
  "Wait for the Safari checkout button to settle",
  "Stream export rows as they arrive",
  "Rate-limit the public share endpoint",
  "Fix an off-by-one in the page cursor",
  "Explain the sync handshake states",
  "Add a down migration for the sessions table",
  "Keep the search cursor across reloads",
  "Name the retry timeouts",
  "Cache roster photos in the app data dir",
  "Move the settings sheet onto the new Switch",
  "Rebuild the search index on schema change",
  "Bump the lockfile for the PDF fix",
];

/** Deterministic, so a screenshot is the same every reload. */
function rng(seed: number) {
  let x = seed >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

interface Plan {
  id: string;
  title: string;
  project: (typeof ALL_PROJECTS)[number];
  owner: string | null;
  agent: string;
  start: number;
  end: number;
  live: boolean;
  checkpoints: { at: number; author: string | null; subject: string; sha: string }[];
}

const SESSION_COUNT = 40;

/** The week, planned once per read so "now" stays now. */
function plan(now: number): Plan[] {
  const rand = rng(42);
  const out: Plan[] = [];
  for (let i = 0; i < SESSION_COUNT; i += 1) {
    const project = ALL_PROJECTS[Math.floor(rand() * ALL_PROJECTS.length)];
    // Weighted towards the signed-in account and two busy teammates — and one
    // Session by a colleague who has since left the Organisation.
    const picked = PEOPLE[Math.floor(rand() ** 1.4 * PEOPLE.length)];
    const owner = i === 11 ? "usr_gone" : picked;
    const live = i < 3;
    const length = (0.4 + rand() * 5) * HOUR;
    // Live ones started recently and run to now; the rest spread over 7 days,
    // in working hours-ish.
    const start = live ? now - length : now - (0.2 + rand() * 6.6) * 24 * HOUR;
    const end = live ? now : Math.min(start + length, now - 10 * MIN);
    const checkpoints: Plan["checkpoints"] = [];
    // One to three bursts, each three to six commits within ten minutes.
    // Every seventh Session is handed over: its last burst is someone else's,
    // so it always has at least two.
    const handover = i % 7 === 3 ? PEOPLE[(PEOPLE.indexOf(owner) + 1) % PEOPLE.length] : undefined;
    const bursts = Math.max(handover === undefined ? 1 : 2, 1 + Math.floor(rand() * 3));
    for (let b = 0; b < bursts; b += 1) {
      const burstAt = start + ((b + 0.5) / bursts) * (end - start);
      const n = 3 + Math.floor(rand() * 4);
      for (let k = 0; k < n; k += 1) {
        const at = Math.min(burstAt + k * (1 + rand() * 2) * MIN, end);
        checkpoints.push({
          at,
          author: handover !== undefined && b === bursts - 1 ? handover : owner,
          subject: SUBJECTS[Math.floor(rand() * SUBJECTS.length)],
          sha: Math.floor(rand() * 2 ** 32)
            .toString(16)
            .padStart(8, "0")
            .concat(String(i).padStart(4, "0")),
        });
      }
    }
    out.push({
      id: `ses_trace_${String(i).padStart(2, "0")}`,
      title: TITLES[i % TITLES.length],
      project,
      owner,
      agent: AGENTS[Math.floor(rand() * AGENTS.length)],
      start,
      end,
      live,
      checkpoints,
    });
  }
  return out;
}

const iso = (ms: number) => new Date(ms).toISOString();

function boardRow(p: Plan, now: number): BoardSession {
  const mine = p.owner === null;
  const remoteProjectId = REMOTE_ID[p.project.path];
  const ins = p.checkpoints.length * 37;
  const del = p.checkpoints.length * 11;
  return {
    id: p.id,
    title: p.title,
    agent: p.agent,
    model: p.agent === "codex" ? "gpt-5-codex" : "claude-opus-4",
    source: "acp",
    startedAt: iso(p.start),
    // Liveness is a 90-second window on `updatedAt`, so a live row is stamped
    // at read time.
    updatedAt: iso(p.live ? now : p.end),
    lastActivityAt: iso(p.end),
    activeSeconds: Math.round((p.end - p.start) / 3000),
    wallSeconds: Math.round((p.end - p.start) / 1000),
    messageCount: 20 + p.checkpoints.length * 6,
    toolCallCount: 10 + p.checkpoints.length * 4,
    checkpointCount: p.checkpoints.length,
    branches: [`feat/${p.id.slice(-2)}`],
    insertions: ins,
    deletions: del,
    filesTouched: p.checkpoints.length * 2,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    contextUsed: 120_000,
    contextSize: 200_000,
    needsAttention: false,
    attentionReason: null,
    // Your own work has a checkout here; a teammate's exists only on the server.
    projectPath: mine ? p.project.path : "",
    projectName: p.project.name,
    synced: true,
    origin: mine ? "both" : "remote",
    remoteProjectId,
    authorId: p.owner,
  };
}

function inScope(row: BoardSession, projects: unknown, filter: unknown): boolean {
  const scope = (filter ?? null) as ProjectFilter | null;
  if (!scope) {
    const paths = Array.isArray(projects) ? (projects as string[]) : [];
    return row.projectPath ? paths.includes(row.projectPath) : true;
  }
  if ("local" in scope) return row.remoteProjectId === REMOTE_ID[scope.local];
  return row.remoteProjectId === scope.remote;
}

function board({ projects, filter }: Record<string, unknown>): BoardPage {
  const now = Date.now();
  const sessions = plan(now)
    .map((p) => boardRow(p, now))
    .filter((row) => inScope(row, projects, filter))
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  return { sessions, cloudPending: false, cloudFailed: false };
}

/** The signed-in account's server id: the server stamps your own Sessions
 *  with it, where a row read from disk carries none. */
const ME = "usr_dev";

/** Sessions per page — small, so the fake walks `nextCursor` like the server. */
const TRACE_PAGE = 25;

/** Checkpoints the server sends per Session before it says `checkpointsTruncated`. */
const TRACE_CHECKPOINTS_MAX = 15;

/**
 * `GET /sessions/trace`, exactly as the server answers it (tryatlas/server
 * #43): the server half only. No commit subjects (the server has none), no
 * `projectPath` (a host-only field Rust adds to rows it read from disk).
 */
function trace({ projects, filter, from, to, cursor }: Record<string, unknown>): TracePage {
  const now = Date.now();
  const lo = Date.parse(String(from));
  const hi = Date.parse(String(to));
  const rows: TraceSessionRow[] = [];
  const local: TraceSessionRow[] = [];
  for (const p of plan(now)) {
    const board = boardRow(p, now);
    if (!inScope(board, projects, filter)) continue;
    if (p.start > hi || (!p.live && p.end < lo)) continue;
    const owner = p.owner ?? ME;
    const checkpoints: TraceCheckpointRow[] = p.checkpoints
      .filter((cp) => cp.at >= lo && cp.at <= hi)
      .map((cp, i) => ({
        id: `cp_${cp.sha}`,
        sessionId: p.id,
        at: iso(cp.at),
        authorId: cp.author ?? ME,
        commitSha: cp.sha,
        branch: board.branches[0],
        // One commit in every eleven was rewritten away after it landed.
        linkState: i % 11 === 10 ? "orphaned" : "linked",
        insertions: 37,
        deletions: 11,
        files: 2,
      }));
    rows.push({
      id: p.id,
      number: 100 + Number(p.id.slice(-2)),
      workspaceId: REMOTE_ID[p.project.path],
      workspaceSlug: p.project.name,
      authorId: owner,
      participants: [...new Set([owner, ...checkpoints.map((c) => c.authorId ?? ME)])],
      title: p.title,
      agent: p.agent,
      source: "acp",
      startedAt: iso(p.start),
      lastActivityAt: iso(p.end),
      live: p.live,
      incomplete: false,
      // The newest ones, as the server keeps them.
      checkpoints: checkpoints.slice(-TRACE_CHECKPOINTS_MAX),
      checkpointsTruncated: checkpoints.length > TRACE_CHECKPOINTS_MAX,
    });
    // This machine's half, on the first page only: your own Sessions read from
    // disk, every Checkpoint with the subject git reads here. A remote-only
    // scope has no checkout to read.
    const remoteScope = !!filter && "remote" in (filter as ProjectFilter);
    if (p.owner === null && !cursor && !remoteScope) {
      local.push({
        ...rows[rows.length - 1],
        number: null,
        authorId: null,
        participants: [],
        projectPath: p.project.path,
        checkpoints: checkpoints.map((cp) => ({
          ...cp,
          id: `local_${cp.commitSha}`,
          authorId: null,
          commitSubject: p.checkpoints.find((c) => c.sha === cp.commitSha)?.subject ?? null,
        })),
        checkpointsTruncated: false,
      });
    }
  }
  rows.sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
  const offset = cursor ? Number(cursor) : 0;
  const next = offset + TRACE_PAGE;
  return {
    from: String(from),
    to: String(to),
    sessions: [...rows.slice(offset, next), ...local],
    workspaces: ALL_PROJECTS.map((project, i) => ({
      id: REMOTE_ID[project.path],
      slug: project.name,
      name: project.name,
      number: i + 1,
    })),
    nextCursor: next < rows.length ? String(next) : null,
    notes: [],
  };
}

function entry(
  id: string,
  kind: TimelineEntry["kind"],
  at: number,
  extra: Partial<TimelineEntry> = {},
): TimelineEntry {
  return {
    id,
    kind,
    at: iso(at),
    turnSeq: 0,
    text: null,
    truncated: false,
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
    ...extra,
    bodyBytes: extra.text?.length ?? 0,
  };
}

/** Enough of a Session to open it and land on a Checkpoint: the ask, a reply
 *  before each burst, and every commit. */
function detail(sessionId: string): SessionDetail | null {
  const now = Date.now();
  const p = plan(now).find((x) => x.id === sessionId);
  if (!p) return null;
  const entries: TimelineEntry[] = [entry(`${p.id}:ask`, "prompt", p.start, { text: p.title })];
  p.checkpoints.forEach((cp, i) => {
    entries.push(
      entry(`${p.id}:r${i}`, "response", cp.at - 30_000, {
        text: `Committing: ${cp.subject}.`,
        turnSeq: i + 1,
      }),
      entry(`${p.id}:c${i}`, "checkpoint", cp.at, {
        turnSeq: i + 1,
        commitSha: cp.sha,
        commitSubject: cp.subject,
        branch: `feat/${p.id.slice(-2)}`,
        linkState: "linked",
        insertions: 37,
        deletions: 11,
        files: ["src/a.ts", "src/b.ts"],
      }),
    );
  });
  const checkpoints = p.checkpoints.length;
  return {
    summary: boardRow(p, now),
    entries,
    counts: { prompts: 1, responses: checkpoints, thinking: 0, toolCalls: 0, checkpoints },
    tools: [],
  };
}

/** Where Rust's avatar cache would hold the two teammates' photos. */
const PHOTO: Record<string, string> = {
  usr_sam: "/Users/dev/Library/Application Support/dev.atlas.ide/avatar-sam.jpg",
  usr_tobi: "/Users/dev/Library/Application Support/dev.atlas.ide/avatar-tobi.jpg",
};
seedAsset(PHOTO.usr_sam, "image/jpeg", ZUHAYER_AVATAR_JPEG_BASE64);
seedAsset(PHOTO.usr_tobi, "image/jpeg", UZAYER_AVATAR_JPEG_BASE64);

/** The base roster, with photos for the two teammates above. */
async function members(args: Record<string, unknown>): Promise<OrgMember[]> {
  const roster = await integrationsHandlers.auth_list_members(args);
  return roster.map((m) => {
    const photo = m.userId ? PHOTO[m.userId] : undefined;
    return photo ? { ...m, avatarPath: photo } : m;
  });
}

export const timelineTrace: Scenario = {
  name: "timeline-trace",
  description: `Timeline Trace: a week of ${SESSION_COUNT} Sessions, 6 people, 3 projects, live ones and Checkpoint bursts.`,
  commands: {
    auth_list_members: members,
    artifacts_board: board,
    artifacts_trace: trace,
    artifacts_session: ({ sessionId }) => detail(String(sessionId)),
    artifacts_cloud_session: ({ sessionId }) => {
      const d = detail(String(sessionId));
      if (!d) throw new Error("session not found");
      return d;
    },
    artifacts_cloud_session_stream: ({ sessionId, onChunk }) => {
      const d = detail(String(sessionId));
      if (!d) throw new Error("session not found");
      return streamDetail(d, onChunk);
    },
  },
  setup: async () => {
    const { useLayoutStore } = await import("@/features/layout/stores/layout-store");
    const { actions, tabs } = useLayoutStore.getState();
    actions.setTimelineView("trace");
    const existing = tabs.find((t) => t.type === "artifacts");
    if (existing) actions.setActiveTab(existing.id);
    else
      actions.addTab({
        id: "artifacts",
        type: "artifacts",
        title: "Timeline",
        closable: true,
        dirty: false,
        data: {},
      });
  },
};
