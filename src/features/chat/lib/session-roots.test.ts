import { describe, expect, it } from "vitest";

import type { AttachedProject } from "./history-api";
import { changedFilesByRoot } from "./changed-files-tree";
import {
  OTHER_GROUP,
  groupByRoot,
  isUnderRoot,
  needsGroupHeaders,
  placeFile,
  rootOf,
  sessionRoots,
} from "./session-roots";

const attached = (path: string, displayName: string, access = "read_only"): AttachedProject => ({
  path,
  displayName,
  access: access as AttachedProject["access"],
  attachedAt: "2026-01-01T00:00:00Z",
  source: "mention",
});

const roots = sessionRoots({ path: "/u/app", name: "app" }, [
  attached("/u/docs", "docs", "read_write"),
  attached("/u/app/packages/ui", "ui"),
  attached("/u/app/", "app again"),
]);

describe("sessionRoots", () => {
  it("puts the main project first and drops an attached copy of it", () => {
    expect(roots.map((r) => [r.path, r.kind])).toEqual([
      ["/u/app", "main"],
      ["/u/docs", "attached"],
      ["/u/app/packages/ui", "attached"],
    ]);
    expect(roots[1].access).toBe("read_write");
  });
});

describe("placing files", () => {
  it("matches whole segments only", () => {
    expect(isUnderRoot("/u/app/src/a.ts", "/u/app")).toBe(true);
    expect(isUnderRoot("/u/apple/a.ts", "/u/app")).toBe(false);
    expect(isUnderRoot("C:\\U\\App\\a.ts", "c:/u/app")).toBe(true);
  });

  it("gives a nested project its own files", () => {
    expect(rootOf("/u/app/packages/ui/button.tsx", roots)?.name).toBe("ui");
    expect(rootOf("/u/app/src/a.ts", roots)?.name).toBe("app");
  });

  it("reads a relative path as the main project's, and keeps an outsider absolute", () => {
    expect(placeFile("src/a.ts", roots)).toMatchObject({ rel: "src/a.ts", abs: "/u/app/src/a.ts" });
    expect(placeFile("/u/docs/guide/x.mdx", roots)).toMatchObject({ rel: "guide/x.mdx" });
    expect(placeFile("/tmp/notes.md", roots)).toMatchObject({ root: null, rel: "/tmp/notes.md" });
  });
});

describe("groupByRoot", () => {
  it("orders main, attached in attach order, then Other, leaving empty groups out", () => {
    const groups = groupByRoot(
      ["/tmp/x", "/u/docs/a.md", "src/b.ts", "/u/docs/c.md"],
      roots,
      (p) => p,
    );
    expect(groups.map((g) => [g.label, g.items.length])).toEqual([
      ["app", 1],
      ["docs", 2],
      ["Other", 1],
    ]);
    expect(groups[2].key).toBe(OTHER_GROUP);
    expect(needsGroupHeaders(groups)).toBe(true);
  });

  it("needs no headers when every file is the main project's", () => {
    expect(needsGroupHeaders(groupByRoot(["src/a.ts"], roots, (p) => p))).toBe(false);
  });
});

describe("changedFilesByRoot", () => {
  it("shows each path relative to its own root, with its group's counts", () => {
    const groups = changedFilesByRoot(
      [
        { path: "/u/app/src/a.ts", kind: "edit", added: 2, removed: 1 },
        { path: "/u/docs/guide/x.mdx", kind: "edit", added: 3, removed: 0 },
        { path: "/u/docs/guide/y.mdx", kind: "read", added: 0, removed: 0 },
      ],
      roots,
    );
    expect(groups.map((g) => [g.label, g.files.map((f) => f.path), g.stat])).toEqual([
      ["app", ["src/a.ts"], { added: 2, removed: 1 }],
      ["docs", ["guide/x.mdx"], { added: 3, removed: 0 }],
    ]);
    expect(groups[1].files[0].source).toBe("/u/docs/guide/x.mdx");
  });
});
