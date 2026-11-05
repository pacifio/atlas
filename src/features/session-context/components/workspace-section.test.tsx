// @vitest-environment happy-dom
//
// "Open in" opens the preferred editor — the user's choice, or with
// "Automatic" the first one detected — and the file manager only when no
// editor is installed. Its ⌄ chooses which editor that is: it sets the
// preference, marks it, and opens nothing.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: unknown) => null as unknown));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (c: string, a?: unknown) => invoke(c, a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
const revealItemInDir = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir }));

import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { useExternalEditorStore } from "@/features/external-editor/stores/external-editor-store";
import { WorkspaceSection } from "./workspace-section";

const EDITORS = [
  { id: "cursor", label: "Cursor" },
  { id: "zed", label: "Zed" },
  { id: "system", label: "System default" },
];

function setPreferred(id: string) {
  const { settings } = useSettingsStore.getState();
  useSettingsStore.setState({ settings: { ...settings, preferredEditor: id } });
}

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) =>
    cmd === "external_editors_detect" ? EDITORS : null,
  );
  revealItemInDir.mockClear();
  useExternalEditorStore.setState({ editors: null });
  setPreferred("");
});
afterEach(() => cleanup());

async function mount(workPath = "/work/acme") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <WorkspaceSection projectPath="/work/acme" workPath={workPath} showEnvironment showOpenIn />
    </QueryClientProvider>,
  );
  await settle();
}

describe("WorkspaceSection", () => {
  it("opens the first detected editor with Automatic", async () => {
    await mount();
    fireEvent.click(screen.getByText("Open in Cursor"));
    await settle();
    expect(invoke).toHaveBeenCalledWith("external_editor_open", {
      editor: "cursor",
      path: "/work/acme",
      line: null,
      column: null,
    });
  });

  it("falls back to the file manager when no editor is detected", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "external_editors_detect" ? [] : null,
    );
    await mount();
    fireEvent.click(screen.getByText(/^Open in (Finder|Explorer|File Manager)$/));
    await settle();
    expect(revealItemInDir).toHaveBeenCalledWith("/work/acme");
    expect(invoke).not.toHaveBeenCalledWith("external_editor_open", expect.anything());
  });

  it("opens the editor the user chose", async () => {
    setPreferred("zed");
    await mount();
    fireEvent.click(screen.getByText("Open in Zed"));
    await settle();
    expect(invoke).toHaveBeenCalledWith("external_editor_open", {
      editor: "zed",
      path: "/work/acme",
      line: null,
      column: null,
    });
  });

  it("chooses the editor from the menu, and opens nothing", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Choose an editor" }));
    await settle();
    const items = (await screen.findAllByRole("menuitem")).map((el) => el.textContent);
    expect(items[0]).toMatch(/^Cursor/);
    expect(items[1]).toBe("Zed");
    expect(items[2]).toMatch(/^(Finder|Explorer|File Manager)/);
    invoke.mockClear();
    fireEvent.click(screen.getByRole("menuitem", { name: "Zed" }));
    await settle();
    expect(invoke).toHaveBeenCalledWith("update_atlas_settings", {
      patch: { preferredEditor: "zed" },
      expectedGeneration: expect.any(Number),
    });
    expect(invoke).not.toHaveBeenCalledWith("external_editor_open", expect.anything());
  });
});

describe("WorkspaceSection in a worktree session", () => {
  const WORKTREE = "/Users/me/Library/Application Support/atlas/worktrees/acme-pr-42";

  it("opens the session's worktree, not the project's checkout", async () => {
    await mount(WORKTREE);
    fireEvent.click(screen.getByText("Open in Cursor"));
    await settle();
    expect(invoke).toHaveBeenCalledWith("external_editor_open", {
      editor: "cursor",
      path: WORKTREE,
      line: null,
      column: null,
    });
    // The scripts still come from the project.
    expect(invoke).toHaveBeenCalledWith("project_scripts_list", { projectPath: "/work/acme" });
  });
});
