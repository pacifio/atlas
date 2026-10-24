// @vitest-environment happy-dom
//
// The menu entries: the preferred editor first as "Open in X", every other
// installed editor after it, and a click opening that path in that editor.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: unknown) => null as unknown));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (c: string, a?: unknown) => invoke(c, a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/ui/dropdown-menu";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { useExternalEditorStore } from "../stores/external-editor-store";
import {
  editorMenuEntries,
  OpenInEditorContextItems,
  OpenInEditorDropdownItems,
} from "./open-in-editor-menu";

const EDITORS = [
  { id: "cursor", label: "Cursor" },
  { id: "zed", label: "Zed" },
  { id: "system", label: "System default" },
];

function setPreferred(id: string) {
  const { settings } = useSettingsStore.getState();
  useSettingsStore.setState({ settings: { ...settings, preferredEditor: id } });
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) =>
    cmd === "external_editors_detect" ? EDITORS : null,
  );
  useExternalEditorStore.setState({ editors: null });
  setPreferred("");
});
afterEach(() => cleanup());

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

describe("editorMenuEntries", () => {
  it("puts the preferred editor first and lists the rest in detection order", () => {
    expect(editorMenuEntries(EDITORS, EDITORS[1]!)).toEqual({
      primary: EDITORS[1],
      others: [EDITORS[0], EDITORS[2]],
    });
  });

  it("offers nothing before detection answers", () => {
    expect(editorMenuEntries(null, null)).toEqual({ primary: null, others: [] });
  });
});

describe("the file tree's context menu entries", () => {
  async function openMenu() {
    render(
      <ContextMenu>
        <ContextMenuTrigger>row</ContextMenuTrigger>
        <ContextMenuContent>
          <OpenInEditorContextItems path="/p/My Project/a.ts" />
        </ContextMenuContent>
      </ContextMenu>,
    );
    fireEvent.contextMenu(screen.getByText("row"));
    await settle();
  }

  it("names the first detected editor when none is chosen, and opens the path in it", async () => {
    await openMenu();
    fireEvent.click(await screen.findByText("Open in Cursor"));
    await settle();
    expect(invoke).toHaveBeenCalledWith("external_editor_open", {
      editor: "cursor",
      path: "/p/My Project/a.ts",
      line: null,
      column: null,
    });
  });

  it("names the chosen editor, and keeps the others under Open With", async () => {
    setPreferred("zed");
    await openMenu();
    expect(await screen.findByText("Open in Zed")).toBeTruthy();
    expect(screen.queryByText("Open in Cursor")).toBeNull();
    expect(screen.getByText("Open With")).toBeTruthy();
  });
});

describe("the project folder's dropdown entries", () => {
  it("lists every installed editor but leaves the system default to the caller", async () => {
    setPreferred("zed");
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>more</DropdownMenuTrigger>
        <DropdownMenuContent>
          <OpenInEditorDropdownItems path="/p" />
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    fireEvent.click(screen.getByText("more"));
    await settle();
    const items = (await screen.findAllByRole("menuitem")).map((el) => el.textContent);
    expect(items).toEqual(["Open in Zed", "Open in Cursor"]);
  });
});
