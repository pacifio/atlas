// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }));

let signedIn = true;
let orgs: { id: string; name: string }[] | null = [{ id: "org_1", name: "Acme" }];
let activeOrgId: string | null = "org_1";
vi.mock("@/features/auth/stores/auth-store", () => ({
  useAuthStore: (selector: (s: unknown) => unknown) =>
    selector({
      snapshot: { status: signedIn ? "signed-in" : "signed-out", orgs, activeOrgId },
    }),
}));

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AiGrantBar } from "./ai-grant-bar";
import { useAiGrantStore, type Entitlement } from "../stores/ai-grant-store";

const NO_GRANT: Entitlement = {
  state: "noGrant",
  message: "Organisation 'org_1' has not been granted AI access.",
};

/** Put the store in the state the gateway would have left it in. */
function seed(entitlement: Entitlement | null) {
  useAiGrantStore.setState({
    entitlement,
    checking: false,
    requesting: false,
    requested: false,
    dismissed: false,
  });
}

describe("the no-grant setup state (bar 14)", () => {
  beforeEach(() => {
    invoke.mockReset();
    toastError.mockReset();
    signedIn = true;
    orgs = [{ id: "org_1", name: "Acme" }];
    activeOrgId = "org_1";
    seed(null);
  });

  // There is no global setup file, so nothing unmounts the previous render —
  // without this, a bar from an earlier case is still in the document and
  // every "renders nothing" assertion passes or fails for the wrong reason.
  afterEach(cleanup);

  it("names the organisation the user knows, not the id the gateway sent", async () => {
    // The whole reason this stopped being the gateway's raw sentence: that
    // string names the org by a 26-character opaque id the user has never seen.
    seed(NO_GRANT);
    render(<AiGrantBar />);
    const bar = await screen.findByTestId("ai-grant-bar");
    expect(bar.textContent).toContain("Acme");
    expect(bar.textContent).toContain("doesn't have AI grants");
    expect(bar.textContent).not.toContain("org_1");
    // The gateway's own words stay reachable rather than being thrown away.
    expect(bar.getAttribute("title")).toBe(NO_GRANT.message);
  });

  it("falls back to a generic subject when the org name is not known yet", async () => {
    // `orgs: null` is "not known yet" — a blip after sign-in. Rendering
    // "undefined doesn't have AI grants" would be worse than saying nothing.
    orgs = null;
    seed(NO_GRANT);
    render(<AiGrantBar />);
    expect((await screen.findByTestId("ai-grant-bar")).textContent).toContain("This organisation");
  });

  it("says nothing at all when the account is entitled", () => {
    seed({ state: "entitled", models: ["claude-sonnet-4-6"] });
    render(<AiGrantBar />);
    expect(screen.queryByTestId("ai-grant-bar")).toBeNull();
  });

  it("says nothing when it could not find out", () => {
    // Offline, a timeout, a 502. Telling someone their account lacks access
    // because their Wi-Fi dropped is worse than telling them nothing.
    seed({ state: "unknown", reason: "offline" });
    render(<AiGrantBar />);
    expect(screen.queryByTestId("ai-grant-bar")).toBeNull();
  });

  it("re-probes the gateway on Refresh and clears itself once granted", async () => {
    seed(NO_GRANT);
    invoke.mockResolvedValue({ state: "entitled", models: ["claude-sonnet-4-6"] });
    render(<AiGrantBar />);
    await userEvent.click(screen.getByTitle("Check again"));
    await waitFor(() => expect(screen.queryByTestId("ai-grant-bar")).toBeNull());
    expect(invoke).toHaveBeenCalledWith("native_agent_entitlement");
  });

  it("stays put when the re-check fails", async () => {
    // Vanishing on a dropped connection would read as "you have access now".
    seed(NO_GRANT);
    invoke.mockRejectedValue(new Error("offline"));
    render(<AiGrantBar />);
    await userEvent.click(screen.getByTitle("Check again"));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(screen.queryByTestId("ai-grant-bar")).not.toBeNull();
  });

  it("records the ask once and then says so", async () => {
    seed(NO_GRANT);
    invoke.mockResolvedValue(null);
    render(<AiGrantBar />);
    await userEvent.click(screen.getByText("Request"));
    await screen.findByText("Requested");
    expect(invoke).toHaveBeenCalledWith("native_agent_request_access");
    // Re-asking would just double-count the same organisation.
    expect((screen.getByText("Requested").closest("button") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("surfaces a failed request instead of showing a false tick", async () => {
    seed(NO_GRANT);
    invoke.mockRejectedValue(new Error("Telemetry is not configured in this build."));
    render(<AiGrantBar />);
    await userEvent.click(screen.getByText("Request"));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(screen.queryByText("Requested")).toBeNull();
  });

  it("can be dismissed without pretending the grant appeared", async () => {
    // Dismissing hides the notice. It must NOT clear the entitlement, which is
    // what keeps the composer locked — see `message-input.tsx`.
    seed(NO_GRANT);
    render(<AiGrantBar />);
    await userEvent.click(screen.getByTitle("Dismiss"));
    expect(screen.queryByTestId("ai-grant-bar")).toBeNull();
    expect(useAiGrantStore.getState().entitlement).toEqual(NO_GRANT);
  });
});

describe("the grant store's composer lock", () => {
  beforeEach(() => {
    invoke.mockReset();
    seed(null);
  });

  it("locks only on a definite no", async () => {
    const { probe } = useAiGrantStore.getState().actions;

    invoke.mockResolvedValue(NO_GRANT);
    await probe();
    expect(useAiGrantStore.getState().entitlement?.state).toBe("noGrant");

    // "Could not find out" must leave the composer alone — a dropped Wi-Fi
    // connection is not a refusal.
    invoke.mockResolvedValue({ state: "unknown", reason: "offline" });
    await probe();
    expect(useAiGrantStore.getState().entitlement?.state).toBe("unknown");

    // A probe that throws keeps the LAST known answer rather than inventing one.
    invoke.mockRejectedValue(new Error("no such command"));
    expect(await probe()).toBeNull();
    expect(useAiGrantStore.getState().entitlement?.state).toBe("unknown");
  });

  it("asks the gateway once however many composers are mounted", async () => {
    // Split view and background workspaces each mount their own composer. One
    // probe per org, not one per tab — and no tab's reset may wipe the answer
    // another just fetched.
    useAiGrantStore.setState({ probedOrgId: null });
    invoke.mockResolvedValue(NO_GRANT);
    const { ensureProbed } = useAiGrantStore.getState().actions;
    ensureProbed("org_1");
    ensureProbed("org_1");
    ensureProbed("org_1");
    await waitFor(() => expect(useAiGrantStore.getState().entitlement).toEqual(NO_GRANT));
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("re-asks when the org actually changes", async () => {
    useAiGrantStore.setState({ probedOrgId: null });
    invoke.mockResolvedValue(NO_GRANT);
    const { ensureProbed } = useAiGrantStore.getState().actions;
    ensureProbed("org_1");
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    ensureProbed("org_2");
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  });

  it("never lands the outgoing org's refusal on the incoming one", async () => {
    // The switch can happen mid-flight. org1's "no grant" arriving after the
    // user moved to org2 would lock org2's composer over a grant it may have.
    useAiGrantStore.setState({ probedOrgId: null });
    let settle: ((v: Entitlement) => void) | undefined;
    invoke.mockReturnValue(
      new Promise<Entitlement>((r) => {
        settle = r;
      }),
    );
    const { ensureProbed } = useAiGrantStore.getState().actions;
    ensureProbed("org_1");
    ensureProbed("org_2");
    settle?.(NO_GRANT); // org_1's answer, arriving late
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(useAiGrantStore.getState().entitlement).toBeNull();
  });

  it("forgets everything about the outgoing org", () => {
    seed(NO_GRANT);
    useAiGrantStore.setState({ requested: true, dismissed: true });
    useAiGrantStore.getState().actions.resetForOrg();
    const s = useAiGrantStore.getState();
    // org1's refusal says nothing about org2, and neither does org1's dismissal.
    expect(s.entitlement).toBeNull();
    expect(s.requested).toBe(false);
    expect(s.dismissed).toBe(false);
  });
});
