import { describe, expect, it } from "vitest";

import {
  conflictsContext,
  fileDiffContext,
  hunkContext,
  hunkText,
  resolveConflictsPrompt,
  shipErrorContext,
} from "./ask-git";
import type { DiffHunk } from "./diff";
import { anyGitErrorContext, gitErrorContext, type GitErrorPayload } from "./git-errors";

const HUNK: DiffHunk = {
  header: "@@ -1,3 +1,3 @@ export function getUser",
  oldStart: 1,
  newStart: 1,
  lines: [
    { type: "context", content: "const a = 1;", oldLine: 1, newLine: 1 },
    { type: "remove", content: "const b = 2;", oldLine: 2 },
    { type: "add", content: "const b = 3;", newLine: 2 },
  ],
};

const REJECTED: GitErrorPayload = {
  code: "push-rejected",
  message: "The remote refused the push.",
  rawStderr: "! [remote rejected] main -> main (pre-receive hook declined)",
  command: "git push --progress",
};

describe("a change as context", () => {
  it("writes a hunk back as git prints it", () => {
    expect(hunkText(HUNK)).toBe(
      "@@ -1,3 +1,3 @@ export function getUser\n const a = 1;\n-const b = 2;\n+const b = 3;",
    );
    expect(hunkContext("src/a.ts", HUNK, true)).toEqual({
      kind: "diff_hunk",
      path: "src/a.ts",
      hunk: hunkText(HUNK),
      staged: true,
    });
  });

  it("takes a file's hunks without its header, and nothing from a diff with none", () => {
    const diff =
      "diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
    expect(fileDiffContext("src/a.ts", diff, false)).toEqual({
      kind: "diff_hunk",
      path: "src/a.ts",
      hunk: "@@ -1 +1 @@\n-a\n+b",
      staged: false,
    });
    expect(fileDiffContext("img.png", "Binary files a/img.png and b/img.png differ\n", false)).toBe(
      null,
    );
  });
});

describe("a failure as context", () => {
  it("names the git verb, the command and the repository, with git's output", () => {
    expect(gitErrorContext(REJECTED, "/repo")).toEqual({
      kind: "error",
      source: "git push",
      message: "Push rejected\nThe remote refused the push.",
      log: REJECTED.rawStderr,
      command: "git push --progress",
      cwd: "/repo",
    });
  });

  it("prefers the op's full output to git's stderr when there is some", () => {
    expect(gitErrorContext(REJECTED, null, "hook: lint\nerror: 3 problems").log).toBe(
      "hook: lint\nerror: 3 problems",
    );
    expect(gitErrorContext(REJECTED, null, "  ").log).toBe(REJECTED.rawStderr);
  });

  it("reads any rejection, using the toast's words when given", () => {
    expect(anyGitErrorContext("boom", "/repo")).toEqual({
      kind: "error",
      source: "git",
      message: "boom",
      cwd: "/repo",
    });
    expect(anyGitErrorContext({ kind: "failed", message: "gh broke" }, null, "Pull").message).toBe(
      "gh broke",
    );
    expect(anyGitErrorContext({}, null, "git pull", "Pull failed").message).toBe("Pull failed");
    expect(anyGitErrorContext(REJECTED, null).command).toBe("git push --progress");
  });

  it("a ship step carries the step, the command and its output", () => {
    expect(
      shipErrorContext(
        { step: "Push", message: "Push rejected", command: "git push", output: "denied" },
        "/repo",
      ),
    ).toEqual({
      kind: "error",
      source: "Commit, push & PR: Push",
      message: "Push rejected",
      log: "denied",
      command: "git push",
      cwd: "/repo",
    });
  });
});

describe("conflicts as context", () => {
  it("lists every conflicted file with what is left in it", () => {
    const ctx = conflictsContext(
      [
        { path: "src/a.ts", markerCount: 3 },
        { path: "b.json", markerCount: 0 },
      ],
      "merge",
    );
    expect(ctx).toEqual({
      kind: "quote",
      text: "src/a.ts (3 conflict markers)\nb.json (no markers left)",
      source: "Conflicted files in the merge",
    });
  });

  it("leaves continuing or aborting to the user", () => {
    const prompt = resolveConflictsPrompt("rebase", "");
    expect(prompt).toContain("rebase conflicts");
    expect(prompt).toContain("do not run `git rebase --continue` or abort");
  });
});
