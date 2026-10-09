// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelStatus } from "@/features/settings/lib/models-api";
import {
  codeModelToSuggest,
  downloadPercent,
  readDismissed,
} from "@/features/settings/lib/code-model-nudge";
import { DEFAULT_SETTINGS } from "@/features/settings/lib/app-settings";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
const openSettingsSection = vi.fn();
vi.mock("@/features/settings/lib/open-settings", () => ({
  openSettingsSection: (s: string) => openSettingsSection(s),
}));

const { CodeModelNudge } = await import("./code-model-nudge");
const { useModelsStore } = await import("@/features/settings/stores/models-store");
const { useSettingsStore } = await import("@/features/settings/stores/settings-store");

function model(over: Partial<ModelStatus>): ModelStatus {
  return {
    id: "granite-embedding-small-r2",
    kind: "code_embedding",
    name: "Granite Embedding Small R2",
    repo: "ibm-granite/granite-embedding-small-english-r2",
    files: [],
    dim: 384,
    sizeMb: 95,
    description: "",
    compatible: true,
    downloaded: false,
    selected: true,
    ...over,
  };
}

const memory = model({ id: "all-MiniLM-L6-v2", kind: "embedding", downloaded: false });

beforeEach(() => {
  cleanup();
  localStorage.clear();
  invoke.mockReset();
  openSettingsSection.mockReset();
  useModelsStore.setState({
    list: [],
    loaded: false,
    downloading: {},
    pending: null,
    codeNudgeDismissed: [],
  });
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, agentCodeTools: true } });
});

describe("codeModelToSuggest", () => {
  it("suggests the selected code model while it is missing", () => {
    expect(codeModelToSuggest([memory, model({})], [])?.id).toBe("granite-embedding-small-r2");
  });

  it("is quiet once it is downloaded, dismissed, or when only memory's model is missing", () => {
    expect(codeModelToSuggest([model({ downloaded: true })], [])).toBeNull();
    expect(codeModelToSuggest([model({})], ["granite-embedding-small-r2"])).toBeNull();
    expect(codeModelToSuggest([memory, model({ selected: false })], [])).toBeNull();
    expect(codeModelToSuggest([], [])).toBeNull();
  });

  it("asks again for a different code model", () => {
    expect(
      codeModelToSuggest([model({ id: "coderankembed" })], ["granite-embedding-small-r2"])?.id,
    ).toBe("coderankembed");
  });
});

describe("downloadPercent", () => {
  it("counts finished files and the one in flight", () => {
    expect(downloadPercent({ fileIndex: 0, fileCount: 1, received: 0, total: 0 })).toBe(0);
    expect(downloadPercent({ fileIndex: 2, fileCount: 3, received: 50, total: 100 })).toBe(83);
    expect(downloadPercent({ fileIndex: 2, fileCount: 3, received: 100, total: 100 })).toBe(100);
  });
});

describe("CodeModelNudge", () => {
  const list = [memory, model({})];

  function renderWithCatalog() {
    invoke.mockImplementation(async (cmd: string) => (cmd === "models_list" ? list : null));
    render(<CodeModelNudge />);
  }

  it("one click starts the download, and never on its own", async () => {
    renderWithCatalog();
    const button = await screen.findByRole("button", { name: "Enable semantic search" });
    expect(invoke).not.toHaveBeenCalledWith("model_download", expect.anything());

    await act(async () => fireEvent.click(button));
    expect(invoke).toHaveBeenCalledWith("model_download", { id: "granite-embedding-small-r2" });
    expect(await screen.findByRole("button", { name: "Downloading 0%" })).toBeTruthy();
  });

  it("opens Local Models", async () => {
    renderWithCatalog();
    fireEvent.click(await screen.findByRole("button", { name: "Open Local Models" }));
    expect(openSettingsSection).toHaveBeenCalledWith("models");
  });

  it("dismissing hides it and remembers that", async () => {
    renderWithCatalog();
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("group", { name: "Semantic code search" })).toBeNull();
    expect(readDismissed()).toEqual(["granite-embedding-small-r2"]);
  });

  it("dismissing in one composer hides it in every other open one", async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === "models_list" ? list : null));
    render(
      <>
        <CodeModelNudge />
        <CodeModelNudge />
      </>,
    );
    const [first] = await screen.findAllByRole("button", { name: "Dismiss" });
    expect(screen.getAllByRole("group", { name: "Semantic code search" })).toHaveLength(2);
    fireEvent.click(first);
    expect(screen.queryAllByRole("group", { name: "Semantic code search" })).toHaveLength(0);
  });

  it("stays hidden while agents have no code tools, and appears when they are turned on", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, agentCodeTools: false } });
    renderWithCatalog();
    await act(async () => {});
    expect(screen.queryByRole("group", { name: "Semantic code search" })).toBeNull();

    act(() =>
      useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, agentCodeTools: true } }),
    );
    expect(await screen.findByRole("group", { name: "Semantic code search" })).toBeTruthy();
  });

  it("renders nothing once the model is on disk", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "models_list" ? [model({ downloaded: true })] : null,
    );
    render(<CodeModelNudge />);
    await act(async () => {});
    expect(screen.queryByRole("group", { name: "Semantic code search" })).toBeNull();
  });
});
