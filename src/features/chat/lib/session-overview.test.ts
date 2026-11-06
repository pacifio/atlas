import { describe, expect, it } from "vitest";

import {
  changesStatus,
  committableTurn,
  formatDiffStat,
  hasChanges,
  mergeChanges,
  tallyChanges,
} from "./session-overview";
import type { SessionFile } from "./session-files";
import type { ChatMessage, TurnFile } from "@/types/agent";

function file(over: Partial<TurnFile> & Pick<TurnFile, "path">): TurnFile {
  return { kind: "edit", added: 0, removed: 0, ...over };
}

function turn(files: TurnFile[], repoAtTurn = true, id = "m1"): ChatMessage {
  return {
    id,
    role: "assistant",
    content: "",
    toolCalls: [],
    fileChanges: [],
    plan: null,
    timestamp: "2026-10-17T00:00:00Z",
    turnSummary: { turnSeq: 1, files, repoAtTurn },
  } as ChatMessage;
}

describe("tallyChanges", () => {
  it("sums a file edited across several turns into one entry", () => {
    // The rail answers "what has this conversation done to the repo", so the
    // same path touched twice is one row, not two.
    const tally = tallyChanges([
      turn([file({ path: "a.ts", added: 10, removed: 2 })], true, "m1"),
      turn([file({ path: "a.ts", added: 5, removed: 1 })], true, "m2"),
    ]);
    expect(tally.files).toHaveLength(1);
    expect(tally.files[0]).toMatchObject({ path: "a.ts", added: 15, removed: 3 });
    expect(tally.added).toBe(15);
    expect(tally.removed).toBe(3);
  });

  it("keeps 'created' once set", () => {
    // Created then edited again is still the thread's to have created, and git
    // reports it as A.
    const tally = tallyChanges([
      turn([file({ path: "n.ts", added: 9, created: true })], true, "m1"),
      turn([file({ path: "n.ts", added: 1 })], true, "m2"),
    ]);
    expect(tally.files[0].created).toBe(true);
  });

  it("counts a read-then-edited path as an edit only", () => {
    // Counted in both, the figure beside the header disagrees with the list
    // under it.
    const tally = tallyChanges([
      turn(
        [file({ path: "a.ts", kind: "read" }), file({ path: "b.ts", kind: "read" })],
        true,
        "m1",
      ),
      turn([file({ path: "a.ts", added: 3 })], true, "m2"),
    ]);
    expect(tally.files.map((f) => f.path)).toEqual(["a.ts"]);
    expect(tally.readCount).toBe(1);
  });

  it("ignores a turn still running, which has no summary yet", () => {
    const live = { ...turn([], true, "m2") } as ChatMessage;
    delete (live as { turnSummary?: unknown }).turnSummary;
    expect(tallyChanges([turn([file({ path: "a.ts", added: 2 })]), live]).added).toBe(2);
  });

  it("is empty for a thread that touched nothing", () => {
    expect(tallyChanges([]).files).toEqual([]);
    expect(hasChanges([])).toBe(false);
    expect(hasChanges([turn([file({ path: "a.ts", kind: "read" })])])).toBe(false);
    expect(hasChanges([turn([file({ path: "a.ts", added: 1 })])])).toBe(true);
  });
});

describe("tallyChanges with the running turn", () => {
  it("shows the running turn's edits before they are frozen", () => {
    // The rail exists for the turn you are watching: "No changes yet" over a
    // turn that has written six files was the bug.
    const live = {
      tc1: file({ path: "a.ts", added: 4, removed: 1 }),
      tc2: file({ path: "b.ts", kind: "read" }),
    };
    const tally = tallyChanges([turn([file({ path: "z.ts", added: 1 })])], live);
    expect(tally.files.map((f) => f.path)).toEqual(["z.ts", "a.ts"]);
    expect(tally.added).toBe(5);
    expect(tally.readCount).toBe(1);
    expect(hasChanges([], live)).toBe(true);
    expect(hasChanges([], { tc2: live.tc2 })).toBe(false);
  });
});

