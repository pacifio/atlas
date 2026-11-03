import { describe, expect, it } from "vitest";
import type { ThreadProject, ThreadRow } from "@/features/chat/lib/history-api";
import {
  matchProject,
  nextAfterParking,
  nextSnoozeWake,
  partitionSidebarSessions,
  resolveScopeProjectId,
  searchSidebarSessions,
  type SidebarProject,
} from "./sidebar-sessions";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const iso = (offsetMinutes: number) => new Date(NOW + offsetMinutes * 60_000).toISOString();

const PROJECTS: SidebarProject[] = [
  { id: "p-app", name: "app", path: "/work/app" },
  { id: "p-nested", name: "nested", path: "/work/app/packages/nested/" },
  { id: "p-docs", name: "docs", path: "/work/docs" },
];

function row(threadId: string, patch: Partial<ThreadRow> = {}): ThreadRow {
  return {
    threadId,
    sessionId: `s-${threadId}`,
    agentId: "atlas-agent",
    title: threadId,
    updatedAt: iso(-60),
    createdAt: iso(-120),
    settledAt: null,
    pinnedAt: null,
    pinOrder: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastSnoozeWakeAt: null,
    lastViewedAt: null,
    lastTurnCompletedAt: null,
    unread: false,
    woke: false,
    projectName: "app",
    folderPaths: ["/work/app"],
    liveElsewhere: false,
    heldWorking: false,
    branch: null,
    model: null,
    ...patch,
  } as ThreadRow;
}

function group(paths: string[], threads: ThreadRow[]): ThreadProject {
  return { name: paths[0]!, paths, isCurrent: false, threads };
}

const partition = (
  groups: ThreadProject[],
  extra: { scopeProjectId?: string | null; sort?: "recent" | "created" } = {},
) =>
  partitionSidebarSessions({
    groups,
    projects: PROJECTS,
    scopeProjectId: extra.scopeProjectId ?? null,
    now: NOW,
    sort: extra.sort,
  });

describe("matchProject", () => {
  it("picks the longest project root holding a path, ignoring trailing slashes", () => {
    expect(matchProject(["/work/app/src"], PROJECTS)?.id).toBe("p-app");
    expect(matchProject(["/work/app/packages/nested"], PROJECTS)?.id).toBe("p-nested");
    expect(matchProject(["/work/app/packages/nested/x/"], PROJECTS)?.id).toBe("p-nested");
  });

  it("does not match a sibling that only shares a prefix", () => {
    expect(matchProject(["/work/application"], PROJECTS)).toBeNull();
  });
});

describe("partitionSidebarSessions", () => {
  it("sorts pinned by key, active by recency, settled by settle time, and shelves snoozed soonest-first", () => {
    const groups = [
      group(
        ["/work/app"],
        [
          row("old", { updatedAt: iso(-500) }),
          row("new", { updatedAt: iso(-5) }),
          row("pin-b", { pinnedAt: iso(-10), pinOrder: "a1" }),
          row("pin-a", { pinnedAt: iso(-20), pinOrder: "a0" }),
          row("settled-1", { settledAt: iso(-300) }),
          row("settled-2", { settledAt: iso(-30) }),
          row("snoozed", { snoozedUntil: iso(30) }),
          row("snoozed-soon", { snoozedUntil: iso(5), pinnedAt: iso(-40) }),
          row("snooze-over", { snoozedUntil: iso(-1), updatedAt: iso(-50) }),
          row("draft", { sessionId: null }),
        ],
      ),
    ];
    const result = partition(groups);
    expect(result.pinned.map((s) => s.threadId)).toEqual(["pin-a", "pin-b"]);
    expect(result.active.map((s) => s.threadId)).toEqual(["new", "snooze-over", "old"]);
    expect(result.settled.map((s) => s.threadId)).toEqual(["settled-2", "settled-1"]);
    // A snooze outranks a pin: the session waits on the shelf until it wakes.
    expect(result.snoozed.map((s) => s.threadId)).toEqual(["snoozed-soon", "snoozed"]);
    expect(result.snoozed[0]!.snoozedUntil).toBe(iso(5));
    expect(result.active.find((s) => s.threadId === "snooze-over")!.snoozedUntil).toBeNull();
  });

  it("leaves out groups outside the organisation and honours the project scope", () => {
    const groups = [
      group(["/work/app"], [row("a")]),
      group(["/work/docs"], [row("d", { projectName: "docs", folderPaths: ["/work/docs"] })]),
      group(["/elsewhere"], [row("x", { folderPaths: ["/elsewhere"] })]),
    ];
    expect(partition(groups).active.map((s) => s.threadId)).toEqual(["a", "d"]);
    expect(partition(groups, { scopeProjectId: "p-docs" }).active.map((s) => s.threadId)).toEqual([
      "d",
    ]);
  });

  it("orders active sessions by start time when the setting asks", () => {
    const groups = [
      group(
        ["/work/app"],
        [
          row("busy-old", { createdAt: iso(-900), updatedAt: iso(-1) }),
          row("quiet-new", { createdAt: iso(-100), updatedAt: iso(-90) }),
        ],
      ),
    ];
    expect(partition(groups).active.map((s) => s.threadId)).toEqual(["busy-old", "quiet-new"]);
    expect(partition(groups, { sort: "created" }).active.map((s) => s.threadId)).toEqual([
      "quiet-new",
      "busy-old",
    ]);
  });
});

describe("nextSnoozeWake", () => {
  it("returns the soonest snooze still running", () => {
    const groups = [
      group(
        ["/work/app"],
        [
          row("a", { snoozedUntil: iso(90) }),
          row("b", { snoozedUntil: iso(10) }),
          row("c", { snoozedUntil: iso(-10) }),
        ],
      ),
    ];
    expect(nextSnoozeWake(groups, NOW)).toBe(Date.parse(iso(10)));
    expect(nextSnoozeWake([group(["/work/app"], [row("z")])], NOW)).toBeNull();
  });
});

