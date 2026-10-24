// Where the overlay's file actions act: the session's own checkout when it
// works outside the project (a pull request session's worktree), else the
// project.

import { describe, expect, it } from "vitest";
import { sessionWorkPath } from "./session-work-path";

const PROJECT = "/work/acme";
const WORKTREE = "/Users/me/Library/Application Support/atlas/worktrees/acme-pr-42";

describe("sessionWorkPath", () => {
  it("is the worktree a pull request session is bound to", () => {
    expect(sessionWorkPath({ bindCwd: WORKTREE }, PROJECT)).toBe(WORKTREE);
    expect(sessionWorkPath({ workingDirectory: WORKTREE }, PROJECT)).toBe(WORKTREE);
  });

  it("is the project for a session in the project, or in a folder of it", () => {
    expect(sessionWorkPath({ workingDirectory: PROJECT }, PROJECT)).toBe(PROJECT);
    expect(sessionWorkPath({ bindCwd: `${PROJECT}/packages/web` }, PROJECT)).toBe(PROJECT);
    expect(sessionWorkPath(undefined, PROJECT)).toBe(PROJECT);
  });

  it("prefers the bound directory over the one the session was created with", () => {
    expect(sessionWorkPath({ bindCwd: WORKTREE, workingDirectory: PROJECT }, PROJECT)).toBe(
      WORKTREE,
    );
  });
});
