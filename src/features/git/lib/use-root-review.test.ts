import { describe, expect, it } from "vitest";
import type { FileDiffMetadata } from "@pierre/diffs";

import { sessionRoots } from "@/features/chat/lib/session-roots";
import type { ReviewFile } from "./use-review-files";
import { combineReviews, type AttachedRootReview } from "./use-root-review";

function file(path: string, additions = 1, deletions = 0): ReviewFile {
  return {
    stat: { path, additions, deletions, status: "modified" },
    fileDiff: { name: path, hunks: [] } as unknown as FileDiffMetadata,
    state: "ready",
    truncated: false,
  };
}

const roots = sessionRoots({ path: "/u/app", name: "app" }, [
  {
    path: "/u/docs",
    displayName: "docs",
    access: "read_write",
    attachedAt: "2026-01-01T00:00:00Z",
    source: "mention",
  },
]);

const docsReview = (files: ReviewFile[]): AttachedRootReview =>
  ({
    root: roots[1],
    source: null,
    review: { files },
  }) as unknown as AttachedRootReview;

describe("combineReviews", () => {
  it("keeps a main-project-only list as it was", () => {
    const main = [file("src/a.ts"), file("README.md")];
    const out = combineReviews(main, [], roots);
    expect(out.grouped).toBe(false);
    expect(out.files[0]).toBe(main[0]);
    expect(out.stats.map((s) => s.path)).toEqual(["src/a.ts", "README.md"]);
  });

  it("keys another root's files by project, groups them, and remembers where they came from", () => {
    const out = combineReviews(
      [file("README.md", 2, 1), file("/tmp/note.md")],
      [docsReview([file("README.md", 5, 0)])],
      roots,
    );
    expect(out.grouped).toBe(true);
    expect(out.groups.map((g) => [g.label, g.additions, g.deletions])).toEqual([
      ["app", 2, 1],
      ["docs", 5, 0],
      ["Other", 1, 0],
    ]);
    const key = "docs › README.md";
    expect(out.files.map((f) => f.stat.path)).toEqual(["README.md", key, "/tmp/note.md"]);
    expect(out.files[1].fileDiff.name).toBe(key);
    expect(out.keys.get(key)).toMatchObject({
      orig: "README.md",
      rel: "README.md",
      abs: "/u/docs/README.md",
      slot: 0,
    });
  });

  it("finds the key of a file named by its absolute path", () => {
    const out = combineReviews([file("/u/docs/guide/x.mdx")], [], roots);
    expect(out.keyOf("/u/docs/guide/x.mdx")).toBe("docs › guide/x.mdx");
    expect(out.keyOf("/u/app/src/a.ts")).toBe("src/a.ts");
  });
});
