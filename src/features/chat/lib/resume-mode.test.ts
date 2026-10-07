// @vitest-environment happy-dom
//
// Resuming a session must put the AGENT into the mode the user picked, not
// just the picker. Both halves of issue 289's second bug live here: the mode being
// silently reset to Ask after a crash, and the picker showing one mode while
// the engine enforced another.

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

import type { SessionKey, SessionModeInfo, SessionSnapshot } from "@/types/agents";
import { NATIVE_AGENT_ID } from "@/types/agent";
import { useChatStore } from "../stores/chat-store";
import { loadLastModePref, saveLastModePref } from "./last-mode-pref";
import { applyModeOnResume, holdUnrestoredMode, resolveEffectiveMode } from "./resume-mode";

const TAB = "tab-1";
const KEY: SessionKey = { agent_id: "agent-1", session_id: "acp-1" };

const MODES: SessionModeInfo[] = [
  { id: "default", name: "Ask", description: "Prompt before edits and commands" },
  { id: "bypass", name: "Bypass", description: "Run everything without prompting" },
] as SessionModeInfo[];

function snapshot(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    agent_id: "agent-1",
    session_id: "acp-1",
    cwd: "/tmp/project",
    plugin_id: "codex",
    status: "idle",
    current_mode: "default",
    current_model: null,
    available_modes: MODES,
    available_models: [],
    available_commands: [],
    ...over,
  } as unknown as SessionSnapshot;
}

/** A tab on `codex`, seeded the way a real resume seeds it. */
function tabWithPref(pref: string | null) {
  if (pref) saveLastModePref("codex", pref);
  useChatStore.getState().actions.createSession(TAB, "codex");
}

function setModeCalls() {
  return invoke.mock.calls.filter((c) => c[0] === "agents_set_mode");
}

beforeEach(() => {
  localStorage.clear();
  invoke.mockClear();
  invoke.mockImplementation(async () => undefined);
  useChatStore.setState({
    sessions: {},
    pendingPermissions: {},
    queues: {},
    activeSessionId: null,
  });
});

describe("resolveEffectiveMode", () => {
  it("keeps an explicit pick the agent advertises", () => {
    expect(resolveEffectiveMode("bypass", "default", MODES)).toBe("bypass");
  });

  it("drops a pick the agent does not advertise, rather than sticking the picker on it", () => {
    expect(resolveEffectiveMode("yolo", "default", MODES)).toBe("default");
  });

  it("falls back to the agent's own mode when the user never picked one", () => {
    expect(resolveEffectiveMode(undefined, "default", MODES)).toBe("default");
  });

  it("trusts the pick when the agent advertises no modes at all", () => {
    expect(resolveEffectiveMode("bypass", null, [])).toBe("bypass");
  });
});

describe("applyModeOnResume", () => {
  it("restores the mode the user explicitly picked, Bypass included", async () => {
    tabWithPref("bypass");
    await applyModeOnResume(TAB, KEY, snapshot());

    expect(setModeCalls()).toHaveLength(1);
    expect(setModeCalls()[0]?.[1]).toMatchObject({ modeId: "bypass" });
    expect(useChatStore.getState().sessions[TAB]?.acpCurrentMode).toBe("bypass");
  });

  it("leaves the agent alone when the user never picked a mode", async () => {
    tabWithPref(null);
    await applyModeOnResume(TAB, KEY, snapshot());

    expect(setModeCalls()).toHaveLength(0);
    expect(useChatStore.getState().sessions[TAB]?.acpCurrentMode).toBe("default");
  });

  it("does not push a mode the agent already reports", async () => {
    tabWithPref("default");
    await applyModeOnResume(TAB, KEY, snapshot({ current_mode: "default" }));

    expect(setModeCalls()).toHaveLength(0);
  });

  it("drops a pick the agent no longer advertises and shows what it does have", async () => {
    tabWithPref("retired-mode");
    await applyModeOnResume(TAB, KEY, snapshot());

    expect(setModeCalls()).toHaveLength(0);
    expect(useChatStore.getState().sessions[TAB]?.acpCurrentMode).toBe("default");
  });

  it("shows the agent's mode, not the wanted one, when the agent refuses", async () => {
    tabWithPref("bypass");
    invoke.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === "agents_set_mode") throw new Error("busy");
      return undefined;
    });

    await applyModeOnResume(TAB, KEY, snapshot());

    expect(setModeCalls()).toHaveLength(1);
    expect(useChatStore.getState().sessions[TAB]?.acpCurrentMode).toBe("default");
  });
});

