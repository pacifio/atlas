// @vitest-environment happy-dom
// Activity's "Why did you learn this?": asked of the session that wrote the
// line. The event log names a session by the agent session id it was sent
// on (`agents_send` registers that id for capture), which is the chat tab's
// `acpSessionId`; an open tab with that id is the target, else a new session.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryActivity } from "./memory-activity";
import { useSharedMemoryStore } from "../stores/shared-memory-store";
import { useAskAgentStore } from "@/features/ask-agent/stores/ask-agent-store";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import type { MemoryEvent } from "../lib/shared-memory-api";

const ACP = "0193f0dd-4444-7000-9000-dddddddddddd";

function event(seq: number, sessionId: string, text: string): MemoryEvent {
  return {
    seq,
    ts: Date.now() - seq * 60_000,
    agent: "claude",
    sessionId,
    kind: "decision",
    key: `k${seq}`,
    payload: { text },
  };
}

beforeEach(() => {
  useLayoutStore.setState(useLayoutStore.getInitialState(), true);
  useLayoutStore.getState().actions.addTab({
    id: "chat-a",
    type: "chat",
    title: "A",
    closable: true,
    dirty: false,
    data: {},
  });
  useChatStore.getState().actions.createSession("chat-a");
  useChatStore.setState((s) => {
    s.sessions["chat-a"].acpSessionId = ACP;
  });
  useSharedMemoryStore.setState({
    projectPath: "/repo",
    loaded: true,
    error: null,
    entries: [],
    events: [event(1, ACP, "Use Postgres"), event(2, "elsewhere", "Keep retries")],
  });
});
afterEach(() => {
  cleanup();
  useAskAgentStore.setState({ request: null });
});

describe("Why did you learn this?", () => {
  it("asks the open session that wrote the line", async () => {
    const user = userEvent.setup();
    render(<MemoryActivity onAsk={() => {}} />);
    await user.click(screen.getByRole("button", { name: /Why did you learn this: decided Use/ }));
    const request = useAskAgentStore.getState().request;
    expect(request?.target).toBe("chat-a");
    expect(request?.prompt).toBe("Why did you learn this? ");
  });

  it("asks a new session, with the provenance, when the writer is not open", async () => {
    const user = userEvent.setup();
    render(<MemoryActivity onAsk={() => {}} />);
    await user.click(screen.getByRole("button", { name: /Why did you learn this: decided Keep/ }));
    const request = useAskAgentStore.getState().request;
    expect(request?.target).toBe("new");
    const provenance = request?.context[request.context.length - 1];
    expect(provenance?.kind === "quote" && provenance.text).toContain("Session: elsewhere");
  });
});
