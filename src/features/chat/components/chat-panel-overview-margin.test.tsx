// @vitest-environment happy-dom
//
// The composer reserves the overview rail's width so it stays centred under
// the thread rather than under thread-plus-rail. The reserve has to track
// whether the rail is DRAWN: "new agent" reuses the tab, keeping its rail
// open flag while clearing the thread, and a reserve made against a rail that
// was not there pushed the welcome screen's composer half a rail left of
// everything else. The welcome screen draws the rail now (its toggle sits in
// the welcome screen's header), so the reserve applies there too — and only
// the flag decides.
//
// The panel's children are stubbed: what is under test is the composer
// stack's margin, not anything they render.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
vi.mock("../lib/agents-api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/agents-api")>();
  const agents = new Proxy({}, { get: () => vi.fn(async () => ({})) });
  return { ...real, agents, ensureAgent: vi.fn(async () => ({})), resetAgent: vi.fn() };
});
const Null = vi.hoisted(() => () => null);
vi.mock("./message-input", () => ({ MessageInput: Null }));
vi.mock("./session-sidebar", () => ({ SessionSidebar: Null }));
vi.mock("./chat-header", () => ({ ChatHeader: Null }));
vi.mock("./agent-update-bar", () => ({ AgentUpdateBar: Null }));
vi.mock("./permission-modal", () => ({ PermissionModal: Null }));
vi.mock("./chat-comments-controller", () => ({ ChatCommentsController: Null }));
vi.mock("./session-elicitation", () => ({ SessionElicitation: Null }));
vi.mock("./transcript", () => ({ Transcript: Null }));
vi.mock("./thread-overview-panel", () => ({ ThreadOverviewPanel: Null }));

import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useChatStore } from "../stores/chat-store";
import { useThreadOverviewStore } from "../stores/thread-overview-store";
import { ChatPanel } from "./chat-panel";

const TAB = "tab-1";

beforeEach(() => {
  localStorage.clear();
  useChatStore.setState({
    sessions: {},
    pendingPermissions: {},
    queues: {},
    drafts: {},
    activeSessionId: null,
  });
  useChatStore.getState().actions.createSession(TAB, "claude-code");
  useThreadOverviewStore.setState({ open: { [TAB]: true }, width: 300 });
});
afterEach(cleanup);

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ChatPanel tabId={TAB} />
    </QueryClientProvider>,
  );
}

/** The `marginRight` React was asked to render anywhere under `root`. Read
 *  from the element's React props, not its DOM style: happy-dom drops a
 *  `min(...)` value on assignment, so the style attribute is empty either way. */
const reserved = (root: HTMLElement): string | undefined => {
  for (const el of root.querySelectorAll("*")) {
    const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
    const style = key
      ? (el as unknown as Record<string, { style?: { marginRight?: string } }>)[key]?.style
      : undefined;
    if (style?.marginRight) return style.marginRight;
  }
  return undefined;
};

describe("composer margin for the overview rail", () => {
  it("reserves the rail's width while the rail is showing beside a thread", () => {
    useChatStore.setState((s) => {
      s.sessions[TAB].messages = [
        { id: "m1", role: "user", content: "hi", timestamp: 0 },
      ] as unknown as (typeof s.sessions)[typeof TAB]["messages"];
    });

    const { container } = mount();

    expect(reserved(container)).toBe("min(300px, 50%)");
  });

  it("reserves the rail's width on the welcome screen too, where the rail is drawn beside it", () => {
    const { container } = mount();

    expect(reserved(container)).toBe("min(300px, 50%)");
  });

  it("reserves nothing while the rail is closed", () => {
    useThreadOverviewStore.setState({ open: {}, width: 300 });

    const { container } = mount();

    expect(reserved(container)).toBeUndefined();
  });
});
