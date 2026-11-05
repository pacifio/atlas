// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import type { ReviewFile } from "../../lib/use-review-files";

// No Tauri here: the settings store subscribes to config changes at import,
// and the panel listens for git and file-system events.
vi.mock("@/features/settings/lib/atlas-config-api", () => ({
  updateSettings: vi.fn(),
  resetConfig: vi.fn(),
  onConfigChanged: () => Promise.resolve(() => {}),
  onConfigError: () => Promise.resolve(() => {}),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

vi.mock("../../lib/git-review-api", () => ({
  getDiffPreview: vi.fn(async () => ({
    sources: [{ kind: "working-tree", baseRef: null, mergeBase: null }],
  })),
  getDiffFileContents: vi.fn(),
}));

const FILE: ReviewFile = {
  stat: { path: "src/long.ts", status: "modified", additions: 1, deletions: 0 },
  fileDiff: {
    name: "src/long.ts",
    hunks: [],
    additionLines: [],
    deletionLines: [],
    cacheKey: "long",
  },
  state: "ready",
  truncated: false,
} as unknown as ReviewFile;

const fileAt = (path: string, state: ReviewFile["state"] = "ready"): ReviewFile =>
  ({
    ...FILE,
    stat: { ...FILE.stat, path, additions: 12, deletions: 3 },
    fileDiff: { ...FILE.fileDiff, name: path, cacheKey: path },
    state,
  }) as unknown as ReviewFile;

// What the git review hands the panel; a test may swap in a longer list.
let reviewFiles: ReviewFile[] = [FILE];
const requestFileSpy = vi.fn();
vi.mock("../../lib/use-review-files", () => ({
  useReviewFiles: () => ({
    files: reviewFiles,
    stats: reviewFiles.map((f) => f.stat),
    requestFile: requestFileSpy,
    retry: vi.fn(),
  }),
  invalidateReviewFiles: vi.fn(),
}));

// The viewer itself renders in a shadow root off a worker pool; what matters
// here is what the panel hands it: the `overflow`, each item's fold, and the
// header tail it draws for each file.
type MockItem = { id: string; type: "diff"; collapsed?: boolean };
const scrollToSpy = vi.fn();
vi.mock("./styled-code-view", () => ({
  StyledCodeView: (props: {
    options: { overflow: string };
    items: MockItem[];
    viewerRef?: (
      handle: { scrollTo: typeof scrollToSpy; getInstance: () => undefined } | null,
    ) => void;
    renderHeaderPrefix?: (item: MockItem) => ReactNode;
    renderHeaderFilenameSuffix?: (item: MockItem) => ReactNode;
    renderHeaderMetadata?: (item: MockItem) => ReactNode;
  }) => {
    const { viewerRef } = props;
    useEffect(() => {
      viewerRef?.({ scrollTo: scrollToSpy, getInstance: () => undefined });
      return () => viewerRef?.(null);
    }, [viewerRef]);
    return (
      <div data-testid="viewer" data-overflow={props.options.overflow}>
        {props.items.map((item) => (
          <div key={item.id} data-testid="item" data-collapsed={String(item.collapsed === true)}>
            {props.renderHeaderPrefix?.(item)}
            {props.renderHeaderFilenameSuffix?.(item)}
            {props.renderHeaderMetadata?.(item)}
          </div>
        ))}
      </div>
    );
  },
}));

const { DiffPanel } = await import("./diff-panel");
const { useSettingsStore } = await import("@/features/settings/stores/settings-store");
const { DEFAULT_SETTINGS } = await import("@/features/settings/lib/app-settings");
const { useLayoutStore } = await import("@/features/layout/stores/layout-store");
const { isMac } = await import("@/lib/platform");
const { useDiffPanelStore } = await import("../../stores/diff-panel-store");
const { DiffPanelView } = await import("./diff-panel-view");
const { requestDiffJump } = await import("../../lib/diff-jump");
type DiffViewSource = import("./diff-panel-view").DiffViewSource;

const updateSettings = vi.fn((partial: Partial<typeof DEFAULT_SETTINGS>) =>
  useSettingsStore.setState((s) => ({ settings: { ...s.settings, ...partial } })),
);

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DiffPanel tabId="review" repoPath="/repo" />
    </QueryClientProvider>,
  );
}

// A source that keeps viewed marks the way the pull request's Code tab does:
// whoever owns the marks says what is viewed and what went stale.
const setViewedSpy = vi.fn();
function ViewedHarness({ stale = false }: { stale?: boolean }) {
  const [marks, setMarks] = useState<Record<string, boolean>>({});
  const source: DiffViewSource = {
    key: "pr:1",
    files: [FILE],
    picker: null,
    viewed: {
      isViewed: (path) => marks[path] === true,
      isStale: (path) => stale && marks[path] === true,
      setViewed: (path, viewed) => {
        setViewedSpy(path, viewed);
        setMarks((m) => ({ ...m, [path]: viewed }));
      },
    },
  };
  return <DiffPanelView tabId="review" repoPath="/repo" source={source} />;
}
function renderViewedPanel(props: { stale?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ViewedHarness {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  reviewFiles = [FILE];
  useDiffPanelStore.setState({ folds: {}, scope: {}, baseRef: {} });
  useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS },
    actions: { ...useSettingsStore.getState().actions, updateSettings },
  });
});
afterEach(cleanup);

