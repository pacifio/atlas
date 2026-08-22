import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

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
/** The catalog fields `canSignIn` reads. Partial because a test only sets the
 *  ones its assertion depends on. */
type CatalogStub = Partial<{
  kind: "native" | "external";
  installed: boolean;
  source: import("@/types/agent-catalog").AgentSource;
  login: { program: string; args: string[] } | null;
  authKinds: ("agent" | "env_var" | "terminal")[];
}>;
let catalog: Record<string, CatalogStub> = {};
vi.mock("@/features/agents/lib/agent-meta", () => ({
  agentMeta: (id: string) => ({ label: id }),
  catalogEntry: (id: string) => catalog[id] ?? null,
}));

const { isAuthError, canSignIn, errInfo, bindFailureAction } = await import("./agent-signin");

beforeEach(() => {
  catalog = {};
});

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

describe("isAuthError — structured errors", () => {
  it("trusts the backend's classification over the message text", () => {
    // The bind commands now carry a kind. A message that says nothing about
    // auth still routes to sign-in when Rust classified it that way…
    expect(isAuthError({ message: "session/new rejected", kind: "auth" })).toBe(true);
    // …and an auth-sounding message does NOT, when Rust said otherwise. This
    // is what stops "Could not start Cursor … Sign in with `cursor-agent
    // login`" (a spawn failure whose HINT mentions signing in) from opening
    // the sign-in dialog instead of showing the real problem.
    expect(
      isAuthError({
        message: "Could not start Cursor: not available. Sign in with `cursor-agent login`.",
        kind: "fatal",
      }),
    ).toBe(false);
  });

  it("falls back to substring matching for unclassified failures", () => {
    expect(isAuthError({ message: "Unauthorized" })).toBe(true);
    expect(isAuthError({ message: "spawn ENOENT" })).toBe(false);
  });
});

describe("errInfo", () => {
  it("unwraps the structured shape the bind commands reject with", () => {
    expect(errInfo({ message: "boom", kind: "fatal" })).toEqual({
      message: "boom",
      kind: "fatal",
    });
  });

  it("handles plain Errors and strings", () => {
    expect(errInfo(new Error("nope"))).toEqual({ message: "nope", kind: null });
    expect(errInfo("bare")).toEqual({ message: "bare", kind: null });
  });

  it("never yields [object Object]", () => {
    // The regression this exists to prevent: a structured error rendered
    // straight into a toast.
    for (const e of [{ message: "x", kind: "auth" }, new Error("y"), "z", null, undefined, 42]) {
      expect(errInfo(e).message).not.toContain("[object Object]");
    }
  });
});

