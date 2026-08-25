// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

const mocks = vi.hoisted(() => ({
  byok: {
    entries: [] as Array<{
      provider: string;
      envVar: string;
      last4: string;
      editable: boolean;
      file?: string;
      line?: number;
    }>,
    profile: null,
    loaded: true,
    pending: null,
    actions: { load: vi.fn(), save: vi.fn(), remove: vi.fn() },
  },
  models: {
    list: [
      {
        id: "nomic-embed-text-v1.5",
        kind: "embedding" as const,
        name: "Nomic Embed Text",
        repo: "nomic-ai/nomic-embed-text-v1.5",
        files: [],
        sizeMb: 274,
        description: "A local embedding model",
        compatible: true,
        downloaded: false,
        selected: false,
      },
    ],
    loaded: true,
    downloading: {},
    pending: null,
    actions: { init: vi.fn(), download: vi.fn(), remove: vi.fn(), select: vi.fn() },
  },
}));

vi.mock("../stores/byok-store", () => ({
  useByokStore: {
    use: Object.fromEntries(
      Object.keys(mocks.byok).map((key) => [key, () => mocks.byok[key as keyof typeof mocks.byok]]),
    ),
  },
}));
vi.mock("../stores/models-store", () => ({
  useModelsStore: {
    use: Object.fromEntries(
      Object.keys(mocks.models).map((key) => [
        key,
        () => mocks.models[key as keyof typeof mocks.models],
      ]),
    ),
  },
}));
vi.mock("@/features/project/stores/project-store", () => ({
  useProjectStore: { use: { currentProject: () => null } },
}));

const { ProvidersSettings } = await import("./providers-settings");
const { ModelsManager } = await import("./models-manager");

afterEach(() => cleanup());
beforeEach(() => {
  mocks.byok.entries = [];
  mocks.models.list = [mocks.models.list[0]];
});

describe("settings table filtered empty states", () => {
  it("lets a filtered providers table clear its query and restore rows", async () => {
    const user = userEvent.setup();
    render(<ProvidersSettings />);

    await user.type(screen.getByPlaceholderText("Search providers…"), "does-not-exist");
    expect(screen.getByText("No providers match.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filter" }));

    expect(screen.getByPlaceholderText("Search providers…")).toHaveValue("");
    expect(screen.getAllByText("OpenAI").some((element) => element.tagName === "SPAN")).toBe(true);
    expect(screen.queryByRole("button", { name: "Clear filter" })).not.toBeInTheDocument();
  });

  it("preserves the providers empty state without an active filter", () => {
    const { rerender } = render(<ProvidersSettings />);
    expect(screen.queryByRole("button", { name: "Clear filter" })).not.toBeInTheDocument();

    rerender(<ProvidersSettings />);
    expect(screen.queryByRole("button", { name: "Clear filter" })).not.toBeInTheDocument();
  });

  it("lets a filtered models table clear its query and restore rows", async () => {
    const user = userEvent.setup();
    render(<ModelsManager />);

    await user.type(screen.getByPlaceholderText("Filter models…"), "does-not-exist");
    expect(screen.getByText("No models match.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filter" }));

    expect(screen.getByPlaceholderText("Filter models…")).toHaveValue("");
    expect(screen.getByText("Nomic Embed Text")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear filter" })).not.toBeInTheDocument();
  });

  it("preserves the models table when no filter is active", () => {
    mocks.models.list = [];
    render(<ModelsManager />);
    expect(screen.queryByText("No models match.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear filter" })).not.toBeInTheDocument();
  });
});