describe("applyModeOnResume: an agent that advertises no modes", () => {
  it("leaves the picker alone rather than blanking it", async () => {
    tabWithPref("bypass");
    const before = useChatStore.getState().sessions[TAB]?.acpCurrentMode;
    await applyModeOnResume(TAB, KEY, snapshot({ available_modes: [], current_mode: null }));

    // Nothing was advertised, so there was nothing to validate against and
    // nothing to seed from. The stored pick still stands.
    expect(useChatStore.getState().sessions[TAB]?.acpCurrentMode).toBe(before);
  });
});

// Issue 317. After a restart every chat tab starts on the native agent, so
// resuming a Codex thread RELABELS the tab (`setSessionAgentType`) before the
// load. The relabel dropped the explicit flag and never restored the saved
// pick, so `applyModeOnResume` saw "no pick" and adopted whatever Codex
// reported on `session/load` — a more permissive mode than the user chose,
// while the saved preference still said the restrictive one.
describe("applyModeOnResume: issue 317, resume after a restart", () => {
  const CODEX_MODES: SessionModeInfo[] = [
    { id: "read-only", name: "Ask for approval", description: "Ask before acting" },
    { id: "auto", name: "Approve for me", description: "Act without asking" },
  ] as SessionModeInfo[];
  const codexSnapshot = (over: Partial<SessionSnapshot> = {}) =>
    snapshot({ current_mode: "auto", available_modes: CODEX_MODES, ...over });

  /** The tab a fresh launch gives you, then the relabel the resume does. */
  function restartedTabResuming(agentType: "codex" | "claude-code") {
    // A restart keeps no tab state, only the saved pick.
    useChatStore.setState({ sessions: {} });
    useChatStore.getState().actions.createSession(TAB, NATIVE_AGENT_ID);
    useChatStore.getState().actions.setSessionAgentType(TAB, agentType);
  }

  it("keeps the saved pick when the tab was on another agent before the resume", async () => {
    saveLastModePref("codex", "read-only");
    restartedTabResuming("codex");

    // The picker is right before the load even lands.
    expect(useChatStore.getState().sessions[TAB]?.acpCurrentMode).toBe("read-only");
    expect(useChatStore.getState().sessions[TAB]?.acpModeExplicit).toBe(true);

    await applyModeOnResume(TAB, KEY, codexSnapshot());

    expect(setModeCalls()).toHaveLength(1);
    expect(setModeCalls()[0]?.[1]).toMatchObject({ modeId: "read-only" });
    expect(useChatStore.getState().sessions[TAB]?.acpCurrentMode).toBe("read-only");
    expect(useChatStore.getState().sessions[TAB]?.unrestoredModeId).toBeUndefined();
  });

  it("restores Claude's saved pick on the same relabel", async () => {
    saveLastModePref("claude-code", "plan");
    restartedTabResuming("claude-code");

    await applyModeOnResume(
      TAB,
      KEY,
      snapshot({
        plugin_id: "claude-code",
        current_mode: "bypassPermissions",
        available_modes: [
          { id: "plan", name: "Plan" },
          { id: "bypassPermissions", name: "Bypass" },
        ] as SessionModeInfo[],
      }),
    );

    expect(setModeCalls()[0]?.[1]).toMatchObject({ modeId: "plan" });
    expect(useChatStore.getState().sessions[TAB]?.claudePermissionMode).toBe("plan");
  });

  it("restores the saved pick even when the tab carries none", async () => {
    // Belt and braces for any path that reaches here without the store
    // having restored the pick: the saved preference is the user's word.
    useChatStore.getState().actions.createSession(TAB, "codex");
    saveLastModePref("codex", "read-only");

    await applyModeOnResume(TAB, KEY, codexSnapshot());

    expect(setModeCalls()[0]?.[1]).toMatchObject({ modeId: "read-only" });
    expect(useChatStore.getState().sessions[TAB]?.acpCurrentMode).toBe("read-only");
  });

  it("says so when the agent refuses the pick, and never adopts its mode as the pick", async () => {
    saveLastModePref("codex", "read-only");
    restartedTabResuming("codex");
    invoke.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === "agents_set_mode") throw new Error("busy");
      return undefined;
    });

    await applyModeOnResume(TAB, KEY, codexSnapshot());

    // The picker shows what the agent really has, the composer says the pick
    // was not restored, and the saved pick is kept for the next try.
    expect(useChatStore.getState().sessions[TAB]?.acpCurrentMode).toBe("auto");
    expect(useChatStore.getState().sessions[TAB]?.unrestoredModeId).toBe("read-only");
    expect(loadLastModePref("codex")).toBe("read-only");
    // What the picker was left showing is the agent's mode, not a pick.
    expect(useChatStore.getState().sessions[TAB]?.acpModeExplicit).toBe(false);

    // The next resume in the same tab tries the user's pick again, instead of
    // treating the agent's mode it was left showing as something they chose.
    invoke.mockClear();
    invoke.mockImplementation(async () => undefined);
    await applyModeOnResume(TAB, KEY, codexSnapshot());

    expect(setModeCalls()).toHaveLength(1);
    expect(setModeCalls()[0]?.[1]).toMatchObject({ modeId: "read-only" });
    expect(useChatStore.getState().sessions[TAB]?.acpCurrentMode).toBe("read-only");
    // And the bar goes once the pick is back.
    expect(useChatStore.getState().sessions[TAB]?.unrestoredModeId).toBeUndefined();
  });

  it("says so once, and forgets the saved pick, when the agent no longer offers it", async () => {
    saveLastModePref("codex", "read-only");
    restartedTabResuming("codex");
    // An agent update renamed its modes: "read-only" is gone.
    const renamed = codexSnapshot({
      available_modes: CODEX_MODES.filter((m) => m.id !== "read-only"),
    });

    await applyModeOnResume(TAB, KEY, renamed);

    expect(setModeCalls()).toHaveLength(0);
    expect(useChatStore.getState().sessions[TAB]?.acpCurrentMode).toBe("auto");
    expect(useChatStore.getState().sessions[TAB]?.unrestoredModeId).toBe("read-only");
    expect(loadLastModePref("codex")).toBeNull();

    // After the next restart there is nothing stale left to restore, so
    // nothing to warn about: it defers to the agent, as a session with no
    // pick always has.
    restartedTabResuming("codex");
    await applyModeOnResume(TAB, KEY, renamed);

    expect(setModeCalls()).toHaveLength(0);
    expect(useChatStore.getState().sessions[TAB]?.unrestoredModeId).toBeUndefined();
  });

  it("keeps saying so, every resume, while the agent refuses a pick it offers", async () => {
    saveLastModePref("codex", "read-only");
    restartedTabResuming("codex");
    invoke.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === "agents_set_mode") throw new Error("busy");
      return undefined;
    });

    await applyModeOnResume(TAB, KEY, codexSnapshot());
    restartedTabResuming("codex");
    await applyModeOnResume(TAB, KEY, codexSnapshot());

    expect(setModeCalls()).toHaveLength(2);
    expect(useChatStore.getState().sessions[TAB]?.unrestoredModeId).toBe("read-only");
    expect(loadLastModePref("codex")).toBe("read-only");
  });

  it("keeps the composer bar until the user picks a mode", async () => {
    saveLastModePref("codex", "read-only");
    restartedTabResuming("codex");
    invoke.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === "agents_set_mode") throw new Error("busy");
      return undefined;
    });
    await applyModeOnResume(TAB, KEY, codexSnapshot());
    expect(useChatStore.getState().sessions[TAB]?.unrestoredModeId).toBe("read-only");

    // Nothing but a pick clears it. Picking the mode the chat is already in
    // counts: it is a choice now, not the agent's default.
    useChatStore.getState().actions.setAcpMode(TAB, "auto");
    expect(useChatStore.getState().sessions[TAB]?.unrestoredModeId).toBeUndefined();
  });
});

