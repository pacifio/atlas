// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { FileDiff, SharedThreadRun, ThreadVersion } from "../lib/shared-threads-api";

// The design system's styling libraries are not what is under test.
vi.mock("@/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/ui/button", () => ({
  Button: ({
    children,
    size: _size,
    variant: _variant,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { size?: string; variant?: string }) => (
    <button type="button" {...rest}>
      {children}
    </button>
  ),
}));
vi.mock("@/features/git/components/diff-view", () => ({
  DiffView: ({ diff }: { diff: string }) => <pre data-testid="diff">{diff}</pre>,
}));

const api = vi.hoisted(() => ({
  listVersions: vi.fn(),
  diffAgainst: vi.fn(),
  restoreToVersion: vi.fn(),
  markVersion: vi.fn(),
  onVersionsChanged: vi.fn(() => Promise.resolve(() => {})),
  onSharedDocUpdate: vi.fn(() => Promise.resolve(() => {})),
  listLineComments: vi.fn(() => Promise.resolve([])),
  commentOnLines: vi.fn(),
  replyToLineComment: vi.fn(),
  resolveLineComment: vi.fn(),
  voteLineComment: vi.fn(),
}));
vi.mock("../lib/shared-threads-api", () => ({
  ...api,
  sharedThreadError: (e: unknown) => ({ code: "x", message: String(e) }),
}));

const { VersionsPanel, hunkLines, lastRunVersion, versionLabel } = await import("./versions-panel");

const RUN = {
  runId: "run-1",
  runNo: 3,
  promptedBy: "joy",
  runnerId: "joy",
  agent: "claude-code",
  model: "opus",
  forkSeq: 0,
  status: "merged",
  startedAt: 1,
  endedAt: 2,
  mergedVersion: 5,
  files: ["site.css"],
  currentFile: null,
} as SharedThreadRun;

const MERGE: ThreadVersion = {
  version: 5,
  kind: "merge",
  runId: "run-1",
  conflictId: null,
  restoredFrom: null,
  authorId: "joy",
  at: 1,
  files: [{ fileId: 1, blob: "b".repeat(64) }],
  mark: null,
};
const MARK: ThreadVersion = { ...MERGE, version: 7, kind: "mark", runId: null, files: [], mark: { label: "ship it", by: "val", at: 2 }, authorId: "val" };

const SITE: FileDiff = {
  fileId: 1,
  path: "site.css",
  change: "modified",
  diff: "diff --git a/site.css b/site.css\n--- a/site.css\n+++ b/site.css\n@@ -1 +1 @@\n-blue\n+teal\n",
  restorable: true,
};

const nameOf = (id: string) => ({ joy: "Joy", val: "Val" })[id] ?? id;

function draw(canEdit: boolean) {
  api.listVersions.mockResolvedValue([MARK, MERGE]);
  api.diffAgainst.mockImplementation((_id: string, v: number | null) =>
    Promise.resolve(v === null ? [{ ...SITE, restorable: false }] : [SITE]),
  );
  render(<VersionsPanel sharedThreadId="thr_1" head={9} runs={[RUN]} canEdit={canEdit} nameOf={nameOf} />);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Versions in words", () => {
  it("names each Version by what made it", () => {
    expect(versionLabel(MERGE, [RUN], nameOf)).toBe("Version 5 · Run #3 by Joy");
    expect(versionLabel(MARK, [RUN], nameOf)).toBe("Version 7 · marked by Val · ship it");
    expect(versionLabel({ ...MERGE, version: 8, kind: "restore", restoredFrom: 5 }, [], nameOf)).toBe(
      "Version 8 · restored to 5 by Joy",
    );
    expect(lastRunVersion([RUN, { ...RUN, runNo: 4, status: "interrupted", mergedVersion: null }])).toBe(5);
  });
});

describe("commenting on a diff's lines", () => {
  const hunk = {
    header: "@@ -1,3 +1,3 @@",
    oldStart: 1,
    newStart: 1,
    lines: [
      { type: "context" as const, content: "a", oldLine: 1, newLine: 1 },
      { type: "remove" as const, content: "blue", oldLine: 2 },
      { type: "add" as const, content: "teal", newLine: 2 },
      { type: "context" as const, content: "c", oldLine: 3, newLine: 3 },
    ],
  };

  it("anchors on the lines as the file reads now", () => {
    expect(hunkLines(hunk)).toEqual({ start: 1, end: 3 });
    expect(hunkLines(hunk, [2])).toEqual({ start: 2, end: 2 });
    // Only removed lines picked: that text is gone, nothing to anchor on.
    expect(hunkLines(hunk, [1])).toBeNull();
  });
});

describe("VersionsPanel", () => {
  it("switches the diff base between the Base, the last Run and any Version", async () => {
    draw(true);
    await screen.findByText("site.css");
    expect(api.diffAgainst).toHaveBeenLastCalledWith("thr_1", null);
    const picker = (await screen.findByLabelText("Diff against")) as HTMLSelectElement;
    await waitFor(() =>
      expect([...picker.options].map((o) => o.textContent)).toEqual([
        "The Base",
        "Last Run · Version 5",
        "Version 7 · marked by Val · ship it",
      ]),
    );
    fireEvent.change(picker, { target: { value: "v:5" } });
    await waitFor(() => expect(api.diffAgainst).toHaveBeenLastCalledWith("thr_1", 5));
    fireEvent.click(screen.getByText("Show diff"));
    expect(screen.getByTestId("diff").textContent).toContain("+teal");
  });

  it("lets a participant restore files to the chosen Version and mark the thread", async () => {
    draw(true);
    await screen.findByText("site.css");
    // Against the Base there is nothing to restore to.
    expect(screen.queryByText("Restore all to this version")).toBeNull();
    fireEvent.change(screen.getByLabelText("Diff against"), { target: { value: "v:5" } });
    fireEvent.click(await screen.findByLabelText("Restore site.css to Version 5"));
    expect(api.restoreToVersion).toHaveBeenCalledWith("thr_1", 5, [1]);
    const all = screen.getByText("Restore all to this version") as HTMLButtonElement;
    await waitFor(() => expect(all.disabled).toBe(false));
    fireEvent.click(all);
    await waitFor(() => expect(api.restoreToVersion).toHaveBeenCalledTimes(2));

    fireEvent.change(screen.getByLabelText("Version label"), { target: { value: " before lunch " } });
    fireEvent.submit(screen.getByLabelText("Version label").closest("form")!);
    await waitFor(() => expect(api.markVersion).toHaveBeenCalledWith("thr_1", "before lunch"));
  });

  it("lets a viewer switch the base and nothing else", async () => {
    draw(false);
    await screen.findByText("site.css");
    fireEvent.change(screen.getByLabelText("Diff against"), { target: { value: "v:5" } });
    await waitFor(() => expect(api.diffAgainst).toHaveBeenLastCalledWith("thr_1", 5));
    expect(screen.queryByLabelText("Restore site.css to Version 5")).toBeNull();
    expect(screen.queryByText("Restore all to this version")).toBeNull();
    expect(screen.queryByText("Mark version")).toBeNull();
  });
});
