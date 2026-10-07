// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }));

const openUrl = vi.fn(async (_url: string) => {});
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (u: string) => openUrl(u) }));

let signedIn = true;
let orgs: { id: string; name: string }[] | null = [{ id: "org_1", name: "Acme" }];
let activeOrgId: string | null = "org_1";
/** The DESKTOP's organisations — the ones the user sees. The bar names the
 *  active one of these, not the account's cloud org. */
type DesktopOrg = { id: string; name: string; syncEnabled: boolean; remoteId?: string };
let desktopOrgs: DesktopOrg[] = [
  { id: "local_1", name: "Acme", syncEnabled: true, remoteId: "org_1" },
];
let activeDesktopOrgId: string | null = "local_1";
const enableSync = vi.fn(async () => {});
vi.mock("@/features/organisations/stores/org-store", () => ({
  useOrgStore: (selector: (s: unknown) => unknown) =>
    selector({
      organisations: desktopOrgs,
      activeOrganisationId: activeDesktopOrgId,
      actions: { enableSync },
    }),
}));
vi.mock("@/features/auth/stores/auth-store", () => ({
  useAuthStore: (selector: (s: unknown) => unknown) =>
    selector({
      snapshot: { status: signedIn ? "signed-in" : "signed-out", orgs, activeOrgId },
    }),
}));

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AiGrantBar } from "./ai-grant-bar";
import {
  grantLocksComposer,
  useAiGrantStore,
  useAiGrantProbe,
  useNoAiGrant,
  type Entitlement,
} from "../stores/ai-grant-store";

/** A stand-in composer: mounts the probe and reports the lock, nothing else. */
function Composer() {
  useAiGrantProbe();
  const locked = useNoAiGrant();
  return <div data-testid="composer" data-locked={locked ? "yes" : "no"} />;
}

const NO_GRANT: Entitlement = {
  state: "noGrant",
  message: "Organisation 'org_1' has not been granted AI access.",
};

/** Put the store in the state the gateway would have left it in. */
function seed(entitlement: Entitlement | null) {
  useAiGrantStore.setState({
    entitlement,
    checking: false,
    dismissed: false,
  });
}

// One full reset for both describes: the module variables the store mocks read
// and every mock's recorded calls, so no case inherits another's org or answer.
beforeEach(() => {
  invoke.mockReset();
  toastError.mockReset();
  openUrl.mockReset();
  openUrl.mockResolvedValue(undefined);
  enableSync.mockClear();
  signedIn = true;
  orgs = [{ id: "org_1", name: "Acme" }];
  activeOrgId = "org_1";
  desktopOrgs = [{ id: "local_1", name: "Acme", syncEnabled: true, remoteId: "org_1" }];
  activeDesktopOrgId = "local_1";
  seed(null);
  useAiGrantStore.setState({ probedOrgId: null });
});

// There is no global setup file, so nothing unmounts the previous render —
// without this, a bar from an earlier case is still in the document and
// every "renders nothing" assertion passes or fails for the wrong reason.
afterEach(cleanup);