describe("mergeChanges", () => {
  const rec = (over: Partial<SessionFile> & Pick<SessionFile, "path">): SessionFile => ({
    created: false,
    deleted: false,
    outOfRepo: false,
    turns: 1,
    lastTurnSeq: 1,
    added: null,
    removed: null,
    ...over,
  });
  const REPO = "/repo";

  it("lists what the record attributed, counts included where it has a patch", () => {
    const rows = mergeChanges(
      [rec({ path: "a.ts", added: 3, removed: 1 }), rec({ path: "s.sh" })],
      tallyChanges([]),
      REPO,
    );
    expect(rows).toEqual([
      { path: "a.ts", created: false, deleted: false, status: "M", added: 3, removed: 1 },
      { path: "s.sh", created: false, deleted: false, status: "M" },
    ]);
  });

  it("lays the renderer's counts over the record, joined on the relative path", () => {
    // Tool arguments carry absolute paths; the record is project-relative. The
    // renderer's count is the transcript footer's figure, so it wins.
    const local = tallyChanges([turn([file({ path: "/repo/a.ts", added: 10, removed: 2 })])]);
    const rows = mergeChanges([rec({ path: "a.ts", added: 3, removed: 1 })], local, REPO);
    expect(rows).toEqual([
      { path: "a.ts", created: false, deleted: false, status: "M", added: 10, removed: 2 },
    ]);
  });

  it("keeps a file only one side knows about, record order first", () => {
    // The recorder is a worker a beat behind the delta: a Write the thread has
    // seen may not be in the record yet. A shell edit is the reverse.
    const local = tallyChanges([turn([file({ path: "/repo/new.ts", added: 5, created: true })])]);
    const rows = mergeChanges([rec({ path: "s.sh" })], local, REPO);
    expect(rows.map((r) => r.path)).toEqual(["s.sh", "new.ts"]);
    expect(rows[1]).toMatchObject({ created: true, added: 5, removed: 0 });
  });

  it("drops a touch outside the project and carries a deletion", () => {
    const rows = mergeChanges(
      [rec({ path: "/tmp/x", outOfRepo: true }), rec({ path: "gone.ts", deleted: true })],
      tallyChanges([]),
      REPO,
    );
    expect(rows).toEqual([{ path: "gone.ts", created: false, deleted: true, status: "D" }]);
  });

  it("says A for a file the record or a tool call saw created, D before A", () => {
    const local = tallyChanges([
      turn([
        file({ path: "/repo/made.ts", added: 4, created: true }),
        file({ path: "/repo/edited.ts", added: 1, created: false }),
      ]),
    ]);
    const rows = mergeChanges(
      [
        rec({ path: "new.ts", created: true }),
        rec({ path: "made.ts" }),
        rec({ path: "brief.ts", created: true, deleted: true }),
      ],
      local,
      REPO,
    );
    const status = Object.fromEntries(rows.map((r) => [r.path, r.status]));
    expect(status).toEqual({ "new.ts": "A", "made.ts": "A", "brief.ts": "D", "edited.ts": "M" });
  });

  it("leaves the status unknown when no source said whether it created the file", () => {
    const local = tallyChanges([
      turn([file({ path: "/repo/old.ts", added: 2, created: undefined })]),
    ]);
    const [row] = mergeChanges([], local, REPO);
    expect(row.status).toBeUndefined();
  });
});

describe("changesStatus", () => {
  it("is the diff stat when anything was counted, else the file count", () => {
    expect(changesStatus([])).toBe("");
    expect(changesStatus([{ path: "s.sh", created: false, deleted: false }])).toBe("1 file");
    expect(
      changesStatus([
        { path: "s.sh", created: false, deleted: false },
        { path: "a.ts", created: false, deleted: false, added: 2, removed: 1 },
      ]),
    ).toBe("+2 −1");
  });
});

describe("formatDiffStat", () => {
  it("renders nothing when nothing changed, so the slot can be omitted", () => {
    expect(formatDiffStat(0, 0)).toBe("");
    expect(formatDiffStat(58, 26)).toBe("+58 −26");
  });
});

describe("committableTurn", () => {
  it("is the last turn with edits, when the project was a repo then", () => {
    const m = committableTurn([
      turn([file({ path: "a.ts", added: 1 })], true, "m1"),
      turn([file({ path: "b.ts", added: 2 })], true, "m2"),
    ]);
    expect(m?.id).toBe("m2");
  });

  it("is nothing when the project was not a repo at the end of that turn", () => {
    // `repoAtTurn` is the only honest answer available later: a repo
    // initialised since has no claim on those edits.
    expect(committableTurn([turn([file({ path: "a.ts", added: 1 })], false)])).toBeNull();
  });

  it("is nothing when the last summarised turn only read", () => {
    expect(
      committableTurn([
        turn([file({ path: "a.ts", added: 1 })], true, "m1"),
        turn([file({ path: "b.ts", kind: "read" })], true, "m2"),
      ]),
    ).toBeNull();
  });
});
