import { describe, expect, it } from "vitest";
import { gitStatusPresentation, moreProminentGitStatus } from "./git-status-presentation";

describe("gitStatusPresentation", () => {
  it("uses warning for modified files and info blue for untracked files", () => {
    expect(gitStatusPresentation("M").color).toBe("var(--status-warning)");
    expect(gitStatusPresentation("?").color).toBe("var(--status-info)");
  });

  it("retains distinct semantic colors for added, deleted, renamed, and conflicted files", () => {
    expect(gitStatusPresentation("A").color).toBe("var(--status-success)");
    expect(gitStatusPresentation("D").color).toBe("var(--status-error)");
    expect(gitStatusPresentation("R").color).toBe("var(--status-info)");
    expect(gitStatusPresentation("U").color).toBe("var(--status-error)");
  });

  it("keeps the most prominent descendant status on collapsed folders", () => {
    const untracked = gitStatusPresentation("?");
    const modified = gitStatusPresentation("M");
    const conflicted = gitStatusPresentation("U");

    expect(moreProminentGitStatus(undefined, untracked)).toBe(untracked);
    expect(moreProminentGitStatus(untracked, modified)).toBe(modified);
    expect(moreProminentGitStatus(modified, conflicted)).toBe(conflicted);
  });
});
