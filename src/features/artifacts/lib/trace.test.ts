import { describe, expect, it } from "vitest";

import type { OrgMember } from "@/features/auth/lib/auth-api";

import type { TraceCheckpointRow, TraceSessionRow } from "../types";
import type { AuthorDirectory } from "./author-directory";
import { buildTrace, foldTraceRows } from "./trace";
import { clampRange } from "./trace-api";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const WEEK = { from: iso(NOW - 7 * 24 * H), to: iso(NOW) };

function member(userId: string, name: string): OrgMember {
  return {
    id: `mem_${userId}`,
    userId,
    name,
    email: `${userId}@example.invalid`,
    role: "member",
    createdAt: null,
    avatarPath: null,
  } as OrgMember;
}

const DIRECTORY: AuthorDirectory = {
  byId: new Map(
    [member("usr_me", "Dev Halvorsen"), member("usr_ada", "Ada Lovelace")].map((m) => [
      m.userId,
      m,
    ]),
  ),
  currentUserId: "usr_me",
};

/** A server row: no `projectPath`. */
function session(over: Partial<TraceSessionRow> & { id: string }): TraceSessionRow {
  return {
    number: null,
    workspaceId: "ws_app",
    workspaceSlug: "app",
    authorId: "usr_ada",
    participants: ["usr_ada"],
    title: "Fix the thing",
    agent: "claude-code",
    source: "acp",
    startedAt: iso(NOW - 5 * H),
    lastActivityAt: iso(NOW - 3 * H),
    live: false,
    incomplete: false,
    checkpoints: [],
    checkpointsTruncated: false,
    ...over,
  };
}

function checkpoint(
  over: Partial<TraceCheckpointRow> & { sessionId: string; commitSha: string },
): TraceCheckpointRow {
  return {
    id: `cp_${over.commitSha}`,
    at: iso(NOW - 4 * H),
    authorId: "usr_ada",
    branch: "main",
    linkState: "linked",
    insertions: 3,
    deletions: 1,
    files: 1,
    ...over,
  };
}

const build = (rows: TraceSessionRow[], extra: Partial<Parameters<typeof buildTrace>[0]> = {}) =>
  buildTrace({
    rows,
    directory: DIRECTORY,
    range: WEEK,
    now: NOW,
    agentLabelOf: (a) => `agent:${a}`,
    ...extra,
  });

describe("foldTraceRows", () => {
  it("makes one row of a Session read from the server and from this disk", () => {
    const remote = session({
      id: "s1",
      authorId: "usr_me",
      participants: ["usr_me"],
      checkpoints: [checkpoint({ sessionId: "s1", commitSha: "aaa", authorId: "usr_me" })],
    });
    const local = session({
      id: "s1",
      authorId: null,
      participants: [],
      projectPath: "/p/app",
      live: true,
      checkpoints: [
        checkpoint({ sessionId: "s1", commitSha: "aaa", authorId: null, commitSubject: "fix: a" }),
        // Not drained yet: only this disk has it.
        checkpoint({ sessionId: "s1", commitSha: "bbb", authorId: null, commitSubject: "fix: b" }),
      ],
    });
    const [row, ...rest] = foldTraceRows([local, remote]);
    expect(rest).toHaveLength(0);
    expect(row.authorId).toBe("usr_me");
    expect(row.projectPath).toBe("/p/app");
    expect(row.live).toBe(true);
    expect(row.checkpoints.map((c) => [c.commitSha, c.commitSubject])).toEqual([
      ["aaa", "fix: a"],
      ["bbb", "fix: b"],
    ]);
  });
});