describe("DiffPanel word wrap", () => {
  it("wraps by default, from the global setting", async () => {
    expect(DEFAULT_SETTINGS.wordWrap).toBe(true);
    renderPanel();
    const viewer = await screen.findByTestId("viewer");
    expect(viewer.dataset.overflow).toBe("wrap");
    expect(screen.getByRole("button", { name: /word wrap/i }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("scrolls when the setting is off", async () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, wordWrap: false } }));
    renderPanel();
    expect((await screen.findByTestId("viewer")).dataset.overflow).toBe("scroll");
  });

  it("its toggle flips the global setting, and the viewer follows", async () => {
    renderPanel();
    await screen.findByTestId("viewer");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /word wrap/i }));
    });
    expect(updateSettings).toHaveBeenCalledWith({ wordWrap: false });
    expect(screen.getByTestId("viewer").dataset.overflow).toBe("scroll");
    expect(screen.getByRole("button", { name: /word wrap/i }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });
});

describe("DiffPanel find (⌘F)", () => {
  const press = () => {
    const event = new KeyboardEvent("keydown", {
      code: "KeyF",
      key: "f",
      metaKey: isMac,
      ctrlKey: !isMac,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });
    return event;
  };

  it("opens the find bar while its tab is the active one", async () => {
    useLayoutStore.setState({ activeTabId: "review" });
    renderPanel();
    await screen.findByTestId("viewer");
    expect(screen.queryByRole("search")).toBeNull();
    const event = press();
    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByRole("search", { name: "Find in diff" })).toBeTruthy();
  });

  it("leaves ⌘F to the session when the session's tab has the keyboard", async () => {
    useLayoutStore.setState({ activeTabId: "session-tab" });
    renderPanel();
    await screen.findByTestId("viewer");
    const event = press();
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole("search")).toBeNull();
  });
});

describe("DiffPanel file headers", () => {
  it("shows a file's counts additions first, both sides always", async () => {
    renderPanel();
    await screen.findByTestId("viewer");
    const item = within(screen.getByTestId("item"));
    const stat = item.getByRole("group", { name: "1 additions, 0 deletions" });
    expect(stat.textContent).toBe("+1−0");
  });

  it("puts additions before deletions in the header total too", async () => {
    reviewFiles = [fileAt("a.ts"), fileAt("b.ts")];
    renderPanel();
    await screen.findByTestId("viewer");
    const total = screen.getByRole("group", { name: "24 additions, 6 deletions" });
    expect(total.textContent).toBe("+24−6");
    const [first] = within(screen.getAllByTestId("item")[0]!).getAllByRole("group", {
      name: "12 additions, 3 deletions",
    });
    expect(first!.textContent).toBe("+12−3");
  });
});

describe("DiffPanel collapsed files", () => {
  const collapsed = () => screen.getAllByTestId("item").map((i) => i.dataset.collapsed);

  it("opens every file collapsed to its header, even a diff of one", async () => {
    expect(DEFAULT_SETTINGS.diffFilesCollapsed).toBe(true);
    renderPanel();
    await screen.findByTestId("viewer");
    expect(collapsed()).toEqual(["true"]);
    reviewFiles = [fileAt("a.ts"), fileAt("b.ts"), fileAt("c.ts")];
    cleanup();
    renderPanel();
    await screen.findByTestId("viewer");
    expect(collapsed()).toEqual(["true", "true", "true"]);
  });

  it("expands one file on its chevron and remembers it; expand all and collapse all still work", async () => {
    reviewFiles = [fileAt("a.ts"), fileAt("b.ts"), fileAt("c.ts")];
    renderPanel();
    await screen.findByTestId("viewer");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Expand b.ts" }));
    });
    expect(collapsed()).toEqual(["true", "false", "true"]);
    // Remembered for the scope: a remount (a tab switch) keeps it open.
    cleanup();
    renderPanel();
    await screen.findByTestId("viewer");
    expect(collapsed()).toEqual(["true", "false", "true"]);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Collapse all files" }));
    });
    expect(collapsed()).toEqual(["true", "true", "true"]);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Expand all files" }));
    });
    expect(collapsed()).toEqual(["false", "false", "false"]);
  });

  it("starts expanded when the setting is off", async () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, diffFilesCollapsed: false } }));
    reviewFiles = [fileAt("a.ts"), fileAt("b.ts")];
    renderPanel();
    await screen.findByTestId("viewer");
    expect(collapsed()).toEqual(["false", "false"]);
  });

  it("a jump into a collapsed file expands it and scrolls to it", async () => {
    reviewFiles = [fileAt("a.ts"), fileAt("b.ts"), fileAt("c.ts")];
    renderPanel();
    await screen.findByTestId("viewer");
    act(() => requestDiffJump("review", "c.ts"));
    await vi.waitFor(() => expect(collapsed()).toEqual(["true", "true", "false"]));
    expect(scrollToSpy).toHaveBeenCalledWith({ type: "item", id: "\0c.ts", align: "start" });
  });

  it("asks for a file still to load only once it is opened", async () => {
    reviewFiles = [fileAt("a.ts", "pending"), fileAt("b.ts", "pending")];
    renderPanel();
    await screen.findByTestId("viewer");
    expect(requestFileSpy).not.toHaveBeenCalled();
    expect(screen.queryByText("Loading…")).toBeNull();
    act(() => requestDiffJump("review", "b.ts"));
    await vi.waitFor(() => expect(requestFileSpy).toHaveBeenCalledWith("b.ts"));
    expect(requestFileSpy).not.toHaveBeenCalledWith("a.ts");
  });
});

