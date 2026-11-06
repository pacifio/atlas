// @vitest-environment happy-dom
/**
 * `files` identity is what six components re-render on, so it must survive a
 * refresh that found nothing new — which is most of them, since the refresh
 * runs on every file save.
 */
import { describe, expect, it, vi } from "vitest";

// Importing the store pulls in the app's store graph, which subscribes to Tauri
// at import time. `sameFiles` is pure; these keep that graph inert.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
import { produce } from "immer";
import { sameFiles, type GitFileStatus } from "./git-store";

const tree = (): GitFileStatus[] => [
  { path: "src/a.ts", status: "M", staged: false },
  { path: "src/b.ts", status: "A", staged: true },
  { path: "README.md", status: "??", staged: false },
];

describe("sameFiles", () => {
  it("keeps the previous array when the working tree is unchanged", () => {
    const prev = tree();
    expect(sameFiles(prev, tree())).toBe(prev);
  });

  it("takes the new array when a status, path, staged flag or count moves", () => {
    const prev = tree();
    const status = tree();
    status[0].status = "D";
    expect(sameFiles(prev, status)).not.toBe(prev);

    const staged = tree();
    staged[0].staged = true;
    expect(sameFiles(prev, staged)).not.toBe(prev);

    const path = tree();
    path[2].path = "CHANGELOG.md";
    expect(sameFiles(prev, path)).not.toBe(prev);

    expect(sameFiles(prev, tree().slice(1))).not.toBe(prev);
    expect(sameFiles(prev, [])).not.toBe(prev);
  });

  it("holds identity across an Immer producer, as the store uses it", () => {
    const before = { files: tree(), branch: "main" };
    const after = produce(before, (s) => {
      s.files = sameFiles(s.files, tree());
      s.branch = "main";
    });
    expect(after.files).toBe(before.files);

    const changed = produce(before, (s) => {
      s.files = sameFiles(s.files, tree().slice(1));
    });
    expect(changed.files).not.toBe(before.files);
    expect(changed.files).toHaveLength(2);
  });

  it("does not hold a stale array when the tree empties and refills identically", () => {
    const prev = tree();
    const emptied = sameFiles(prev, []);
    expect(emptied).toEqual([]);
    expect(sameFiles(emptied, tree())).toEqual(tree());
  });
});
