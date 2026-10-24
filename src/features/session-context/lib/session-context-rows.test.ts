// The overlay's three pure orderings: the branch picker's options, the
// session's lineage edges, and which of the branch's pull requests leads.

import { describe, expect, it } from "vitest";

import type { ThreadRow } from "@/features/chat/lib/history-api";
import type { PrListEntry } from "@/features/pull-requests/lib/pull-requests-types";

import { branchOptions } from "../components/branch-picker";
import { lineageEdges } from "./session-lineage";
import { mergeSessionPullRequests, orderSessionPullRequests } from "./session-pull-requests";

describe("branchOptions", () => {
  const branches = [
    { name: "main", isCurrent: false },
    { name: "fix/pdf", isCurrent: true },
    { name: "feature/auth", isCurrent: false },
  ];

  it("lists the current branch first, then the rest by name", () => {
    expect(branchOptions(branches, "").map((o) => o.name)).toEqual([
      "fix/pdf",
      "feature/auth",
      "main",
    ]);
  });

  it("filters case-insensitively and offers to create a name nothing matches exactly", () => {
    const options = branchOptions(branches, "Fe");
    expect(options).toEqual([
      { kind: "branch", name: "feature/auth", current: false },
      { kind: "create", name: "Fe" },
    ]);
  });

  it("does not offer to create a branch that exists", () => {
    expect(branchOptions(branches, "main").some((o) => o.kind === "create")).toBe(false);
  });
});

function row(sessionId: string, parent: string | null, createdAt: string): ThreadRow {
  return {
    threadId: `th-${sessionId}`,
    sessionId,
    forkedFromSessionId: parent,
    createdAt,
    updatedAt: createdAt,
  } as ThreadRow;
}

describe("lineageEdges", () => {
  const rows = [
    row("root", null, "2026-10-01T00:00:00Z"),
    row("self", "root", "2026-10-02T00:00:00Z"),
    row("older-fork", "self", "2026-10-03T00:00:00Z"),
    row("newer-fork", "self", "2026-10-04T00:00:00Z"),
    row("unrelated", "root", "2026-10-05T00:00:00Z"),
  ];

  it("gives the parent first, then the forks newest first", () => {
    expect(lineageEdges(rows, "self").map((e) => [e.relation, e.row.sessionId])).toEqual([
      ["parent", "root"],
      ["fork", "newer-fork"],
      ["fork", "older-fork"],
    ]);
  });

  it("has nothing for a session with no id or no edges", () => {
    expect(lineageEdges(rows, null)).toEqual([]);
    expect(lineageEdges(rows, "newer-fork").map((e) => e.relation)).toEqual(["parent"]);
  });
});

function pr(number: number, state: PrListEntry["state"], updatedAt: string): PrListEntry {
  return { number, state, updatedAt } as PrListEntry;
}

describe("orderSessionPullRequests", () => {
  it("leads with the open one, the rest newest first", () => {
    const { current, rest } = orderSessionPullRequests([
      pr(1, "merged", "2026-10-03T00:00:00Z"),
      pr(2, "open", "2026-10-01T00:00:00Z"),
      pr(3, "closed", "2026-10-02T00:00:00Z"),
    ]);
    expect(current?.number).toBe(2);
    expect(rest.map((p) => p.number)).toEqual([1, 3]);
  });

  it("leads with the most recent when none is open, and is empty for none", () => {
    expect(
      orderSessionPullRequests([
        pr(1, "merged", "2026-10-01T00:00:00Z"),
        pr(2, "closed", "2026-10-02T00:00:00Z"),
      ]).current?.number,
    ).toBe(2);
    expect(orderSessionPullRequests([])).toEqual({ current: null, rest: [] });
  });
});

describe("mergeSessionPullRequests", () => {
  const url = (n: number) => `https://github.com/acme/shop/pull/${n}`;
  const link = (n: number, source: "manual" | "created" | "detected") => ({
    repository: "acme/shop",
    number: n,
    url: url(n),
    source,
    linkedAt: "2026-10-01T00:00:00Z",
    snapshot: null,
    watching: false,
  });
  const live = (n: number, state: "open" | "merged") =>
    ({ ...pr(n, state, "2026-10-05T00:00:00Z"), url: url(n), title: `PR ${n}` }) as PrListEntry;

  it("lists every link once, the branch read's state winning, then unlinked branch pull requests", () => {
    const merged = mergeSessionPullRequests(
      [link(1, "manual"), link(2, "created")],
      [live(2, "merged"), live(3, "open")],
    );
    expect(merged.map((m) => [m.number, m.state, m.source])).toEqual([
      [1, "open", "manual"],
      [2, "merged", "created"],
      [3, "open", null],
    ]);
  });
});
