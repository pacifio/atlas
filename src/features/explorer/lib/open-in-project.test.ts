import { beforeEach, describe, expect, it, vi } from "vitest";

const kind = vi.hoisted(() => ({ resolve: null as null | ((k: string) => void) }));
const openFileAs = vi.hoisted(() => vi.fn());
vi.mock("@/lib/open-file", () => ({
  fileKindOf: () => new Promise((resolve) => (kind.resolve = resolve)),
  openFileAs,
}));
const active = vi.hoisted(() => ({ id: "p1" as string | null }));
vi.mock("@/features/projects/lib/active-project", () => ({ activeProjectId: () => active.id }));

import { openInProject } from "./open-in-project";

beforeEach(() => {
  openFileAs.mockReset();
  active.id = "p1";
});

describe("openInProject", () => {
  it("opens the file, then calls back, in the project it was clicked in", async () => {
    const onOpened = vi.fn();
    const done = openInProject("/p1/Makefile", onOpened);
    kind.resolve!("text");
    await done;
    expect(openFileAs).toHaveBeenCalledWith("/p1/Makefile", "text");
    expect(onOpened).toHaveBeenCalledWith("/p1/Makefile");
  });

  it("does neither when the project changes while the file is classified", async () => {
    const onOpened = vi.fn();
    const done = openInProject("/p1/Makefile", onOpened);
    active.id = "p2"; // switched project mid-sniff
    kind.resolve!("text");
    await done;
    expect(openFileAs).not.toHaveBeenCalled();
    expect(onOpened).not.toHaveBeenCalled();
  });
});
