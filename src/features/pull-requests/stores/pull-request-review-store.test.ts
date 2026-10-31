import { describe, expect, it } from "vitest";

import { nextPendingCommentId, restoreDrafts } from "./pull-request-review-store";

const draft = (id: string) => ({
  id,
  path: "src/a.ts",
  body: "Off by one?",
  position: { kind: "line", line: 3, side: "right" },
});

describe("restoreDrafts", () => {
  it("keeps the drafts it can read, per pull request", () => {
    const stored = { drafts: { "/repo\u00007": [draft("a"), draft("b")] } };
    expect(restoreDrafts(stored)).toEqual(stored.drafts);
  });

  it("drops entries of another shape rather than sending them", () => {
    const restored = restoreDrafts({
      drafts: {
        "/repo\u00007": [draft("a"), { id: "b", body: "no path" }, null, "text"],
        "/repo\u00008": [{ id: "c", path: "x", body: "y", position: null }],
        "/repo\u00009": "not a list",
      },
    });
    expect(restoreDrafts({ drafts: restored })).toEqual(restored);
    expect(restored).toEqual({ "/repo\u00007": [draft("a")] });
  });

  it("starts empty from nothing or from garbage", () => {
    expect(restoreDrafts(undefined)).toEqual({});
    expect(restoreDrafts("x")).toEqual({});
    expect(restoreDrafts({ drafts: null })).toEqual({});
  });
});

describe("nextPendingCommentId", () => {
  it("never repeats", () => {
    const ids = new Set(Array.from({ length: 50 }, nextPendingCommentId));
    expect(ids.size).toBe(50);
  });
});
