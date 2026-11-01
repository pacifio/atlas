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
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

import { invoke } from "@tauri-apps/api/core";
import type { AgentDelta, Origin } from "@/types/agents";
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

// ── The knob cache the Options pill renders from on a cold start ─────────────
// The pill is always visible now, so what the cache holds decides whether a
// fresh launch shows the knobs, "Default", or a spinner. Two things were wrong:
// `claude-code` was excluded from caching entirely (an agent-identity branch —
// ADR-0002 — and the agent most people run), and an empty verdict was never
// stored, so "this agent has no knobs" had to be re-learned from a live session
// on every launch. That relearning IS the 3-4 second wait.

describe("the config-option cache the composer reads at boot (#36)", () => {
  beforeEach(() => {
    localStorage.clear();
    useChatStore.setState({ sessions: {}, activeSessionId: null });
  });

  const knob = {
    id: "thought",
    name: "Thinking",
    category: "thought_level",
    type: "select",
    currentValue: "high",
    options: [{ value: "high", name: "High" }],
  };

  it("caches for claude-code like every other agent", async () => {
    const { loadCachedAcpConfigOptions } = await import("../lib/acp-config-options-cache");
    boundSession();
    useChatStore.getState().actions.setAcpConfigOptions(TAB, [knob]);
    expect(loadCachedAcpConfigOptions("claude-code")).toEqual([knob]);
  });

  it("caches an empty verdict, so the next launch renders Default instead of a spinner", async () => {
    const { loadCachedAcpConfigOptions } = await import("../lib/acp-config-options-cache");
    boundSession();
    useChatStore.getState().actions.setAcpConfigOptions(TAB, []);
    expect(loadCachedAcpConfigOptions("claude-code")).toEqual([]);
  });

  it("an empty snapshot rejected by the guard does not erase the cached list", async () => {
    // The guard lives in the store, so the cache write has to follow what
    // LANDED rather than what was passed — otherwise a late empty snapshot
    // would blank the cache while leaving the live list on screen, and the
    // next launch would spin.
    const { loadCachedAcpConfigOptions } = await import("../lib/acp-config-options-cache");
    boundSession();
    useChatStore.getState().actions.setAcpConfigOptions(TAB, [knob]);
    useChatStore.getState().actions.setAcpConfigOptions(TAB, []);
    expect(loadCachedAcpConfigOptions("claude-code")).toEqual([knob]);
  });

  it("a stale snapshot from another agent never reaches this agent's cache", async () => {
    const { loadCachedAcpConfigOptions } = await import("../lib/acp-config-options-cache");
    boundSession();
    useChatStore.getState().actions.setAcpConfigOptions(TAB, [knob], "codex-acp");
    expect(loadCachedAcpConfigOptions("claude-code")).toBeNull();
    expect(loadCachedAcpConfigOptions("codex-acp")).toBeNull();
  });
});

// ── A model set through the host, by anyone ──────────────────────────────────
// The host announces every `set_model` through its steering entry as
// `model_changed` — this window's pick, or a remote driver's (Universal RC).
// The reducer used to ignore the kind for the native agent (a guard against
// the BYOK `provider/model` re-push loop), so a remote switch on a native
// session ran the next turn on a model the desktop pill did not show.

