// @vitest-environment happy-dom
//
// File chips in team chat: other people write these messages, so a path is a
// chip only under the project the VIEWER has open, resolved on the viewer's
// side, and a click opens Atlas's viewer and nothing else.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const opener = vi.hoisted(() => ({
  openUrl: vi.fn(async () => {}),
  revealItemInDir: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/plugin-opener", () => opener);
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
const openOutsideFile = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/features/external-editor/lib/preferred-editor", () => ({ openOutsideFile }));
const openInProject = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/features/explorer/lib/open-in-project", () => ({ openInProject }));
vi.mock("@/features/file-picker/lib/file-picker-api", () => ({
  fileIndex: { search: vi.fn(async () => []) },
}));

import { useAppStore } from "@/features/app/stores/app-store";
import { MessageBody } from "./message-body";

const PROJECT = "/Users/dev/acme-app";

async function show(body: string) {
  const view = render(<MessageBody body={body} members={new Map()} me="u_me" />);
  await waitFor(() => expect(view.container.querySelector(".whitespace-pre-wrap")).toBe(null));
  return view;
}

const chipPaths = (root: ParentNode) =>
  [...root.querySelectorAll<HTMLElement>(".atlas-file-chip")].map((el) => el.dataset.filePath);

beforeAll(async () => {
  await import("./message-body-impl");
}, 30_000);

beforeEach(() => {
  useAppStore.setState({ currentProject: { path: PROJECT, name: "acme-app" } as never });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("file chips in team chat", () => {
  it("draws chips only for paths under the viewer's open project", async () => {
    const { container } = await show(
      "Look at `src/lib/api.ts:7`, not `/Users/sam/their-app/src/lib/api.ts`, `../secrets.env` or `/etc/hosts`.",
    );
    expect(chipPaths(container)).toEqual([`${PROJECT}/src/lib/api.ts`]);
    expect(container.querySelectorAll("code")).toHaveLength(3);
  });

  it("draws none while the viewer has no project open", async () => {
    useAppStore.setState({ currentProject: null });
    const { container } = await show("`src/lib/api.ts`");
    expect(chipPaths(container)).toEqual([]);
  });

  it("opens a chip in Atlas's viewer, never the system or an editor", async () => {
    const { container } = await show("`scripts/setup.terminal`");
    const chip = container.querySelector<HTMLElement>(".atlas-file-chip")!;
    fireEvent.click(chip);
    await waitFor(() =>
      expect(openInProject).toHaveBeenCalledWith(
        `${PROJECT}/scripts/setup.terminal`,
        undefined,
        undefined,
      ),
    );
    expect(opener.openUrl).not.toHaveBeenCalled();
    expect(opener.revealItemInDir).not.toHaveBeenCalled();
    expect(openOutsideFile).not.toHaveBeenCalled();
  });
});
