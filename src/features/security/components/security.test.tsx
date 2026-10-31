// @vitest-environment happy-dom
//
// The Security Agent's UI (ATL-985): the Timeline badge, the session line, the
// findings in a Checkpoint card, and Before you ship.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const listeners = vi.hoisted(() => [] as ((e: { payload: unknown }) => void)[]);
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_: string, handler: (e: { payload: unknown }) => void) => {
    listeners.push(handler);
    return () => {};
  }),
}));
const prList = vi.hoisted(() => vi.fn());
vi.mock("@/features/pull-requests/lib/pull-requests-api", () => ({ prList }));

import type { CheckpointSecurity, ShipOverview } from "../types";
import { useSecurityStore } from "../stores/security-store";
import { resetProjectSecurityForTests } from "../lib/use-project-security";
const { SessionSecurityBadge } = await import("./session-security-badge");
const { SecuritySummary } = await import("./security-summary");
const { CheckpointFindings } = await import("./checkpoint-findings");
const { ShipOverviewCard, useBranchPullRequest } = await import("./ship-overview-card");

/** The card as the session header uses it: one PR lookup, shared. */
function Ship({ branch }: { branch: string }) {
  const pr = useBranchPullRequest("/p", branch);
  return <ShipOverviewCard projectPath="/p" branch={branch} pr={pr} />;
}

const keyFinding = {
  fingerprint: "key",
  level: "critical" as const,
  blocking: true,
  class: "secret",
  ruleId: "secret.vendor.stripe-access-token",
  reason: "A credential appears in the added code.",
  path: "server/pay.ts",
  line: 2,
  endLine: 2,
  sha: "3fa91c2aaaa",
  testCode: false,
  notUseful: false,
};

const cp: CheckpointSecurity = {
  checkpointId: "cp-1",
  commitSha: "3fa91c2aaaa",
  status: "done",
  level: "critical",
  blocking: true,
  findings: [keyFinding],
  floors: ["package-lock.json"],
  notScanned: [],
  sensitiveReads: [],
  scannedAt: "2026-10-31T14:30:46Z",
  scanMs: 42,
};

/** Answer each security command from a table. */
function answer(table: Record<string, unknown>) {
  invoke.mockImplementation(async (cmd: string) => table[cmd]);
}

beforeEach(() => {
  resetProjectSecurityForTests();
  invoke.mockReset();
  prList.mockReset();
  useSecurityStore.setState({ sessions: {}, checkpoints: {} });
  listeners.length = 0;
});
afterEach(cleanup);

describe("the Timeline row badge", () => {
  it("shows the level when a session has findings", async () => {
    answer({
      security_project_sessions: [
        { sessionId: "s1", level: "critical", blocking: true, findings: 1, scanned: 1 },
      ],
    });
    render(<SessionSecurityBadge projectPath="/p" sessionId="s1" />);
    expect(await screen.findByText("Critical")).toBeTruthy();
  });

  it("shows nothing for a clean or unscanned session", async () => {
    answer({
      security_project_sessions: [
        { sessionId: "s1", level: "none", blocking: false, findings: 0, scanned: 2 },
      ],
    });
    const { container } = render(<SessionSecurityBadge projectPath="/p" sessionId="s1" />);
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(container.textContent).toBe("");
    const other = render(<SessionSecurityBadge projectPath="/p" sessionId="s2" />);
    expect(other.container.textContent).toBe("");
  });
});