describe("model_changed on a native session", () => {
  const NATIVE_TAB = "tab-native";
  const NATIVE_SESSION = "native-session-1";

  function boundNative() {
    const { actions } = useChatStore.getState();
    actions.createSession(NATIVE_TAB, "atlas-agent");
    actions.setAcpBinding(NATIVE_TAB, "agent-native", NATIVE_SESSION, "/tmp");
    actions.setAcpModels(NATIVE_TAB, "sonnet", [
      { id: "sonnet", name: "Sonnet" },
      { id: "opus", name: "Opus" },
    ]);
    return () => useChatStore.getState().sessions[NATIVE_TAB];
  }

  function modelChanged(model_id: string, origin?: Origin): AgentDelta {
    return {
      kind: "model_changed",
      agent_id: "agent-native",
      session_id: NATIVE_SESSION,
      model_id,
      ...(origin ? { origin } : {}),
    } as AgentDelta;
  }

  beforeEach(() => {
    localStorage.clear();
    toastError.mockClear();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
    useChatStore.setState({ sessions: {}, activeSessionId: null });
  });

  it("follows a model a remote driver switched to, when the catalogue lists it", () => {
    const session = boundNative();
    expect(session().acpCurrentModel).toBe("sonnet");

    useChatStore
      .getState()
      .actions.applyAgentDelta(modelChanged("opus", { kind: "remote", id: "user-7", name: "Ada" }));

    expect(session().acpCurrentModel).toBe("opus");
  });

  /// The BYOK pills push `provider/model` with a bare id in the store; the
  /// echo of that push is the prefixed form, which the catalogue does not
  /// list. Taking it would re-prefix the value on every re-push.
  it("ignores an id the catalogue does not list", () => {
    const session = boundNative();

    useChatStore.getState().actions.applyAgentDelta(modelChanged("google/sonnet"));

    expect(session().acpCurrentModel).toBe("sonnet");
  });

  it("takes nothing while the catalogue is empty", () => {
    const { actions } = useChatStore.getState();
    actions.createSession(NATIVE_TAB, "atlas-agent");
    actions.setAcpBinding(NATIVE_TAB, "agent-native", NATIVE_SESSION, "/tmp");

    actions.applyAgentDelta(modelChanged("opus"));

    expect(useChatStore.getState().sessions[NATIVE_TAB].acpCurrentModel).toBeUndefined();
  });

  it("an ACP agent's model_changed is taken as before, listed or not", () => {
    const session = boundSession();

    useChatStore.getState().actions.applyAgentDelta({
      kind: "model_changed",
      agent_id: "agent-1",
      session_id: ACP_SESSION,
      model_id: "haiku",
    } as AgentDelta);

    expect(session().acpCurrentModel).toBe("haiku");
  });
});

// ── A refused pick rolls back and says why, like a mode's ───────────────────
// `setAcpModel` flips the pill optimistically and pushes `agents_set_model`.
// A refusal (the native selector's "not in the catalogue", an agent saying
// no) used to be only `console.warn`ed, so the pill kept showing a model the
// next turn would not run on. A remote picker is held to "revert and show the
// message"; the desktop matches.

describe("a refused model pick", () => {
  beforeEach(() => {
    localStorage.clear();
    toastError.mockClear();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
    useChatStore.setState({ sessions: {}, activeSessionId: null });
  });

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("reverts the pill to the previous model and toasts the agent's words", async () => {
    const session = boundSession();
    useChatStore.getState().actions.setAcpModels(TAB, "sonnet", [
      { id: "sonnet", name: "Sonnet" },
      { id: "opus", name: "Opus" },
    ]);
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "agents_set_model") throw "model 'opus' is not in the catalogue";
      return undefined;
    });

    useChatStore.getState().actions.setAcpModel(TAB, "opus");
    expect(session().acpCurrentModel, "optimistic flip").toBe("opus");
    await flush();

    expect(session().acpCurrentModel).toBe("sonnet");
    expect(toastError).toHaveBeenCalledWith("model 'opus' is not in the catalogue");
  });

  it("leaves a newer pick alone when an older one is refused late", async () => {
    const session = boundSession();
    useChatStore.getState().actions.setAcpModels(TAB, "sonnet", [
      { id: "sonnet", name: "Sonnet" },
      { id: "opus", name: "Opus" },
      { id: "haiku", name: "Haiku" },
    ]);
    let reject: (reason: unknown) => void = () => {};
    vi.mocked(invoke).mockImplementation((cmd, args) => {
      if (cmd === "agents_set_model" && (args as { modelId: string }).modelId === "opus") {
        return new Promise((_, r) => {
          reject = r;
        });
      }
      return Promise.resolve(undefined);
    });

    useChatStore.getState().actions.setAcpModel(TAB, "opus");
    useChatStore.getState().actions.setAcpModel(TAB, "haiku");
    reject("no");
    await flush();

    expect(session().acpCurrentModel).toBe("haiku");
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("a pick the agent accepts stays, with no toast", async () => {
    const session = boundSession();
    useChatStore.getState().actions.setAcpModels(TAB, "sonnet", [
      { id: "sonnet", name: "Sonnet" },
      { id: "opus", name: "Opus" },
    ]);

    useChatStore.getState().actions.setAcpModel(TAB, "opus");
    await flush();

    expect(session().acpCurrentModel).toBe("opus");
    expect(toastError).not.toHaveBeenCalled();
  });
});
