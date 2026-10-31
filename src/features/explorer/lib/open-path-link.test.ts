import { beforeEach, describe, expect, it, vi } from "vitest";

const openInProject = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./open-in-project", () => ({ openInProject }));
const search = vi.hoisted(() => vi.fn());
vi.mock("@/features/file-picker/lib/file-picker-api", () => ({ fileIndex: { search } }));
const project = vi.hoisted(() => ({ path: "/p" as string | null }));
vi.mock("@/features/app/stores/app-store", () => ({
  useAppStore: {
    getState: () => ({ currentProject: project.path ? { path: project.path } : null }),
  },
}));
const revealItemInDir = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir }));
const openOutsideFile = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/features/external-editor/lib/preferred-editor", () => ({ openOutsideFile }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { locateInProject, openPathLink, openUntrustedPathLink } from "./open-path-link";

describe("opening a chip from text Atlas does not trust", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    project.path = "/p";
    search.mockResolvedValue([]);
  });

  const nothingLeftAtlas = () => {
    expect(revealItemInDir).not.toHaveBeenCalled();
    expect(openOutsideFile).not.toHaveBeenCalled();
  };

  it("opens a file inside the surface's root in Atlas, at its line", async () => {
    expect(await openUntrustedPathLink({ path: "/p/src/a.ts", line: 3 }, "/p")).toBe(true);
    expect(openInProject).toHaveBeenCalledWith("/p/src/a.ts", undefined, {
      reveal: { line: 3, column: undefined },
    });
    nothingLeftAtlas();
  });

  it("opens a planted .terminal file inside the root only in Atlas's viewer", async () => {
    expect(await openUntrustedPathLink({ path: "/p/scripts/setup.terminal" }, "/p")).toBe(true);
    expect(openInProject).toHaveBeenCalledWith("/p/scripts/setup.terminal", undefined, undefined);
    nothingLeftAtlas();
  });

  it("opens nothing outside the root: absolute, climbing, or the open project's sibling", async () => {
    for (const path of ["/etc/passwd", "/p/../q/x.ts", "/elsewhere/setup.terminal", "/q/a.ts"]) {
      expect(await openUntrustedPathLink({ path }, "/p")).toBe(false);
    }
    // A root narrower than the open project: the project's other files are out.
    expect(await openUntrustedPathLink({ path: "/p/other/a.ts" }, "/p/docs")).toBe(false);
    expect(openInProject).not.toHaveBeenCalled();
    nothingLeftAtlas();
  });

  it("never reveals or runs a bundle, even inside the root", async () => {
    expect(await openUntrustedPathLink({ path: "/p/build/Foo.app" }, "/p")).toBe(false);
    expect(openInProject).not.toHaveBeenCalled();
    nothingLeftAtlas();
  });

  it("keeps the index's answer only while it stays inside the root", async () => {
    search.mockResolvedValue([{ path: "/p/src/deep/a.ts", rel: "src/deep/a.ts" }]);
    await openUntrustedPathLink({ path: "/p/docs/a.ts" }, "/p/docs");
    expect(openInProject).toHaveBeenCalledWith("/p/docs/a.ts", undefined, undefined);
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  project.path = "/p";
  search.mockResolvedValue([]);
});