describe("the session summary", () => {
  it("says how many findings count and whether one blocks", async () => {
    answer({ security_session_checkpoints: [cp] });
    render(<SecuritySummary projectPath="/p" sessionId="s1" />);
    expect(await screen.findByText("1 finding, blocks shipping")).toBeTruthy();
  });

  it("leaves a clean session looking as it did before scanning", async () => {
    answer({
      security_session_checkpoints: [{ ...cp, findings: [], level: "none", blocking: false }],
    });
    const { container } = render(<SecuritySummary projectPath="/p" sessionId="s1" />);
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe("");
  });

  it("says nothing for a session with no scans", async () => {
    answer({ security_session_checkpoints: [] });
    const { container } = render(<SecuritySummary projectPath="/p" sessionId="s1" />);
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});

describe("findings in a Checkpoint card", () => {
  async function loaded() {
    answer({ security_session_checkpoints: [cp] });
    await useSecurityStore.getState().actions.loadSession("/p", "s1");
  }

  it("lists the reason and exactly where it is", async () => {
    await loaded();
    render(<CheckpointFindings projectPath="/p" sessionId="s1" commitSha="3fa91c2aaaa" />);
    expect(
      screen.getByText(
        "A credential appears in the added code. Remove it and rotate the key before you push.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "server/pay.ts, line 2" })).toBeTruthy();
    expect(screen.getByText(", Stripe access token")).toBeTruthy();
    expect(screen.getByText("Critical")).toBeTruthy();
  });

  it("dims a finding marked not useful, and Undo brings it back", async () => {
    await loaded();
    answer({ security_set_not_useful: undefined });
    render(<CheckpointFindings projectPath="/p" sessionId="s1" commitSha="3fa91c2aaaa" />);
    fireEvent.click(screen.getByRole("button", { name: "Not useful" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("security_set_not_useful", {
        projectPath: "/p",
        fingerprint: "key",
        ruleId: "secret.vendor.stripe-access-token",
        notUseful: true,
      }),
    );
    expect(screen.getByRole("listitem").dataset.notUseful).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(screen.getByRole("listitem").dataset.notUseful).toBe("false"));
  });

  it("shows the committed line, with the secret hidden, on request", async () => {
    await loaded();
    answer({ security_finding_line: 'const k = "[REDACTED]";' });
    render(<CheckpointFindings projectPath="/p" sessionId="s1" commitSha="3fa91c2aaaa" />);
    fireEvent.click(screen.getByRole("button", { name: "server/pay.ts, line 2" }));
    expect(await screen.findByText('const k = "[REDACTED]";')).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("security_finding_line", {
      projectPath: "/p",
      sha: "3fa91c2aaaa",
      path: "server/pay.ts",
      line: 2,
    });
  });

  it("says a commit was not scanned when the session's others were", async () => {
    await loaded();
    render(<CheckpointFindings projectPath="/p" sessionId="s1" commitSha="older" />);
    expect(
      screen.getByText("Not scanned: made before scanning was turned on for this project."),
    ).toBeTruthy();
  });

  it("says when the agent read a credentials file earlier in the session", async () => {
    answer({ security_session_checkpoints: [{ ...cp, sensitiveReads: [".env", "id_rsa"] }] });
    await useSecurityStore.getState().actions.loadSession("/p", "s1");
    render(<CheckpointFindings projectPath="/p" sessionId="s1" commitSha="3fa91c2aaaa" />);
    expect(
      screen.getByText(/^The agent read \.env and id_rsa earlier in this session\./),
    ).toBeTruthy();
  });

  it("renders nothing for a session with no scans at all", async () => {
    answer({ security_session_checkpoints: [] });
    await useSecurityStore.getState().actions.loadSession("/p", "s1");
    const { container } = render(
      <CheckpointFindings projectPath="/p" sessionId="s1" commitSha="other" />,
    );
    expect(container.textContent).toBe("");
  });
});

describe("Before you ship", () => {
  const overview: ShipOverview = {
    branch: "feat/payments",
    checkpoints: 3,
    level: "critical",
    blocking: true,
    open: [keyFinding],
    fixed: [
      {
        path: "src/render.tsx",
        line: 22,
        ruleId: "ts.html.inner",
        reason: "x",
        fixedIn: "8c1d0e4aaaa",
      },
    ],
    sensitive: [{ path: "package-lock.json", kind: "dependencies" }],
    notScanned: [{ path: "assets/logo.png", reason: "binary" }],
  };

  it("appears only when the branch has an open pull request", async () => {
    prList.mockResolvedValue({ entries: [] });
    answer({ security_ship_overview: overview });
    const { container } = render(<Ship branch="feat/payments" />);
    await waitFor(() => expect(prList).toHaveBeenCalled());
    expect(prList).toHaveBeenCalledWith("/p", { head: "feat/payments", state: "open", limit: 1 });
    expect(container.textContent).toBe("");
  });

  it("appears once a pull request is opened while the session is on screen", async () => {
    prList.mockResolvedValue({ entries: [] });
    answer({ security_ship_overview: overview });
    render(<Ship branch="feat/payments" />);
    await waitFor(() => expect(prList).toHaveBeenCalled());
    prList.mockResolvedValue({
      entries: [
        {
          number: 42,
          url: "https://example.com/pr/42",
          headBranch: "feat/payments",
          baseBranch: "main",
          state: "open",
        },
      ],
    });
    for (const l of listeners) l({ payload: { projectPath: "/p" } });
    expect(await screen.findByText("Before you ship")).toBeTruthy();
  });

  it("rolls the branch up under its pull request", async () => {
    prList.mockResolvedValue({
      entries: [
        {
          number: 42,
          url: "https://example.com/pr/42",
          headBranch: "feat/payments",
          baseBranch: "main",
          state: "open",
        },
      ],
    });
    answer({ security_ship_overview: overview });
    render(<Ship branch="feat/payments" />);
    expect(await screen.findByText("Before you ship")).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("security_ship_overview", {
      projectPath: "/p",
      branch: "feat/payments",
      base: "main",
    });
    expect(screen.getByText("PR #42")).toBeTruthy();
    expect(screen.getByText("Blocks shipping")).toBeTruthy();
    expect(screen.getByText("server/pay.ts, line 2")).toBeTruthy();
    expect(screen.getByText("fixed in 8c1d0e4")).toBeTruthy();
    expect(screen.getByText("package-lock.json")).toBeTruthy();
    expect(screen.getByText("assets/logo.png")).toBeTruthy();
  });
});
