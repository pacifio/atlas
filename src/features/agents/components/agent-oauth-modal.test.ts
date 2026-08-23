import { describe, expect, it, vi } from "vitest";
import type { AuthEnvStatus, AuthMethodWire } from "@/features/chat/lib/agents-api";

// The component pulls Tauri IPC, Radix and zustand in at import time; the pure
// decision functions under test need none of it.
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: () => Promise.resolve() }));
vi.mock("sonner", () => ({ toast: { success: () => {}, error: () => {} } }));
vi.mock("@/features/chat/lib/agents-api", () => ({ agents: {}, ensureAgent: () => {} }));
vi.mock("@/features/chat/lib/agent-signin", () => ({
  AGENT_SIGNIN_EVENT: "atlas:agent-signin",
  errInfo: (e: unknown) => ({ message: String(e), kind: null }),
  runSignInMethod: () => Promise.resolve(),
  takeSignInCallback: () => undefined,
}));
vi.mock("@/features/agents/lib/agent-meta", () => ({ agentMeta: (id: string) => ({ label: id }) }));
vi.mock("@/features/log/lib/log", () => ({ logEvent: () => {} }));

const { manualCommandFor, methodBlockedReason, methodForReason } =
  await import("./agent-oauth-modal");

/** A method with only the fields a given assertion depends on. */
function method(over: Partial<AuthMethodWire>): AuthMethodWire {
  return {
    id: "m",
    name: "M",
    description: null,
    kind: "agent",
    link: null,
    terminalCommand: null,
    terminalArgs: null,
    terminalLabel: null,
    apiKeyProvider: null,
    ...over,
  };
}

function envStatus(over: Partial<AuthEnvStatus>): AuthEnvStatus {
  return {
    methodId: "m",
    name: "KEY",
    label: null,
    optional: false,
    satisfied: false,
    source: null,
    ...over,
  };
}

describe("manualCommandFor", () => {
  /// The escape hatch when Atlas cannot drive the login itself. It must be
  /// runnable as-is, including when the binary sits in Atlas's app-data dir —
  /// the old "copy `cursor-agent login`" advice pointed at a command that was
  /// not on the user's PATH at all.
  it("renders a runnable command", () => {
    expect(
      manualCommandFor(
        method({ terminalCommand: "/usr/bin/cursor-agent", terminalArgs: ["login"] }),
      ),
    ).toBe("/usr/bin/cursor-agent login");
  });

  it("quotes paths with spaces so a paste into a shell survives", () => {
    const cmd = manualCommandFor(
      method({
        terminalCommand: "/Applications/My App/bin/agent",
        terminalArgs: ["auth", "login"],
      }),
    );
    expect(cmd).toBe("'/Applications/My App/bin/agent' auth login");
  });

  it("is null when there is nothing to run", () => {
    expect(manualCommandFor(method({ terminalCommand: null }))).toBeNull();
  });
});

describe("methodBlockedReason", () => {
  it("blocks an env_var method while a required var is missing", () => {
    const m = method({ id: "k", kind: "env_var" });
    const reason = methodBlockedReason(m, [envStatus({ methodId: "k", name: "GEMINI_API_KEY" })]);
    expect(reason).toContain("GEMINI_API_KEY");
  });

  it("allows it once every required var is satisfied", () => {
    const m = method({ id: "k", kind: "env_var" });
    expect(
      methodBlockedReason(m, [
        envStatus({ methodId: "k", name: "GEMINI_API_KEY", satisfied: true, source: "shell-env" }),
      ]),
    ).toBeNull();
  });

  /// An optional var must never gate the button — blocking on one would make a
  /// perfectly usable sign-in unreachable.
  it("ignores optional vars", () => {
    const m = method({ id: "k", kind: "env_var" });
    expect(
      methodBlockedReason(m, [envStatus({ methodId: "k", name: "OPTIONAL", optional: true })]),
    ).toBeNull();
  });

  /// Vars belonging to a sibling method must not block this one.
  it("only considers its own method's vars", () => {
    const m = method({ id: "k", kind: "env_var" });
    expect(
      methodBlockedReason(m, [envStatus({ methodId: "other", name: "SOMETHING_ELSE" })]),
    ).toBeNull();
  });

  it("blocks a terminal method with no runnable command", () => {
    expect(methodBlockedReason(method({ kind: "terminal" }), [])).toContain("could not find");
  });

  it("never blocks a plain agent method", () => {
    expect(methodBlockedReason(method({ kind: "agent" }), [])).toBeNull();
  });
});

describe("methodForReason", () => {
  /// Landing the user on a list of four methods after the agent said
  /// "GEMINI_API_KEY is missing" makes them do the mapping themselves.
  it("picks the env_var method that owns the named variable", () => {
    const target = method({
      id: "gemini-key",
      kind: "env_var",
      envVars: [{ name: "GEMINI_API_KEY", label: null, secret: true, optional: false }],
    });
    const methods = [method({ id: "other", kind: "agent" }), target];
    expect(methodForReason(methods, "Gemini API key is missing or not configured.")?.id).toBe(
      "gemini-key",
    );
  });

  /// No adapter ships typed `env_var` today (R1), so the provider hint is the
  /// path that actually fires in the real world.
  it("falls back to the api-key provider hint codex actually sends", () => {
    const methods = [
      method({ id: "chat-gpt", kind: "agent" }),
      method({ id: "api-key", kind: "agent", apiKeyProvider: "openai" }),
    ];
    expect(methodForReason(methods, "missing OPENAI_API_KEY")?.id).toBe("api-key");
  });

  it("returns null when the failure names no provider", () => {
    const methods = [method({ id: "api-key", kind: "agent", apiKeyProvider: "openai" })];
    expect(methodForReason(methods, "Authentication required")).toBeNull();
  });

  it("returns null without a reason at all", () => {
    expect(methodForReason([method({})], undefined)).toBeNull();
  });

  /// A named provider with no matching method must fall through to the normal
  /// chooser rather than dead-ending on an unrelated one.
  it("returns null when no method matches the named provider", () => {
    const methods = [method({ id: "chat-gpt", kind: "agent" })];
    expect(methodForReason(methods, "Gemini API key is missing")).toBeNull();
  });
});