describe("opening a session's file chip", () => {
  it("opens a project file as a tab, at the line the chip named", async () => {
    search.mockResolvedValue([{ path: "/p/src/a.ts", rel: "src/a.ts" }]);
    await openPathLink({ path: "/p/src/a.ts", line: 12 });
    expect(openInProject).toHaveBeenCalledWith("/p/src/a.ts", undefined, {
      reveal: { line: 12, column: undefined },
    });
    expect(openOutsideFile).not.toHaveBeenCalled();
  });

  it("opens without a reveal when no line was named", async () => {
    await openPathLink({ path: "/p/src/a.ts" });
    expect(openInProject).toHaveBeenCalledWith("/p/src/a.ts", undefined, undefined);
  });

  it("hands a file the user attached outside the project to the preferred editor or the system", async () => {
    await openPathLink({ path: "/elsewhere/x.ts", line: 3, trusted: true });
    expect(openOutsideFile).toHaveBeenCalledWith("/elsewhere/x.ts");
    expect(openInProject).not.toHaveBeenCalled();
  });

  it("only reveals an untrusted chip outside every root, never handing it to an app", async () => {
    await openPathLink({ path: "/elsewhere/setup.terminal" });
    expect(revealItemInDir).toHaveBeenCalledWith("/elsewhere/setup.terminal");
    expect(openOutsideFile).not.toHaveBeenCalled();
    expect(openInProject).not.toHaveBeenCalled();
  });

  it("reveals a folder in the file manager, inside the project or out", async () => {
    await openPathLink({ path: "/p/src", folder: true });
    await openPathLink({ path: "/elsewhere", folder: true });
    expect(revealItemInDir).toHaveBeenNthCalledWith(1, "/p/src");
    expect(revealItemInDir).toHaveBeenNthCalledWith(2, "/elsewhere");
    expect(openOutsideFile).not.toHaveBeenCalled();
  });

  it("reveals a bundle rather than opening it as a file or running it", async () => {
    await openPathLink({ path: "/p/build/Foo.app" });
    await openPathLink({ path: "/Applications/Calculator.app" });
    expect(revealItemInDir).toHaveBeenCalledTimes(2);
    expect(openInProject).not.toHaveBeenCalled();
    expect(openOutsideFile).not.toHaveBeenCalled();
  });

  it("hands an attached file to the preferred editor or the system when no project is open", async () => {
    project.path = null;
    await openPathLink({ path: "/p/src/a.ts", trusted: true });
    expect(openOutsideFile).toHaveBeenCalledWith("/p/src/a.ts");
  });

  it("opens a Windows project file as a tab whichever separators the chip uses", async () => {
    project.path = "C:\\Users\\me\\proj";
    search.mockResolvedValue([{ path: "C:\\Users\\me\\proj\\src\\a.ts", rel: "src\\a.ts" }]);
    await openPathLink({ path: "C:/Users/me/proj/src/a.ts" });
    expect(openInProject).toHaveBeenCalledWith("C:/Users/me/proj/src/a.ts", undefined, undefined);
    expect(openOutsideFile).not.toHaveBeenCalled();
  });
});

describe("a chip in a pull request session's worktree", () => {
  const WORKTREE = "/Users/me/Library/Application Support/atlas/worktrees/acme-web-pr-42";

  it("opens the agent's chip in Atlas, not the system's opener", async () => {
    // A malicious pull request adds `tools/setup.terminal`, the agent names
    // it, and the user clicks. The worktree is not the open project, but it
    // is the root the chip was resolved under.
    await openPathLink({ path: `${WORKTREE}/tools/setup.terminal`, root: WORKTREE });
    expect(openInProject).toHaveBeenCalledWith(
      `${WORKTREE}/tools/setup.terminal`,
      undefined,
      undefined,
    );
    expect(openOutsideFile).not.toHaveBeenCalled();
    expect(revealItemInDir).not.toHaveBeenCalled();
  });

  it("keeps the line a worktree chip named", async () => {
    await openPathLink({ path: `${WORKTREE}/src/a.ts`, line: 7, column: 2, root: WORKTREE });
    expect(openInProject).toHaveBeenCalledWith(`${WORKTREE}/src/a.ts`, undefined, {
      reveal: { line: 7, column: 2 },
    });
  });

  it("does not stretch the root to a path outside it", async () => {
    await openPathLink({ path: "/Applications/Evil/setup.terminal", root: WORKTREE });
    expect(openInProject).not.toHaveBeenCalled();
    expect(openOutsideFile).not.toHaveBeenCalled();
    expect(revealItemInDir).toHaveBeenCalledWith("/Applications/Evil/setup.terminal");
  });
});

describe("locateInProject", () => {
  it("finds the one indexed file a short path stands for", async () => {
    search.mockResolvedValue([
      { path: "/p/src/lib/api.ts", rel: "src/lib/api.ts" },
      { path: "/p/src/lib/api.test.ts", rel: "src/lib/api.test.ts" },
    ]);
    expect(await locateInProject("/p/api.ts", "/p")).toBe("/p/src/lib/api.ts");
    expect(search).toHaveBeenCalledWith("api.ts", 50);
  });

  it("finds a short path in a Windows index", async () => {
    search.mockResolvedValue([{ path: "C:\\proj\\src\\lib\\api.ts", rel: "src\\lib\\api.ts" }]);
    expect(await locateInProject("C:\\proj\\api.ts", "C:\\proj")).toBe(
      "C:\\proj\\src\\lib\\api.ts",
    );
    expect(search).toHaveBeenCalledWith("api.ts", 50);
  });

  it("keeps the path as written when it is ambiguous, missing or the index fails", async () => {
    search.mockResolvedValue([
      { path: "/p/a/index.ts", rel: "a/index.ts" },
      { path: "/p/b/index.ts", rel: "b/index.ts" },
    ]);
    expect(await locateInProject("/p/index.ts", "/p")).toBe("/p/index.ts");
    search.mockResolvedValue([]);
    expect(await locateInProject("/p/gone.ts", "/p")).toBe("/p/gone.ts");
    search.mockRejectedValue(new Error("no index"));
    expect(await locateInProject("/p/x.ts", "/p")).toBe("/p/x.ts");
  });
});