// The saved pick is per agent TYPE, so it holds whichever tab picked last.
// Preferring it over a tab's own pick let one tab silently override another's
// when an agent restart rebinds the tabs (`respawnAndRebind` in chat-panel).
describe("applyModeOnResume: two tabs on the same agent", () => {
  const CODEX_MODES: SessionModeInfo[] = [
    { id: "read-only", name: "Read Only" },
    { id: "full-access", name: "Full Access" },
  ] as SessionModeInfo[];

  it("resumes each tab in its own pick, not the one another tab saved last", async () => {
    const { createSession, setAcpModes, setAcpMode } = useChatStore.getState().actions;
    for (const tab of ["tab-a", "tab-b"]) {
      createSession(tab, "codex");
      setAcpModes(tab, "read-only", CODEX_MODES, "codex");
    }
    setAcpMode("tab-a", "read-only");
    setAcpMode("tab-b", "full-access");
    expect(loadLastModePref("codex")).toBe("full-access");
    invoke.mockClear();

    // Codex restarts; the rebind resumes tab A, which the agent reports in
    // its own default.
    const snap = snapshot({ current_mode: "full-access", available_modes: CODEX_MODES });
    await applyModeOnResume("tab-a", KEY, snap);

    expect(setModeCalls()).toHaveLength(1);
    expect(setModeCalls()[0]?.[1]).toMatchObject({ modeId: "read-only" });
    expect(useChatStore.getState().sessions["tab-a"]?.acpCurrentMode).toBe("read-only");
    expect(useChatStore.getState().sessions["tab-a"]?.unrestoredModeId).toBeUndefined();

    // And tab B, resumed after it, keeps ITS pick.
    invoke.mockClear();
    await applyModeOnResume("tab-b", KEY, { ...snap, current_mode: "read-only" });

    expect(setModeCalls()[0]?.[1]).toMatchObject({ modeId: "full-access" });
    expect(useChatStore.getState().sessions["tab-b"]?.acpCurrentMode).toBe("full-access");
  });
});

