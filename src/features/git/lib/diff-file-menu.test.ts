// The right-click menu on a diff's file header offers what the file allows:
// a file on disk gets the project tree's verbs, a deleted one only its paths,
// and a diff whose files are not on this disk only the relative path.

import { describe, expect, it } from "vitest";

import { diffFileMenuItems } from "./diff-file-menu";

const onDisk = { deleted: false, absPath: "/p/src/a.ts", relPath: "src/a.ts", canOpen: true };

describe("diffFileMenuItems", () => {
  it("offers every verb for a file on disk", () => {
    expect(diffFileMenuItems(onDisk)).toEqual([
      "open",
      "separator",
      "reveal",
      "open-default",
      "open-in-editor",
      "separator",
      "copy-path",
      "copy-relative-path",
    ]);
  });

  it("drops Open when the diff cannot open its files", () => {
    expect(diffFileMenuItems({ ...onDisk, canOpen: false })[0]).toBe("reveal");
  });

  it("offers only paths for a deleted file", () => {
    expect(diffFileMenuItems({ ...onDisk, deleted: true })).toEqual([
      "copy-path",
      "copy-relative-path",
    ]);
  });

  it("offers only the relative path off disk", () => {
    expect(diffFileMenuItems({ ...onDisk, absPath: null })).toEqual(["copy-relative-path"]);
  });
});
