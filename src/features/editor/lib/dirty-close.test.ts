// @vitest-environment happy-dom
//
// Closing a file tab with unsaved edits used to close it outright: the edits
// went with the unmounted editor and the file's buffer stayed `dirty: true`,
// so the next tab on that file read as unsaved before it was touched. These
// pin the prompt (Save / Don't save / Cancel) and the buffer release.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));

import { useConfirmStore } from "@/lib/confirm";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useEditorStore } from "../stores/editor-store";
import { requestCloseTab } from "@/features/chat/lib/close-tab";
import { registerFileSaver } from "./dirty-close";

const PATH = "/p/src/App.tsx";
const TAB = `editor:${PATH}`;

function editorTab(id: string, dirty: boolean) {
  return {
    id,
    type: "editor",
    title: "App.tsx",
    closable: true,
    dirty,
    data: { filePath: PATH },
  };
}

function seed(dirty: boolean, extraTabs: ReturnType<typeof editorTab>[] = []) {
  useLayoutStore.setState({
    tabs: [editorTab(TAB, dirty), ...extraTabs] as never,
    activeTabId: TAB,
  });
  useEditorStore.setState({
    buffers: { [PATH]: { path: PATH, originalContent: "x", dirty } as never },
    pendingReveals: {},
  });
}

const tabOpen = (id = TAB) => useLayoutStore.getState().tabs.some((t) => t.id === id);
const buffer = () => useEditorStore.getState().buffers[PATH];

/** Wait for the prompt, then answer it. */
async function answer(choice: "confirm" | "alternate" | "cancel") {
  await vi.waitFor(() => expect(useConfirmStore.getState().pending).not.toBeNull());
  const pending = useConfirmStore.getState().pending!;
  expect(pending).toMatchObject({ confirmLabel: "Save", alternateLabel: "Don't save" });
  useConfirmStore.getState().actions.settle(choice);
  // Let the close continuation run.
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  useConfirmStore.setState({ pending: null });
});

describe("closing a file tab", () => {
  it("closes a clean tab at once, and drops the file's buffer", () => {
    seed(false);
    requestCloseTab(TAB);
    expect(tabOpen()).toBe(false);
    expect(buffer()).toBeUndefined();
    expect(useConfirmStore.getState().pending).toBeNull();
  });

  it("keeps the tab and its edits on Cancel", async () => {
    seed(true);
    requestCloseTab(TAB);
    expect(tabOpen()).toBe(true);
    await answer("cancel");
    expect(tabOpen()).toBe(true);
    expect(buffer()).toBeDefined();
  });

  it("closes without writing on Don't save, and drops the buffer", async () => {
    seed(true);
    const save = vi.fn(async () => true);
    const unregister = registerFileSaver(TAB, save);
    requestCloseTab(TAB);
    await answer("alternate");
    expect(save).not.toHaveBeenCalled();
    expect(tabOpen()).toBe(false);
    expect(buffer()).toBeUndefined();
    unregister();
  });

  it("saves through the tab's panel on Save, closing only when the write landed", async () => {
    seed(true);
    const save = vi.fn(async () => false);
    const unregister = registerFileSaver(TAB, save);
    requestCloseTab(TAB);
    await answer("confirm");
    expect(save).toHaveBeenCalledOnce();
    expect(tabOpen()).toBe(true);

    save.mockResolvedValue(true);
    requestCloseTab(TAB);
    await answer("confirm");
    expect(tabOpen()).toBe(false);
    unregister();
  });

  it("keeps the buffer while another tab still shows the file", () => {
    seed(false, [editorTab("editor:split", false)]);
    requestCloseTab(TAB);
    expect(tabOpen()).toBe(false);
    expect(buffer()).toBeDefined();
  });
});
