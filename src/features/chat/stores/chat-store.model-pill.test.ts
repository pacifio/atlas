// @vitest-environment happy-dom
//
// The store half of the model pill (issue #22).
//
// The pure projections are covered in `../lib/acp-config-options.test.ts`; what
// this pins is the wiring between them and the state the composer reads. The
// `config_options_updated` delta is the LIVE path — the snapshot only runs at
// bind time, so without this a model changed inside the agent (its own
// `/model`) never moved the pill, and a session bound before the agent
// advertised its models kept the pill hidden for the rest of its life.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

import type { AgentDelta } from "@/types/agents";
import { useChatStore } from "./chat-store";

const TAB = "tab-1";
const ACP_SESSION = "acp-session-1";

/** The wire shape: the kind is FLATTENED onto the option under `type`, and a
 *  choice's id is `value`. Anything else is a shape ACP does not send. */
function modelOption(currentValue: string) {
  return {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue,
    options: [
      { value: "sonnet", name: "Sonnet" },
      { value: "opus", name: "Opus" },
    ],
  };
}

function configOptionsDelta(config_options: unknown[]): AgentDelta {
  return {
    kind: "config_options_updated",
    session_id: ACP_SESSION,
    config_options,
  } as AgentDelta;
}

function boundSession() {
  const { actions } = useChatStore.getState();
  actions.createSession(TAB, "claude-code");
  actions.setAcpBinding(TAB, "agent-1", ACP_SESSION, "/tmp");
  return () => useChatStore.getState().sessions[TAB];
}

describe("the config-option knobs' snapshot path (#32)", () => {
  beforeEach(() => {
    localStorage.clear();
    useChatStore.setState({ sessions: {}, activeSessionId: null });
  });

  /// 3-A: options advertised at `session/new` reach the frontend only through
  /// the snapshot — an agent that never volunteers a `config_option_update`
  /// notification otherwise has NO knobs, ever. The snapshot consumers apply
  /// this the same way they apply models.
  it("applies the snapshot's config options", () => {
    const session = boundSession();
    expect(session().acpConfigOptions).toBeUndefined();

    useChatStore.getState().actions.setAcpConfigOptions(TAB, [
      {
        id: "thought",
        name: "Thinking",
        category: "thought_level",
        type: "select",
        currentValue: "high",
        options: [{ value: "high", name: "High" }],
      },
    ]);

    expect(session().acpConfigOptions).toHaveLength(1);
  });

  /// The same guard the commands list has: an empty snapshot must not erase a
  /// list the live delta already delivered, but MAY end the undefined loading
  /// state for an agent that genuinely advertises nothing.
  it("does not blank delta-delivered options with an empty snapshot", () => {
    const session = boundSession();
    useChatStore.getState().actions.applyAgentDelta({
      kind: "config_options_updated",
      session_id: ACP_SESSION,
      config_options: [{ id: "web", name: "Web search", type: "boolean", currentValue: true }],
    } as AgentDelta);

    useChatStore.getState().actions.setAcpConfigOptions(TAB, []);
    expect(session().acpConfigOptions).toHaveLength(1);

    // But undefined -> [] is a real answer: this agent has no knobs.
    useChatStore.getState().actions.createSession("tab-2", "claude-code");
    useChatStore.getState().actions.setAcpConfigOptions("tab-2", []);
    expect(useChatStore.getState().sessions["tab-2"].acpConfigOptions).toEqual([]);
  });
});

describe("the model pill's live path", () => {
  beforeEach(() => {
    localStorage.clear();
    useChatStore.setState({ sessions: {}, activeSessionId: null });
  });

  it("fills the picker from a model-category select on the config-options delta", () => {
    const session = boundSession();
    expect(session().acpAvailableModels ?? []).toEqual([]);

    useChatStore.getState().actions.applyAgentDelta(configOptionsDelta([modelOption("sonnet")]));

    expect(session().acpAvailableModels).toEqual([
      { id: "sonnet", name: "Sonnet", description: undefined },
      { id: "opus", name: "Opus", description: undefined },
    ]);
    expect(session().acpCurrentModel).toBe("sonnet");
  });

  /// A model changed INSIDE the agent arrives as this delta and nothing else —
  /// the pill has to follow it or it shows a model the agent is not using.
  it("follows a model the agent switched to on its own", () => {
    const session = boundSession();
    const { applyAgentDelta } = useChatStore.getState().actions;

    applyAgentDelta(configOptionsDelta([modelOption("sonnet")]));
    applyAgentDelta(configOptionsDelta([modelOption("opus")]));

    expect(session().acpCurrentModel).toBe("opus");
  });

  /// The pill hides on an empty list, so a delta carrying no model select must
  /// not blank a list the snapshot already delivered. Same invariant
  /// `setAcpModels` enforces for empty snapshots.
  it("does not blank a known list when a delta carries no model select", () => {
    const session = boundSession();
    const { applyAgentDelta } = useChatStore.getState().actions;

    applyAgentDelta(configOptionsDelta([modelOption("sonnet")]));
    applyAgentDelta(
      configOptionsDelta([
        { id: "web", name: "Web search", category: "_custom", type: "boolean", currentValue: true },
      ]),
    );

    expect(session().acpAvailableModels).toHaveLength(2);
    expect(session().acpCurrentModel).toBe("sonnet");
    // The other knob still lands — it is the model list that is protected.
    expect(session().acpConfigOptions).toHaveLength(1);
  });

  /// The cache is keyed by AGENT, so it may only hold what is true of the
  /// agent: the list. Caching the current model there made a `/model` in one
  /// chat relabel every later chat on that agent — and `setAcpModels` only
  /// seeds a current model when none is set, so the new session's own snapshot
  /// could never correct it.
  it("does not carry one session's model choice into the next session", () => {
    const first = boundSession();
    useChatStore.getState().actions.applyAgentDelta(configOptionsDelta([modelOption("opus")]));
    expect(first().acpCurrentModel).toBe("opus");

    useChatStore.getState().actions.createSession("tab-2", "claude-code");
    const second = useChatStore.getState().sessions["tab-2"];

    expect(second.acpCurrentModel).toBeUndefined();
    expect(
      second.acpAvailableModels,
      "the LIST is agent-wide and should still pre-fill",
    ).toHaveLength(2);
  });

  /// Gating is on the advertised category, never on which agent this is
  /// (ADR-0002): an agent offering no model select gets no models, so the pill
  /// stays hidden rather than rendering empty.
  it("leaves the picker empty for an agent that advertises no model select", () => {
    const session = boundSession();

    useChatStore.getState().actions.applyAgentDelta(
      configOptionsDelta([
        {
          id: "t",
          name: "Thinking",
          category: "thought_level",
          type: "boolean",
          currentValue: true,
        },
      ]),
    );

    expect(session().acpAvailableModels ?? []).toEqual([]);
    expect(session().acpCurrentModel).toBeUndefined();
  });
});
