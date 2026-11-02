// The Timeline at a size that hurts: four hundred board rows and, behind the
// first shared one, a Session of well over a thousand entries with a comment
// thread every few rows. The default fixture's Sessions are a few dozen
// entries — small enough that opening one, the Ask split and a comment jump
// all look instant there whatever they cost per row.
//
// Built by repeating the default fixture's own rows rather than inventing new
// ones, so every kind the reader draws (prompt, response, thinking, a run of
// tool calls, Checkpoint) appears at its real proportions.

import type {
  BoardPage,
  BoardSession,
  SessionDetail,
  TimelineEntry,
} from "@/features/artifacts/types";
import type { Comment, CommentThreads } from "@/features/artifacts/lib/comments-api";
import { anchorKindFor } from "@/features/artifacts/lib/comments-api";
import { artifactsHandlers, mockComment, streamDetail } from "../fixtures/artifacts";
import type { Scenario } from "../types";

/** How many times the base Session's rows repeat. */
const COPIES = 40;
/** Board rows, the shape a busy Organisation's board actually has. */
const BOARD_ROWS = 400;
/** One thread per this many entries. */
const THREAD_EVERY = 9;

/** A clone's id → the fixture row it was copied from. */
const cloneOf = new Map<string, BoardSession>();
let stressId: string | null = null;
const comments = new Map<string, Comment[]>();

function board(args: Record<string, unknown>): BoardPage {
  const page = artifactsHandlers.artifacts_board(args) as BoardPage;
  const base = page.sessions;
  if (base.length === 0) return page;
  // The first shared row is the one blown up: shared, so it has comments.
  const target = base.find((row) => row.remoteProjectId) ?? base[0];
  stressId = target.id;
  const rows: BoardSession[] = [...base];
  for (let i = 0; rows.length < BOARD_ROWS; i += 1) {
    const from = base[i % base.length];
    const id = `${from.id}-x${i}`;
    cloneOf.set(id, from);
    const back = new Date(Date.parse(from.lastActivityAt) - (i + 1) * 3_600_000).toISOString();
    rows.push({ ...from, id, title: `${from.title ?? "Session"} (#${i})`, lastActivityAt: back });
  }
  return { ...page, sessions: rows };
}

function inflate(detail: SessionDetail): SessionDetail {
  if (detail.summary.id !== stressId) return detail;
  const entries: TimelineEntry[] = [];
  for (let copy = 0; copy < COPIES; copy += 1) {
    for (const e of detail.entries) {
      entries.push({
        ...e,
        id: copy === 0 ? e.id : `${e.id}~${copy}`,
        turnSeq: e.turnSeq + copy * 1000,
      });
    }
  }
  return { ...detail, entries };
}

function threadsFor(sessionId: string, detail: SessionDetail | null): CommentThreads {
  if (sessionId !== stressId || !detail) {
    return artifactsHandlers.artifacts_cloud_comments({ sessionId }) as CommentThreads;
  }
  if (!comments.has(sessionId)) {
    const rows: Comment[] = [];
    detail.entries.forEach((e, i) => {
      if (i % THREAD_EVERY !== 0) return;
      rows.push(
        mockComment({
          id: `cm-long-${i}`,
          sessionId,
          anchorKind: anchorKindFor(e.kind),
          anchorId: e.id,
          body: `Remark ${i / THREAD_EVERY + 1} on this ${e.kind.replace("_", " ")} — worth a second look before merge.`,
        }),
      );
    });
    comments.set(sessionId, rows);
  }
  const byAnchor: Record<string, Comment[]> = {};
  for (const row of comments.get(sessionId) ?? []) (byAnchor[row.anchorId] ??= []).push(row);
  return { byAnchor, session: [] };
}

function detailFor(args: Record<string, unknown>, cloud: boolean): SessionDetail | null {
  const id = String(args.sessionId);
  const from = cloneOf.get(id);
  const real = { ...args, sessionId: from?.id ?? id };
  const base = (
    cloud
      ? artifactsHandlers.artifacts_cloud_session(real)
      : artifactsHandlers.artifacts_session(real)
  ) as SessionDetail | null;
  if (!base) return null;
  if (from) return { ...base, summary: { ...base.summary, id } };
  return inflate(base);
}

export const timelineLong: Scenario = {
  name: "timeline-long",
  description: `Timeline stress: ${BOARD_ROWS} board rows, and a shared Session ×${COPIES} with a thread every ${THREAD_EVERY} rows.`,
  commands: {
    artifacts_board: board,
    artifacts_session: (args) => detailFor(args, false),
    artifacts_cloud_session: (args) => detailFor(args, true) as SessionDetail,
    // Pages ~1s apart, as the server answers a long Session.
    artifacts_cloud_session_stream: (args) =>
      streamDetail(detailFor(args, true) as SessionDetail, args.onChunk, { delayMs: 900 }),
    artifacts_cloud_comments: (args) => {
      const id = String(args.sessionId);
      const detail = id === stressId ? detailFor({ ...args, projectPath: "" }, true) : null;
      return threadsFor(id, detail);
    },
  },
  setup: async () => {
    const { useLayoutStore } = await import("@/features/layout/stores/layout-store");
    const { actions, tabs } = useLayoutStore.getState();
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
