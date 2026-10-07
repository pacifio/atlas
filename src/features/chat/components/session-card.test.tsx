// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  SessionCard,
  formatWorkingDuration,
  isTickerRunning,
  projectMonogram,
  type SessionCardProps,
} from "./session-card";
import { useChatStore } from "../stores/chat-store";
import { resetGhAvailabilityForTests } from "@/features/git/lib/git-pr-api";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
const openUrl = vi.fn(() => Promise.resolve());
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => openUrl(...(args as [])),
}));

// One shared IntersectionObserver backs every card; this fake reports each
// observed card as on screen unless a test turns that off and fires it itself.
let autoVisible = true;
const observed: Array<{ el: Element; fire: () => void }> = [];
class FakeIntersectionObserver {
  constructor(private cb: IntersectionObserverCallback) {}
  observe(el: Element) {
    const fire = () =>
      this.cb(
        [{ target: el, isIntersecting: true } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      );
    observed.push({ el, fire });
    if (autoVisible) queueMicrotask(fire);
  }
  unobserve() {}
  disconnect() {}
}

const PR = {
  number: 353,
  state: "open",
  title: "Model picker",
  url: "https://github.com/x/y/pull/353",
  isDraft: false,
};

function prsAnswer(byBranch: Record<string, unknown>) {
  return (cmd: string) =>
    cmd === "git_repo_pull_requests"
      ? Promise.resolve({ kind: "ok", byBranch })
      : Promise.resolve(null);
}

function renderCard(props: Partial<SessionCardProps> = {}) {
  const client = new QueryClient();
  const handlers = { onOpen: vi.fn(), onArchive: vi.fn(), onDelete: vi.fn() };
  const view = render(
    <QueryClientProvider client={client}>
      <SessionCard
        threadId="thread-1"
        title="Add Model Picker Dropdown"
        projectName="atlas"
        showProject={false}
        branch="0.4.0"
        cwd="/repo/atlas"
        lastUpdated={new Date().toISOString()}
        status={null}
        liveTabId={null}
        active={false}
        agent="claude"
        liveElsewhere={false}
        {...handlers}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { ...view, ...handlers };
}

const savedSessions = useChatStore.getState().sessions;

function putTab(tabId: string, turnStartedAt: number | null) {
  useChatStore.setState((s) => {
    s.sessions[tabId] = {
      ...s.sessions[tabId],
      id: tabId,
      messages: [],
      status: turnStartedAt === null ? "idle" : "running",
      turnStartedAt,
    } as (typeof s.sessions)[string];
  });
}

beforeAll(() => {
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
});
afterAll(() => {
  vi.unstubAllGlobals();
});

describe("projectMonogram", () => {
  it("takes two letters of one word, or the initials of two", () => {
    expect(projectMonogram("atlas")).toBe("AT");
    expect(projectMonogram("northwind-shop")).toBe("NS");
    expect(projectMonogram("")).toBe("?");
  });
});

describe("formatWorkingDuration", () => {
  it("reads like the reference: seconds, minutes, then hours and minutes", () => {
    expect(formatWorkingDuration(45_000)).toBe("45s");
    expect(formatWorkingDuration(7 * 60_000 + 5_000)).toBe("7m");
    expect(formatWorkingDuration(65 * 60_000)).toBe("1h 5m");
    expect(formatWorkingDuration(120 * 60_000)).toBe("2h");
  });

  it("clamps zero and a clock that ran backwards to 0s", () => {
    expect(formatWorkingDuration(0)).toBe("0s");
    expect(formatWorkingDuration(-5_000)).toBe("0s");
  });
});

describe("SessionCard", () => {
  beforeEach(() => {
    invoke.mockImplementation(prsAnswer({ "0.4.0": PR }));
  });

  afterEach(() => {
    cleanup();
    invoke.mockReset();
    openUrl.mockClear();
    resetGhAvailabilityForTests();
    autoVisible = true;
    observed.length = 0;
    vi.useRealTimers();
    useChatStore.setState({ sessions: savedSessions });
  });

  it("shows the title, branch and the branch's pull request", async () => {
    renderCard();
    expect(screen.getByText("Add Model Picker Dropdown")).toBeTruthy();
    expect(screen.getByText("0.4.0")).toBeTruthy();
    expect(await screen.findByText("353")).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("git_repo_pull_requests", { path: "/repo/atlas" });
  });

  it("names the project only when the thread belongs to another one", () => {
    renderCard();
    expect(screen.queryByText("AT")).toBeNull();
    expect(screen.queryByText("atlas")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Add Model Picker Dropdown" })
        .getAttribute("aria-describedby"),
    ).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/atlas,/);
    cleanup();

    renderCard({ showProject: true });
    expect(screen.getByText("AT")).toBeTruthy();
    expect(screen.getByText("atlas")).toBeTruthy();
    expect(document.body.textContent).toMatch(/atlas, /);
  });

  it("marks a session another process is writing, for sight and for screen readers", () => {
    renderCard();
    expect(screen.queryByTestId("live-elsewhere-dot")).toBeNull();
    cleanup();
    renderCard({ liveElsewhere: true });
    expect(screen.getByTestId("live-elsewhere-dot")).toBeTruthy();
    expect(document.body.textContent).toMatch(/Active in another process/);
  });

  it("keeps the status on the title line when the project is not named", () => {
    renderCard({ status: "waiting" });
    const status = screen.getByText("Needs input");
    const titleRow = screen.getByText("Add Model Picker Dropdown").parentElement!;
    expect(titleRow.contains(status)).toBe(true);
  });

  it("asks once per repository, however many cards share it", async () => {
    invoke.mockImplementation(prsAnswer({ "0.4.0": PR, other: { ...PR, number: 9 } }));
    const client = new QueryClient();
    const noop = () => {};
    const card = (threadId: string, branch: string) => (
      <SessionCard
        key={threadId}
        threadId={threadId}
        title={threadId}
        projectName="atlas"
        showProject={false}
        branch={branch}
        cwd="/repo/atlas"
        lastUpdated={null}
        status={null}
        liveTabId={null}
        active={false}
        agent="claude"
        liveElsewhere={false}
        onOpen={noop}
        onArchive={noop}
        onDelete={noop}
      />
    );
    render(
      <QueryClientProvider client={client}>
        {card("a", "0.4.0")}
        {card("b", "other")}
        {card("c", "0.4.0")}
      </QueryClientProvider>,
    );
    expect(await screen.findAllByText("353")).toHaveLength(2);
    expect(screen.getByText("9")).toBeTruthy();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("asks for no pull request without a branch", () => {
    renderCard({ branch: null });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("asks nothing until the card has been on screen", async () => {
    autoVisible = false;
    renderCard();
    await act(async () => {});
    expect(invoke).not.toHaveBeenCalled();
    act(() => observed[0]!.fire());
    expect(await screen.findByText("353")).toBeTruthy();
  });

  it("shows no chip when the lookup rejects", async () => {
    invoke.mockImplementation(() => Promise.reject(new Error("boom")));
    renderCard();
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByRole("button", { name: /pull request/ })).toBeNull();
  });

  it("stops asking for the session once gh is unavailable", async () => {
    invoke.mockImplementation(() => Promise.resolve({ kind: "unavailable" }));
    renderCard();
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    cleanup();
    renderCard({ cwd: "/repo/other" });
    await act(async () => {});
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /pull request/ })).toBeNull();
  });

  it("shows nothing for a repository gh could not answer for", async () => {
    invoke.mockImplementation(() => Promise.resolve({ kind: "failed" }));
    renderCard();
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByRole("button", { name: /pull request/ })).toBeNull();
  });

  it.each([
    [{ state: "open", isDraft: true }, "Draft"],
    [{ state: "merged", isDraft: false }, "Merged"],
    [{ state: "closed", isDraft: false }, "Closed"],
    [{ state: "open", isDraft: false }, "Open"],
  ])("labels a %o pull request %s", async (patch, label) => {
    invoke.mockImplementation(prsAnswer({ "0.4.0": { ...PR, ...patch } }));
    renderCard();
    const chip = await screen.findByRole("button", {
      name: `${label} pull request #${PR.number}: Model picker — open on GitHub`,
    });
    expect(chip).toBeTruthy();
  });

  it("opens the pull request in the browser, not the thread", async () => {
    const { onOpen } = renderCard();
    fireEvent.click(
      await screen.findByRole("button", { name: new RegExp(`pull request #${PR.number}`) }),
    );
    expect(openUrl).toHaveBeenCalledWith(PR.url);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("opens the thread from its button by click, Enter and Space", async () => {
    const user = userEvent.setup();
    const { onOpen } = renderCard();
    const open = screen.getByRole("button", { name: "Add Model Picker Dropdown" });
    await user.click(open);
    open.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onOpen).toHaveBeenCalledTimes(3);
    expect(onOpen).toHaveBeenCalledWith("thread-1");
  });

  it("archives and deletes without opening", async () => {
    const user = userEvent.setup();
    const { onOpen, onArchive, onDelete } = renderCard();
    await user.click(screen.getByRole("button", { name: "Archive session" }));
    await user.click(screen.getByRole("button", { name: "Delete session" }));
    expect(onArchive).toHaveBeenCalledWith("thread-1");
    expect(onDelete).toHaveBeenCalledWith("thread-1");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("nests no control inside the open button", () => {
    renderCard();
    const open = screen.getByRole("button", { name: "Add Model Picker Dropdown" });
    expect(open.querySelector("button, a")).toBeNull();
  });

  it("times the running turn from the start the store stamped", () => {
    putTab("tab-live", Date.now() - 7 * 60_000 - 5_000);
    renderCard({ status: "running", liveTabId: "tab-live" });
    expect(screen.getByText("7m")).toBeTruthy();
  });

  it("ticks the timer on one shared clock, and stops it on unmount", () => {
    vi.useFakeTimers();
    putTab("tab-live", Date.now() - 55_000);
    const { unmount } = renderCard({ status: "running", liveTabId: "tab-live" });
    expect(screen.getByText("55s")).toBeTruthy();
    expect(isTickerRunning()).toBe(true);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByText("1m")).toBeTruthy();
    unmount();
    expect(isTickerRunning()).toBe(false);
  });

  it("says Working while the agent runs, without a time before the turn is stamped", () => {
    renderCard({ status: "running" });
    expect(screen.getByText(/Working/, { selector: ".text-info" })).toBeTruthy();
    expect(screen.queryByText(/\ds$/)).toBeNull();
  });

  it("says Needs input while it waits", () => {
    renderCard({ status: "waiting" });
    expect(screen.getByText("Needs input")).toBeTruthy();
    expect(screen.queryByText(/Working/)).toBeNull();
  });

  it("shows how long ago it was updated when idle", () => {
    renderCard({ lastUpdated: new Date(Date.now() - 3 * 60 * 60_000).toISOString() });
    expect(screen.queryByText(/Working|Needs input/)).toBeNull();
    const open = screen.getByRole("button", { name: "Add Model Picker Dropdown" });
    const description = document.getElementById(open.getAttribute("aria-describedby")!);
    expect(description?.textContent).toMatch(/^Updated .+, 0\.4\.0, /);
  });

  it("hides the working ring from assistive tech and stops it under reduced motion", () => {
    renderCard({ status: "running" });
    const ring = document.querySelector("svg.animate-spin");
    expect(ring?.getAttribute("aria-hidden")).toBe("true");
    expect(ring?.getAttribute("class")).toContain("motion-reduce:animate-none");
  });
});

describe("chat store turnStartedAt", () => {
  afterEach(() => {
    vi.useRealTimers();
    useChatStore.setState({ sessions: savedSessions });
  });

  it("is stamped once when a tab turns busy and cleared when it goes idle", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { createSession, updateSessionStatus } = useChatStore.getState().actions;
    createSession("tab-turn", "claude-code");
    expect(useChatStore.getState().sessions["tab-turn"]!.turnStartedAt ?? null).toBeNull();

    updateSessionStatus("tab-turn", "running");
    expect(useChatStore.getState().sessions["tab-turn"]!.turnStartedAt).toBe(1_000_000);

    // A pause for permission, and a resume of the same turn, keep the start.
    vi.setSystemTime(1_060_000);
    updateSessionStatus("tab-turn", "waiting");
    updateSessionStatus("tab-turn", "running");
    expect(useChatStore.getState().sessions["tab-turn"]!.turnStartedAt).toBe(1_000_000);

    updateSessionStatus("tab-turn", "idle");
    expect(useChatStore.getState().sessions["tab-turn"]!.turnStartedAt).toBeNull();

    vi.setSystemTime(2_000_000);
    updateSessionStatus("tab-turn", "running");
    expect(useChatStore.getState().sessions["tab-turn"]!.turnStartedAt).toBe(2_000_000);
  });
});