describe("DiffPanel scope menu", () => {
  const openMenu = async (name: RegExp) => {
    act(() => {
      fireEvent.click(screen.getByRole("button", { name }));
    });
    return screen.findByRole("menu");
  };

  it("names the git scopes Changes and Uncommitted, and has no turns without a session", async () => {
    renderPanel();
    await screen.findByTestId("viewer");
    const menu = within(await openMenu(/diff scope: uncommitted/i));
    expect(menu.getAllByRole("menuitemradio").map((i) => i.textContent)).toEqual([
      "Changes",
      "Uncommitted",
    ]);
    expect(menu.queryByText("Latest turn")).toBeNull();
    expect(menu.queryByText("Turn")).toBeNull();
  });

  it("reads a stored branch-range scope as Changes", async () => {
    useDiffPanelStore.setState({ scope: { review: "branch-range" } });
    renderPanel();
    expect(await screen.findByRole("button", { name: "Diff scope: Changes" })).toBeTruthy();
  });

  it("reads the old stored session scope as Changes", async () => {
    useDiffPanelStore.setState({ scope: { review: "session" as never } });
    renderPanel();
    expect(await screen.findByRole("button", { name: "Diff scope: Changes" })).toBeTruthy();
  });
});

describe("DiffPanel viewed files", () => {
  // With files expanded, so a tick is what folds one.
  beforeEach(() => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, diffFilesCollapsed: false } }));
  });

  it("has no Viewed box or count unless the panel offers them", async () => {
    renderPanel();
    await screen.findByTestId("viewer");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText(/viewed$/)).toBeNull();
  });

  const viewedCount = () => screen.getByText(/viewed$/).textContent;
  // Base UI's box forwards a click to its hidden native input, which is what
  // the test DOM can toggle.
  const tick = () =>
    act(() => {
      const box = screen.getAllByRole("checkbox")[0]!;
      fireEvent.click(box.parentElement!.querySelector("input")!);
    });

  it("counts viewed files, and a tick folds the file", async () => {
    renderViewedPanel();
    await screen.findByTestId("viewer");
    expect(screen.getByRole("checkbox", { name: "Viewed" })).toBeTruthy();
    expect(viewedCount()).toBe("0 / 1 viewed");
    expect(screen.getByTestId("item").dataset.collapsed).toBe("false");

    tick();
    expect(viewedCount()).toBe("1 / 1 viewed");
    expect(screen.getByTestId("item").dataset.collapsed).toBe("true");
    expect(setViewedSpy).toHaveBeenLastCalledWith("src/long.ts", true);

    // Unticking opens it again.
    tick();
    expect(viewedCount()).toBe("0 / 1 viewed");
    expect(screen.getByTestId("item").dataset.collapsed).toBe("false");
    expect(setViewedSpy).toHaveBeenLastCalledWith("src/long.ts", false);
  });

  it("reads as changed when the source says the file moved since it was viewed", async () => {
    renderViewedPanel({ stale: true });
    await screen.findByTestId("viewer");
    tick();
    expect(
      screen.getByRole("checkbox", { name: /changed since you marked it viewed/i }),
    ).toBeTruthy();
    expect(screen.getByText("Changed")).toBeTruthy();
    // Still counted: it was viewed, it just needs another look.
    expect(viewedCount()).toBe("1 / 1 viewed");
  });
});