// A tab whose pick could not be applied keeps asking for THAT pick. Falling
// back to the saved pick would hand it whatever another tab picked last.
describe("applyModeOnResume: a dropped pick stays the tab's own", () => {
  const CODEX_MODES: SessionModeInfo[] = [
    { id: "read-only", name: "Read Only" },
    { id: "full-access", name: "Full Access" },
  ] as SessionModeInfo[];
  const snap = snapshot({ current_mode: "full-access", available_modes: CODEX_MODES });

  it("does not resume into another tab's saved pick after a refusal", async () => {
    const { createSession, setAcpModes, setAcpMode } = useChatStore.getState().actions;
    for (const tab of ["tab-a", "tab-b"]) {
      createSession(tab, "codex");
      setAcpModes(tab, "read-only", CODEX_MODES, "codex");
    }
    setAcpMode("tab-a", "read-only");
    setAcpMode("tab-b", "full-access");
    invoke.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === "agents_set_mode") throw new Error("busy");
      return undefined;
    });
    await applyModeOnResume("tab-a", KEY, snap);
    expect(useChatStore.getState().sessions["tab-a"]?.unrestoredModeId).toBe("read-only");

    // The next resume of tab A asks for read-only again, not tab B's
    // full-access, and the bar stays until it is restored.
    invoke.mockClear();
    invoke.mockImplementation(async () => undefined);
    await applyModeOnResume("tab-a", KEY, snap);

    expect(setModeCalls()[0]?.[1]).toMatchObject({ modeId: "read-only" });
    expect(useChatStore.getState().sessions["tab-a"]?.acpCurrentMode).toBe("read-only");
    expect(useChatStore.getState().sessions["tab-a"]?.unrestoredModeId).toBeUndefined();
  });

  it("forgets a stale saved pick only when this resume asked for it", async () => {
    const { createSession, setAcpModes, setAcpMode } = useChatStore.getState().actions;
    createSession(TAB, "codex");
    setAcpModes(TAB, "full-access", CODEX_MODES, "codex");
    setAcpMode(TAB, "full-access");
    // Another tab saved a pick this session's mode list does not carry.
    saveLastModePref("codex", "workspace-write");

    await applyModeOnResume(TAB, KEY, snap);

    expect(loadLastModePref("codex")).toBe("workspace-write");
    expect(useChatStore.getState().sessions[TAB]?.unrestoredModeId).toBeUndefined();
  });

  it("holds sends when the snapshot never arrived to apply the pick", () => {
    saveLastModePref("codex", "read-only");
    useChatStore.getState().actions.createSession(TAB, NATIVE_AGENT_ID);
    useChatStore.getState().actions.setSessionAgentType(TAB, "codex");

    holdUnrestoredMode(TAB);

    expect(useChatStore.getState().sessions[TAB]?.unrestoredModeId).toBe("read-only");
  });

  it("holds nothing when the user never picked", () => {
    useChatStore.getState().actions.createSession(TAB, "codex");
    holdUnrestoredMode(TAB);
    expect(useChatStore.getState().sessions[TAB]?.unrestoredModeId).toBeUndefined();
  });
});