describe("searchSidebarSessions", () => {
  const sessions = partition([
    group(
      ["/work/app"],
      [
        row("1", { title: "Fix checkout rounding", updatedAt: iso(-3) }),
        row("2", { title: "Refactor ledger", branch: "fix/checkout", updatedAt: iso(-2) }),
        row("3", { title: "Unrelated", updatedAt: iso(-1) }),
      ],
    ),
  ]).active;

  it("puts title matches before project and branch matches", () => {
    expect(searchSidebarSessions(sessions, "checkout").map((s) => s.threadId)).toEqual(["1", "2"]);
  });

  it("needs every word, and finds nothing for a blank query", () => {
    expect(searchSidebarSessions(sessions, "fix rounding").map((s) => s.threadId)).toEqual(["1"]);
    expect(searchSidebarSessions(sessions, "   ")).toEqual([]);
  });
});

describe("resolveScopeProjectId", () => {
  it("drops a remembered scope whose project is gone", () => {
    expect(resolveScopeProjectId("p-docs", PROJECTS)).toBe("p-docs");
    expect(resolveScopeProjectId("p-gone", PROJECTS)).toBeNull();
    expect(resolveScopeProjectId(null, PROJECTS)).toBeNull();
  });
});

describe("nextAfterParking", () => {
  const rows = [{ threadId: "a" }, { threadId: "b" }, { threadId: "c" }];
  it("prefers the row below, then the row above", () => {
    expect(nextAfterParking(rows, "b")?.threadId).toBe("c");
    expect(nextAfterParking(rows, "c")?.threadId).toBe("b");
    expect(nextAfterParking([{ threadId: "a" }], "a")).toBeNull();
  });
});

describe("attached projects", () => {
  const docs = {
    path: "/work/docs",
    displayName: "docs",
    access: "read_write" as const,
    attachedAt: iso(-30),
    source: "mention" as const,
  };
  const groups = [
    group(["/work/app"], [row("a", { attachedProjects: [docs] }), row("b")]),
    group(["/work/docs"], [row("c", { projectName: "docs", folderPaths: ["/work/docs"] })]),
  ];

  it("carries the attached names on the row, and an empty list otherwise", () => {
    const { active } = partition(groups);
    const a = active.find((s) => s.threadId === "a")!;
    const b = active.find((s) => s.threadId === "b")!;
    expect(a.attachedNames).toBe("docs");
    expect(a.attachedProjects).toHaveLength(1);
    expect(b.attachedProjects).toHaveLength(0);
    expect(b.attachedNames).toBe("");
  });

  it("scoped to a project, also lists the sessions it is attached to, marked", () => {
    const { active } = partition(groups, { scopeProjectId: "p-docs" });
    expect(active.map((s) => [s.threadId, s.viaAttached]).sort()).toEqual([
      ["a", true],
      ["c", false],
    ]);
  });

  it("finds a session by an attached project's name", () => {
    const { active } = partition(groups);
    expect(searchSidebarSessions(active, "docs").map((s) => s.threadId)).toContain("a");
  });
});

describe("Windows paths", () => {
  const WIN: SidebarProject[] = [
    { id: "w-app", name: "app", path: "C:\\work\\app" },
    { id: "w-docs", name: "docs", path: "C:\\work\\docs\\" },
  ];

  it("matches a project whichever separators and case its paths use", () => {
    expect(matchProject(["C:\\work\\app\\src"], WIN)?.id).toBe("w-app");
    expect(matchProject(["c:/Work/App"], WIN)?.id).toBe("w-app");
    expect(matchProject(["C:\\work\\application"], WIN)).toBeNull();
  });

  it("scoped to a project, finds sessions it is attached to by a backslashed path", () => {
    const attached = {
      path: "C:\\work\\docs\\guide",
      displayName: "docs",
      access: "read_only" as const,
      attachedAt: iso(-30),
      source: "mention" as const,
    };
    const { active } = partitionSidebarSessions({
      groups: [
        group(
          ["C:\\work\\app"],
          [row("a", { attachedProjects: [attached], folderPaths: ["C:\\work\\app"] })],
        ),
      ],
      projects: WIN,
      scopeProjectId: "w-docs",
      now: NOW,
    });
    expect(active.map((s) => [s.threadId, s.viaAttached])).toEqual([["a", true]]);
  });
});

describe("session identity across refetches", () => {
  it("hands back the same session for a row React Query kept, and a new one for a changed row", () => {
    const kept = row("a");
    const before = row("b");
    const first = partition([group(["/work/app"], [kept, before])]);
    // A refetch: structural sharing keeps `kept` and replaces the changed row.
    const after = { ...before, unread: true };
    const second = partition([group(["/work/app"], [kept, after])]);

    const find = (p: typeof first, id: string) => p.active.find((s) => s.threadId === id)!;
    expect(find(second, "a")).toBe(find(first, "a"));
    expect(find(second, "b")).not.toBe(find(first, "b"));
    expect(find(second, "b").unread).toBe(true);
  });

  it("rebuilds a kept row's session when what it was built from besides the row changes", () => {
    const kept = row("a", { snoozedUntil: iso(30) });
    const asleep = partition([group(["/work/app"], [kept])]).snoozed[0]!;
    const awake = partitionSidebarSessions({
      groups: [group(["/work/app"], [kept])],
      projects: PROJECTS,
      scopeProjectId: null,
      now: NOW + 60 * 60_000,
    }).active[0]!;
    expect(awake).not.toBe(asleep);
    expect(awake.snoozedUntil).toBeNull();
  });
});
