// @vitest-environment happy-dom
//
// Subagents in the store: the `subagent_upserted` delta, the snapshot re-seed,
// and the two places the set has to be dropped.
//
// A child is not like a plan. The plan is per-turn and the dock shows the live
// one; a child belongs to the MESSAGE that launched it and stays readable in
// the transcript after its turn ends — so "clear at turn start" would be wrong
// here and "never clear" would leak the previous binding's children into a
// resumed chat. Both halves of that are asserted below, because neither fails
// anywhere else: a leaked child renders as a plausible row.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

import type { AgentDelta } from "@/types/agents";
import type { Subagent } from "@/types/agent";
import { orderedSubagents } from "../lib/subagents";
import { useChatStore } from "./chat-store";

const TAB = "tab-1";
const AGENT = "agent-1";
const ACP = "acp-session-1";

function child(over: Partial<Subagent> & Pick<Subagent, "toolCallId">): Subagent {
  return {
    messageId: "m1",
    name: "counter",
    status: "running",
    toolCallCount: 0,
    startedAtMs: 1000,
    ...over,
  };
}

function upsert(subagent: Subagent): AgentDelta {
  return {
    kind: "subagent_upserted",
    agent_id: AGENT,
    session_id: ACP,
    subagent,
  } as unknown as AgentDelta;
}

const apply = (...deltas: AgentDelta[]) => {
  for (const delta of deltas) useChatStore.getState().actions.applyAgentDelta(delta);
};
const subagents = () => useChatStore.getState().sessions[TAB]?.subagents;
const ordered = () => orderedSubagents(subagents());

function boundTab() {
  const { actions } = useChatStore.getState();
  actions.createSession(TAB, "atlas-agent");
  actions.setAcpBinding(TAB, AGENT, ACP, "/tmp/project");
  actions.addMessage(TAB, "user", "delegate two tasks");
}

beforeEach(() => {
  localStorage.clear();
  useChatStore.setState({
    sessions: {},
    pendingPermissions: {},
    queues: {},
    activeSessionId: null,
  });
  boundTab();
});

describe("subagent_upserted", () => {
  it("keys on the launching call, so an update replaces rather than duplicates", () => {
    // The projector re-derives the whole set on every thread change and ships
    // whole records; a row that duplicated on each update would multiply with
    // every tool call its child makes.
    apply(upsert(child({ toolCallId: "task-a" })));
    apply(upsert(child({ toolCallId: "task-a", status: "completed", toolCallCount: 4 })));
    expect(ordered()).toHaveLength(1);
    expect(ordered()[0]).toMatchObject({ status: "completed", toolCallCount: 4 });
  });

  it("keeps several children apart and reads back in launch order", () => {
    apply(
      upsert(child({ toolCallId: "task-b", name: "greeter", startedAtMs: 2000 })),
      upsert(child({ toolCallId: "task-a", startedAtMs: 1000 })),
    );
    expect(ordered().map((s) => s.name)).toEqual(["counter", "greeter"]);
  });

  it("survives the end of the turn that spawned it", () => {
    // A child belongs to its launching message. `livePlan` is cleared when a
    // new turn starts; doing the same here would erase the record of work the
    // transcript still shows.
    apply(upsert(child({ toolCallId: "task-a", status: "completed" })));
    useChatStore.getState().actions.applyAgentDelta({
      kind: "status",
      agent_id: AGENT,
      session_id: ACP,
      status: "running",
      turn_seq: 9,
    } as unknown as AgentDelta);
    expect(ordered()).toHaveLength(1);
  });
});

describe("the set is dropped with the transcript it belongs to", () => {
  it("goes when the tab is cleared for a new chat", () => {
    apply(upsert(child({ toolCallId: "task-a" })));
    useChatStore.getState().actions.clearSession(TAB);
    expect(subagents()).toBeUndefined();
  });

  it("goes when the tab rebinds onto a different backend session", () => {
    // Otherwise a resumed chat shows the previous binding's children until its
    // own first delta — and a finished child never produces one.
    apply(upsert(child({ toolCallId: "task-a" })));
    useChatStore.getState().actions.setAcpBinding(TAB, AGENT, "acp-session-2", "/tmp/project");
    expect(subagents()).toBeUndefined();
  });

  it("stays when the tab rebinds onto the SAME backend session", () => {
    apply(upsert(child({ toolCallId: "task-a" })));
    useChatStore.getState().actions.setAcpBinding(TAB, AGENT, ACP, "/tmp/project");
    expect(ordered()).toHaveLength(1);
  });
});

describe("hydrateSessionSnapshot", () => {
  it("re-seeds the children a resumed session already had", () => {
    // The rebind above cleared them and live deltas only describe changes from
    // here, so without this a resumed chat's delegated work renders as bare
    // tool calls.
    useChatStore
      .getState()
      .actions.hydrateSessionSnapshot(
        TAB,
        "idle",
        [],
        [
          child({ toolCallId: "task-a", status: "completed", startedAtMs: 1 }),
          child({ toolCallId: "task-b", name: "greeter", status: "interrupted", startedAtMs: 2 }),
        ],
      );
    expect(ordered().map((s) => s.status)).toEqual(["completed", "interrupted"]);
  });

  it("clears what the rebind left when the snapshot has none", () => {
    apply(upsert(child({ toolCallId: "stale" })));
    useChatStore.getState().actions.hydrateSessionSnapshot(TAB, "idle", [], []);
    expect(subagents()).toBeUndefined();
  });

  it("is a no-op on the metadata-only read, which carries no children", () => {
    // `agents_snapshot_meta` omits `subagents` like it omits `messages`;
    // treating absent as empty would wipe a live session's children on a
    // metadata refresh.
    apply(upsert(child({ toolCallId: "task-a" })));
    useChatStore.getState().actions.hydrateSessionSnapshot(TAB, "running", []);
    expect(ordered()).toHaveLength(1);
  });
});
