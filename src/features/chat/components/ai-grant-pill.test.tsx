// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

let signedIn = true;
vi.mock("@/features/auth/stores/auth-store", () => ({
  useAuthStore: (selector: (s: unknown) => unknown) =>
    selector({ snapshot: { status: signedIn ? "signed-in" : "signed-out" } }),
}));

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { AiGrantPill } from "./ai-grant-pill";

describe("the no-grant setup state (bar 14)", () => {
  beforeEach(() => {
    invoke.mockReset();
    signedIn = true;
  });

  // There is no global setup file, so nothing unmounts the previous render —
  // without this, a pill from an earlier case is still in the document and
  // every "renders nothing" assertion passes or fails for the wrong reason.
  afterEach(cleanup);

  it("tells a user with no grant who can fix it", async () => {
    // The whole point of the state: a user told what is wrong but not who can
    // fix it goes looking through their own settings for a switch that does
    // not exist.
    invoke.mockResolvedValue({
      state: "noGrant",
      message: "Your account needs AI access — ask your admin to enable it.",
    });
    render(<AiGrantPill />);
    const pill = await screen.findByTestId("ai-grant-pill");
    expect(pill.textContent).toContain("ask your admin");
  });

  it("says nothing at all when the account is entitled", async () => {
    invoke.mockResolvedValue({ state: "entitled", models: ["claude-sonnet-4-6"] });
    render(<AiGrantPill />);
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(screen.queryByTestId("ai-grant-pill")).toBeNull();
  });

  it("says nothing when it could not find out", async () => {
    // Offline, a timeout, a 502. Telling someone their account lacks access
    // because their Wi-Fi dropped is worse than telling them nothing.
    invoke.mockResolvedValue({ state: "unknown", reason: "offline" });
    render(<AiGrantPill />);
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(screen.queryByTestId("ai-grant-pill")).toBeNull();
  });

  it("survives a probe that throws", async () => {
    invoke.mockRejectedValue(new Error("no such command"));
    render(<AiGrantPill />);
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(screen.queryByTestId("ai-grant-pill")).toBeNull();
  });

  it("does not ask the gateway anything while signed out", async () => {
    // There is no token to ask with, and a signed-out user already has a
    // sign-in affordance — a second "you need access" pill next to it is noise.
    signedIn = false;
    render(<AiGrantPill />);
    expect(invoke).not.toHaveBeenCalled();
  });
});
