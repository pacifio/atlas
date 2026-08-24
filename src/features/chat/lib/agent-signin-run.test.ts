// Waiting for a login subprocess to finish (part of #23's blast radius).
//
// Two things have to hold and neither did: the completion listener must be
// armed before the process can exit, and it must resolve only for ITS run.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: Object.assign(() => {}, {
    error: () => {},
    success: () => {},
    loading: () => {},
    dismiss: () => {},
  }),
}));
vi.mock("@/features/agents/lib/agent-meta", () => ({
  agentMeta: (id: string) => ({ label: id }),
  catalogEntry: () => null,
}));

interface DoneEvent {
  success: boolean;
  exitCode: number | null;
  message: string | null;
  agentId: string;
  runId: string;
}

/** A stand-in for the Tauri event bus, with the two properties that matter:
 *  registration is ASYNC, and an event fired while nobody is registered is
 *  simply lost — exactly what the real IPC does. */
const bus = {
  handlers: new Set<(p: DoneEvent) => void>(),
  /** Resolves on a later tick, like a real `listen()` IPC round trip. */
  listen(handler: (p: DoneEvent) => void): Promise<() => void> {
    return new Promise((resolve) => {
      setTimeout(() => {
        bus.handlers.add(handler);
        resolve(() => bus.handlers.delete(handler));
      }, 0);
    });
  },
  emit(p: DoneEvent) {
    for (const handler of bus.handlers) handler(p);
  },
};

/** What `runAuthMethod` does: spawn, and let the process finish whenever. */
let onRun: (runId: string) => void = () => {};
let nextRunId = "run-1";

vi.mock("./agents-api", () => ({
  agents: {
    runAuthMethod: async () => {
      const runId = nextRunId;
      onRun(runId);
      return runId;
    },
    authenticate: async () => {},
  },
  ensureAgent: () => {},
  listenAuthRunDone: (handler: (p: DoneEvent) => void) => bus.listen(handler),
}));

const { runSignInMethod } = await import("./agent-signin");

function done(runId: string, over: Partial<DoneEvent> = {}): DoneEvent {
  return {
    success: true,
    exitCode: 0,
    message: null,
    agentId: "cursor",
    runId,
    ...over,
  };
}

beforeEach(() => {
  bus.handlers.clear();
  onRun = () => {};
  nextRunId = "run-1";
});

describe("waiting for a login subprocess", () => {
  /// The regression. A login that hands off to a browser can exit in the window
  /// between spawning it and the listener being registered — so the completion
  /// fires into an empty room and sign-in waits out its whole timeout.
  it("does not miss a login that exits the instant it is spawned", async () => {
    onRun = (runId) => bus.emit(done(runId));

    await expect(
      runSignInMethod("cursor", { id: "login", terminalCommand: "cursor-agent login" }, "Cursor"),
    ).resolves.toBeUndefined();
  });

  /// The `runId` exists precisely so two agents signing in at once cannot
  /// resolve each other's wait — but nothing was passing it.
  it("ignores a completion belonging to another run", async () => {
    onRun = () => {
      // Someone else's login finishes first, and fails.
      bus.emit(done("someone-elses-run", { success: false, message: "not ours" }));
      // Ours succeeds a moment later.
      setTimeout(() => bus.emit(done("run-1")), 0);
    };

    await expect(
      runSignInMethod("cursor", { id: "login", terminalCommand: "cursor-agent login" }, "Cursor"),
    ).resolves.toBeUndefined();
  });

  /// A failing login still has to surface its message rather than passing.
  it("reports the failure the login exited with", async () => {
    onRun = (runId) => bus.emit(done(runId, { success: false, message: "no browser found" }));

    await expect(
      runSignInMethod("cursor", { id: "login", terminalCommand: "cursor-agent login" }, "Cursor"),
    ).rejects.toThrow("no browser found");
  });

  /// Nothing is left subscribed once the flow is over, whichever way it ended.
  it("unsubscribes when the run finishes", async () => {
    onRun = (runId) => bus.emit(done(runId));

    await runSignInMethod(
      "cursor",
      { id: "login", terminalCommand: "cursor-agent login" },
      "Cursor",
    );

    expect(bus.handlers.size).toBe(0);
  });

  /// A method with no login command goes straight to `authenticate()` and must
  /// not arm a watcher at all.
  it("does not wait on a run for a command-less method", async () => {
    await expect(
      runSignInMethod("codex", { id: "chatgpt", terminalCommand: null }, "Codex"),
    ).resolves.toBeUndefined();
    expect(bus.handlers.size).toBe(0);
  });
});
