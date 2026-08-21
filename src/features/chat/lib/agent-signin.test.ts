import { describe, expect, it, vi } from "vitest";

// The module pulls in Tauri IPC + zustand stores at import time; none of that
// is needed for the pure classifiers under test.
vi.mock("sonner", () => ({
  toast: Object.assign(() => {}, {
    error: () => {},
    success: () => {},
    loading: () => {},
    dismiss: () => {},
  }),
}));
vi.mock("./agents-api", () => ({
  agents: {},
  ensureAgent: () => {},
  listenAuthRunDone: () => Promise.resolve(() => {}),
}));
vi.mock("@/features/agents/lib/agent-meta", () => ({ agentMeta: (id: string) => ({ label: id }) }));

const { isAuthError, canSignIn } = await import("./agent-signin");

describe("isAuthError", () => {
  it("recognises the error Cursor actually returns from session/new", () => {
    // Captured verbatim from `cursor-agent acp` while signed out. This arrives
    // at BIND time, not during a turn, which is the whole reason the bind
    // catch has to classify it instead of relying on the turn-failure route.
    const real =
      'acp: acp protocol error: Error { code: -32000, message: "Authentication required", ' +
      'data: Some(Object {"message": String("Authentication required. Please run \'agent login\' ' +
      "first, then call authenticate() with methodId 'cursor_login'.\")}) }";
    expect(isAuthError(new Error(real))).toBe(true);
    expect(isAuthError(real)).toBe(true);
  });

  it("covers the other shapes agents use for the same thing", () => {
    for (const m of [
      "Unauthorized",
      "not authenticated",
      "auth required",
      "HTTP 401 from provider",
      "http 403",
    ]) {
      expect(isAuthError(new Error(m))).toBe(true);
    }
  });

  it("does not swallow unrelated failures", () => {
    // These must keep showing their real message rather than a sign-in prompt.
    for (const m of [
      "spawn ENOENT",
      "Could not start Cursor: `cursor-agent` is not available",
      "prompt is too long",
      "Cursor is turned off. Turn it back on in Settings → Agents.",
    ]) {
      expect(isAuthError(new Error(m))).toBe(false);
    }
  });
});

describe("canSignIn", () => {
  it("is true for every ACP agent, whoever they are", () => {
    // The point of the port: sign-in is not a privilege granted to a list of
    // blessed ids. Any agent may advertise auth methods, and the same dialog
    // renders whatever it advertised.
    for (const id of ["claude-acp", "codex-acp", "cursor", "opencode", "kilo", "amp-acp"]) {
      expect(canSignIn(id)).toBe(true);
    }
  });

  it("is false only for the native agent and a missing id", () => {
    // The in-process agent has no external account to sign in to.
    expect(canSignIn("cersei")).toBe(false);
    expect(canSignIn(undefined)).toBe(false);
  });
});