describe("the no-grant setup state (bar 14)", () => {
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
    // ...and the desktop has not restored its orgs either.
    desktopOrgs = [];
    activeDesktopOrgId = null;
    seed(NO_GRANT);
    render(<AiGrantBar />);
    expect((await screen.findByTestId("ai-grant-bar")).textContent).toContain("This organization");
  });

  it("waits for a running turn to end before it shows", () => {
    // The answer turned to "no" mid-turn (a probe landing after the first
    // send, or a Refresh after a revocation). The turn was already admitted;
    // a bar saying the org cannot use AI over an agent visibly working is
    // the app contradicting itself.
    seed(NO_GRANT);
    const { rerender } = render(<AiGrantBar turnRunning />);
    expect(screen.queryByTestId("ai-grant-bar")).toBeNull();
    rerender(<AiGrantBar turnRunning={false} />);
    expect(screen.getByTestId("ai-grant-bar").textContent).toContain("doesn't have AI grants");
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

  it("sends Request to the credits page rather than to analytics", async () => {
    // It used to fire a PostHog `ai_access_requested` event — an ask that
    // landed where the user's own team could never see it.
    seed(NO_GRANT);
    render(<AiGrantBar />);
    await userEvent.click(screen.getByText("Request"));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://credits.tryatlas.cc/"));
    expect(invoke).not.toHaveBeenCalledWith("native_agent_request_access");
    // Nothing was recorded, so the bar has no "done" state to fall into: the
    // button stays live for a second try.
    expect((screen.getByText("Request").closest("button") as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("says so when the browser could not be opened", async () => {
    seed(NO_GRANT);
    openUrl.mockRejectedValue(new Error("no handler"));
    render(<AiGrantBar />);
    await userEvent.click(screen.getByText("Request"));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
  });

  it("can be dismissed without pretending the grant appeared", async () => {
    // Dismissing hides the notice. It must NOT clear the entitlement, which is
    // what keeps the composer locked — see `message-input.tsx`.
    seed(NO_GRANT);
    render(<AiGrantBar />);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("ai-grant-bar")).toBeNull();
    expect(useAiGrantStore.getState().entitlement).toEqual(NO_GRANT);
  });
});

describe("the grant store's composer lock", () => {
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
    // Split view and background projects each mount their own composer. One
    // probe per org, not one per tab — and no tab's reset may wipe the answer
    // another just fetched.
    invoke.mockResolvedValue(NO_GRANT);
    const { ensureProbed } = useAiGrantStore.getState().actions;
    ensureProbed("org_1");
    ensureProbed("org_1");
    ensureProbed("org_1");
    await waitFor(() => expect(useAiGrantStore.getState().entitlement).toEqual(NO_GRANT));
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("re-asks when the org actually changes", async () => {
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
    // One promise PER probe — a shared `mockReturnValue` promise would also
    // resolve org_2's own probe, which is entitled to record the answer.
    const settlers: ((v: Entitlement) => void)[] = [];
    invoke.mockImplementation(
      () =>
        new Promise<Entitlement>((r) => {
          settlers.push(r);
        }),
    );
    const { ensureProbed } = useAiGrantStore.getState().actions;
    ensureProbed("org_1");
    ensureProbed("org_2");
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    settlers[0]?.(NO_GRANT); // org_1's answer, arriving late
    // A macrotask, so every pending microtask (the stale probe's continuation
    // included) has run before the assertion.
    await new Promise((r) => setTimeout(r, 0));
    expect(useAiGrantStore.getState().entitlement).toBeNull();
  });

  it("forgets everything about the outgoing org", () => {
    seed(NO_GRANT);
    useAiGrantStore.setState({ dismissed: true });
    useAiGrantStore.getState().actions.resetForOrg();
    const s = useAiGrantStore.getState();
    // org1's refusal says nothing about org2, and neither does org1's dismissal.
    expect(s.entitlement).toBeNull();
    expect(s.dismissed).toBe(false);
  });

  // ── Which organisation the bar is about ─────────────────────────────────

  it("names the DESKTOP's active org, not the account's cloud org", () => {
    // The auth snapshot only knows cloud orgs. With the desktop on "Main" (a
    // synced org the account also has) and the account's last cloud org
    // "Demo", the bar read "Demo doesn't have AI grants" — the wrong org.
    orgs = [
      { id: "org_demo", name: "Demo" },
      { id: "org_main", name: "Main" },
    ];
    activeOrgId = "org_demo";
    desktopOrgs = [{ id: "local_main", name: "Main", syncEnabled: true, remoteId: "org_main" }];
    activeDesktopOrgId = "local_main";
    seed(NO_GRANT);
    render(<AiGrantBar />);
    expect(screen.getByTestId("ai-grant-bar").textContent).toContain("Main");
    expect(screen.getByTestId("ai-grant-bar").textContent).not.toContain("Demo");
  });

  it("tells a local org to turn on sync, without asking the gateway", async () => {
    // A local org is not missing a grant — it is not on the gateway's side at
    // all. Nothing to probe, nothing to request; the composer locks with the
    // reason on it, and the account's cloud org is never named.
    activeOrgId = "org_demo";
    orgs = [{ id: "org_demo", name: "Demo" }];
    desktopOrgs = [{ id: "local_2", name: "Local", syncEnabled: false }];
    activeDesktopOrgId = "local_2";
    invoke.mockResolvedValue(NO_GRANT);
    render(
      <>
        <Composer />
        <AiGrantBar />
      </>,
    );
    const bar = await screen.findByTestId("ai-grant-bar");
    expect(bar.textContent).toContain("Local");
    expect(bar.textContent).toContain("is local");
    expect(bar.textContent).not.toContain("Demo");
    expect(bar.textContent).not.toContain("Request");
    expect(screen.getByTestId("composer").dataset.locked).toBe("yes");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("probes a synced org under its gateway id", async () => {
    invoke.mockResolvedValue({ state: "entitled", models: ["m"] });
    desktopOrgs = [{ id: "local_3", name: "Demo-1", syncEnabled: true, remoteId: "org_d1" }];
    activeDesktopOrgId = "local_3";
    render(<Composer />);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(useAiGrantStore.getState().probedOrgId).toBe("org_d1");
    await waitFor(() => expect(screen.getByTestId("composer").dataset.locked).toBe("no"));
  });

  it("offers the switcher's Turn-on-sync action for a local org", async () => {
    // The one thing that unlocks the agent, beside the notice that names it —
    // the same `enableSync` the org switcher's item calls, for the same org.
    desktopOrgs = [{ id: "local_2", name: "Local", syncEnabled: false }];
    activeDesktopOrgId = "local_2";
    render(
      <>
        <Composer />
        <AiGrantBar />
      </>,
    );
    const bar = await screen.findByTestId("ai-grant-bar");
    await userEvent.click(screen.getByRole("button", { name: /turn on sync/i }));
    expect(enableSync).toHaveBeenCalledWith("local_2");
    expect(bar.textContent).not.toContain("Refresh");
  });
});

describe("grantLocksComposer", () => {
  it("locks the native agent's composer on a definite no", () => {
    expect(grantLocksComposer(true, "atlas-agent", false)).toBe(true);
  });

  it("never locks a running turn — the lock would disable its Stop", () => {
    expect(grantLocksComposer(true, "atlas-agent", true)).toBe(false);
  });

  it("never locks an agent that does not bill the gateway", () => {
    expect(grantLocksComposer(true, "claude-code", false)).toBe(false);
  });

  it("does not lock without a definite no", () => {
    expect(grantLocksComposer(false, "atlas-agent", false)).toBe(false);
  });
});