describe("AUTH token parity with Rust", () => {
  it("matches the AUTH bucket of classify_message", () => {
    // The fallback path only works if it recognises what Rust recognises.
    // Parsed from the Rust source so a token added there fails here.
    const rust = readFileSync("crates/atlas-acp/src/error.rs", "utf8");
    const block = rust.match(/const AUTH: &\[&str\] = &\[([\s\S]*?)\];/);
    expect(block, "AUTH bucket not found in error.rs").toBeTruthy();
    const rustTokens = [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(rustTokens.length).toBeGreaterThan(0);
    // Every Rust token must classify as auth on this side too.
    for (const token of rustTokens) {
      expect(isAuthError(new Error(`prefix ${token} suffix`)), token).toBe(true);
    }
  });
});

describe("canSignIn", () => {
  it("is false before the catalog lands", () => {
    // There is no static table of agents to guess from any more (ADR-0002): an
    // agent exists because the user installed it, and an installed agent has a
    // catalog entry. No entry, nothing to sign in to.
    for (const id of ["cursor", "opencode", "kilo", "amp-acp", undefined]) {
      expect(canSignIn(id)).toBe(false);
    }
  });

  it("offers the dialog to EVERY external agent, catalog login or not", () => {
    // Regression: `autohand` (and every other auth-gated registry agent)
    // rejects session/new with "Please log in" while advertising a runnable
    // login method over ACP. The catalog can't know that — auth methods only
    // exist in the live `initialize` response — so gating on catalog.login left
    // installed agents with a raw protocol error and no way to sign in.
    catalog = { autohand: { kind: "external", login: null, installed: true } };
    expect(canSignIn("autohand")).toBe(true);
  });

  it("never offers it for an agent that is only DETECTED", () => {
    // Found on PATH but not installed: the backend refuses to spawn it
    // (ADR-0002), so sign-in is a dead end. Installing is the action that is
    // actually available.
    catalog = { cursor: { kind: "external", login: null, installed: false, source: "detected" } };
    expect(canSignIn("cursor")).toBe(false);
  });

  it("offers it to an installed agent that advertises no login yet", () => {
    // `login` is filled from the agent's own advertisement and stays null
    // until it has connected once. That window must not hide `/login`.
    catalog = { cursor: { kind: "external", login: null, installed: true } };
    expect(canSignIn("cursor")).toBe(true);
  });

  it("never offers it for the native in-process agent", () => {
    catalog = { cersei: { kind: "native", login: null } };
    expect(canSignIn("cersei")).toBe(false);
  });
});

describe("bindFailureAction", () => {
  const authErr = { message: "Authentication required", kind: "auth" };

  beforeEach(() => {
    catalog = { autohand: { kind: "external", login: null, installed: true } };
  });

  it("offers sign-in on the FIRST auth failure", () => {
    expect(
      bindFailureAction({ agentType: "autohand", err: authErr, alreadyAttempted: false }),
    ).toBe("sign-in");
  });

  it("does NOT re-offer sign-in after one attempt — the loop guard", () => {
    // The retry callback must clear the "already reported" dedup so the rebind
    // can report afresh, which means without this guard a second auth failure
    // re-opens the dialog, completing it retries, and round it goes forever.
    // `autohand` reaches this for real: its only method is
    // `npm install -g autohand-cli`, which never actually logs it in.
    expect(bindFailureAction({ agentType: "autohand", err: authErr, alreadyAttempted: true })).toBe(
      "signed-in-but-refused",
    );
  });

  it("reports plainly when the failure is not about auth", () => {
    for (const attempted of [false, true]) {
      expect(
        bindFailureAction({
          agentType: "autohand",
          err: { message: "spawn ENOENT", kind: "fatal" },
          alreadyAttempted: attempted,
        }),
      ).toBe("report");
    }
  });

  it("reports plainly for agents Atlas cannot sign in", () => {
    catalog = { cersei: { kind: "native", login: null } };
    expect(bindFailureAction({ agentType: "cersei", err: authErr, alreadyAttempted: false })).toBe(
      "report",
    );
    expect(bindFailureAction({ agentType: undefined, err: authErr, alreadyAttempted: false })).toBe(
      "report",
    );
  });
});

describe("canSignIn is catalog-first (R6)", () => {
  it("trusts what the agent actually advertised over the static login field", () => {
    // Claude has no login argv Atlas knows of, so the old rule said "cannot
    // sign in" — yet it advertises two terminal methods. Gating on advertised
    // data is what removed the per-agent special cases in TS.
    catalog["claude-code"] = {
      kind: "external",
      login: null,
      installed: true,
      authKinds: ["terminal"],
    };
    expect(canSignIn("claude-code")).toBe(true);
  });

  it("treats an agent-kind method as signable too", () => {
    // Codex advertises only `agent` methods (no `type` on the wire).
    catalog["codex"] = { kind: "external", login: null, installed: true, authKinds: ["agent"] };
    expect(canSignIn("codex")).toBe(true);
  });

  it("still offers sign-in before the agent has ever been spawned", () => {
    // `authKinds` is empty until `initialize` has run. Empty must mean
    // "unknown", NOT "cannot sign in" — otherwise `/login` disappears for an
    // agent the user has simply never started, which is exactly when they
    // need it.
    catalog["cursor"] = { kind: "external", login: null, installed: true, authKinds: [] };
    expect(canSignIn("cursor")).toBe(true);
  });

  it("never offers sign-in for the native agent, whatever it reports", () => {
    catalog["cersei"] = { kind: "native", login: null, authKinds: ["agent"] };
    expect(canSignIn("cersei")).toBe(false);
  });

  it("still offers sign-in for externals with nothing advertised", () => {
    catalog["some-external"] = { kind: "external", login: null, installed: true, authKinds: [] };
    expect(canSignIn("some-external")).toBe(true);
  });
});