describe("buildTrace", () => {
  it("groups each Checkpoint under its own Session, oldest first", () => {
    const out = build([
      session({
        id: "s1",
        checkpoints: [
          checkpoint({ sessionId: "s1", commitSha: "bbb", at: iso(NOW - 3.5 * H) }),
          // A different ISO spelling of an earlier instant still sorts first.
          checkpoint({ sessionId: "s1", commitSha: "aaa", at: "2026-11-04T07:30:00+00:00" }),
        ],
      }),
      session({ id: "s2", checkpoints: [checkpoint({ sessionId: "s2", commitSha: "ccc" })] }),
    ]);
    const byId = new Map(out.map((s) => [s.id, s]));
    expect(byId.get("s1")!.checkpoints.map((c) => c.sha)).toEqual(["aaa", "bbb"]);
    expect(byId.get("s2")!.checkpoints.map((c) => c.sha)).toEqual(["ccc"]);
    // The Checkpoint points back at its Session, so opening it finds the row.
    expect(byId.get("s1")!.checkpoints[0].sessionId).toBe("s1");
  });

  it("maps the wire's Checkpoint fields onto the block's", () => {
    const [s] = build([
      session({
        id: "s1",
        checkpointsTruncated: true,
        checkpoints: [
          checkpoint({
            sessionId: "s1",
            commitSha: "abcdef1234",
            linkState: "orphaned",
            insertions: 9,
            deletions: 4,
            files: 2,
          }),
        ],
      }),
    ]);
    expect(s.checkpointsTruncated).toBe(true);
    expect(s.checkpoints[0]).toMatchObject({
      sha: "abcdef1234",
      linkState: "orphaned",
      additions: 9,
      deletions: 4,
      files: 2,
    });
    // No subject on the wire: the block falls back to the short sha.
    expect(s.checkpoints[0].title).toBeUndefined();
  });

  it("names everyone who drove the Session, the author first", () => {
    const [s] = build([
      session({
        id: "s1",
        authorId: "usr_ada",
        participants: ["usr_ada", "usr_me"],
        checkpoints: [
          checkpoint({ sessionId: "s1", commitSha: "a", authorId: "usr_ada" }),
          checkpoint({ sessionId: "s1", commitSha: "b", authorId: "usr_me" }),
        ],
      }),
    ]);
    expect(s.participants.map((p) => p.name)).toEqual(["Ada", "You"]);
    expect(s.checkpoints.map((c) => c.author.id)).toEqual(["usr_ada", "usr_me"]);
  });

  it("credits a row read from this disk to this account", () => {
    const [s] = build([
      session({
        id: "s1",
        authorId: null,
        participants: [],
        projectPath: "/p/app",
        workspaceId: "",
        checkpoints: [checkpoint({ sessionId: "s1", commitSha: "a", authorId: null })],
      }),
    ]);
    // "You" would make "YO": the face reads the account's own initials.
    expect(s.participants).toEqual([
      { id: "usr_me", name: "You", avatarUrl: null, initials: "DH" },
    ]);
    expect(s.checkpoints[0].author.id).toBe("usr_me");
    expect(s.projectId).toBe("/p/app");
    expect(s.projectName).toBe("app");
  });

  it("draws someone the roster cannot name as a member, keeping their id", () => {
    const [s] = build([
      session({
        id: "s1",
        authorId: "usr_gone",
        participants: ["usr_gone"],
        checkpoints: [checkpoint({ sessionId: "s1", commitSha: "a", authorId: "usr_gone" })],
      }),
    ]);
    // Not "AM", which reads as someone's initials.
    expect(s.participants).toEqual([
      { id: "usr_gone", name: "A member", avatarUrl: null, initials: "?" },
    ]);
    expect(s.checkpoints[0].author.name).toBe("A member");
  });

  it("leaves a live Session open-ended; a finished one ends at its last activity", () => {
    const out = build([
      session({ id: "live", live: true }),
      session({ id: "done", lastActivityAt: iso(NOW - 3 * H) }),
    ]);
    const byId = new Map(out.map((s) => [s.id, s]));
    expect(byId.get("live")).toMatchObject({ endedAt: null, status: "live" });
    expect(byId.get("done")).toMatchObject({ endedAt: iso(NOW - 3 * H), status: "settled" });
  });

  it("keeps only Sessions that overlap the window", () => {
    const range = { from: iso(NOW - 24 * H), to: iso(NOW - 2 * H) };
    const out = build(
      [
        session({ id: "old", startedAt: iso(NOW - 50 * H), lastActivityAt: iso(NOW - 30 * H) }),
        session({ id: "across", startedAt: iso(NOW - 30 * H), lastActivityAt: iso(NOW - 20 * H) }),
        session({ id: "new", startedAt: iso(NOW - 1 * H), lastActivityAt: iso(NOW - 0.5 * H) }),
        // Started before the window and still running: it is in it.
        session({
          id: "live",
          startedAt: iso(NOW - 40 * H),
          lastActivityAt: iso(NOW - 40 * H),
          live: true,
        }),
      ],
      { range },
    );
    expect(out.map((s) => s.id).sort()).toEqual(["across", "live"]);
  });

  it("narrows by the board's Agent and People pills", () => {
    const rows = [
      session({ id: "a", agent: "codex", authorId: "usr_ada" }),
      session({ id: "b", agent: "claude-code", authorId: "usr_ada" }),
      session({ id: "c", agent: "codex", authorId: null, projectPath: "/p/app" }),
      // Your own synced work, as the server stamps it.
      session({ id: "d", agent: "codex", authorId: "usr_me" }),
    ];
    expect(
      build(rows, { agent: "codex" })
        .map((s) => s.id)
        .sort(),
    ).toEqual(["a", "c", "d"]);
    expect(
      build(rows, { people: [null] })
        .map((s) => s.id)
        .sort(),
    ).toEqual(["c", "d"]);
    expect(build(rows, { people: ["usr_ada"] }).map((s) => s.id)).toHaveLength(2);
  });

  it("names a Project as the Organisation does, and labels the agent", () => {
    const [s] = build([session({ id: "s1", title: null })], {
      projectNames: new Map([["ws_app", "Atlas app"]]),
    });
    expect(s.projectName).toBe("Atlas app");
    expect(s.title).toBe("Untitled session");
    expect(s.agentLabel).toBe("agent:claude-code");
  });
});

describe("clampRange", () => {
  it("pulls a window wider than the server allows in to 92 days", () => {
    const to = iso(NOW);
    expect(clampRange({ from: iso(NOW - 200 * 24 * H), to })).toEqual({
      from: iso(NOW - 92 * 24 * H),
      to,
    });
    const week = { from: iso(NOW - 7 * 24 * H), to };
    expect(clampRange(week)).toBe(week);
  });
});
