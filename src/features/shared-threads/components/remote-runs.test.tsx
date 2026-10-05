// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { RemoteRun, SharedThreadView } from "../lib/shared-threads-api";

// The design system's styling libraries are not what is under test.
vi.mock("@/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/ui/button", () => ({
  Button: ({
    children,
    size: _size,
    variant: _variant,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { size?: string; variant?: string }) => (
    <button type="button" {...rest}>
      {children}
    </button>
  ),
}));
vi.mock("@/ui/dialog", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    Dialog: Pass,
    DialogContent: Pass,
    DialogDescription: Pass,
    DialogFooter: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
  };
});
vi.mock("@/features/chat/lib/agents-api", () => ({ agents: {}, ensureAgent: vi.fn() }));
vi.mock("@/features/chat/lib/open-agent-session", () => ({ openAgentSession: vi.fn() }));
vi.mock("@/features/agents/lib/agent-meta", () => ({
  agentMeta: (id: string) => ({ label: id === "claude-code" ? "Claude Code" : id }),
  useSwitchableAgents: () => ["claude-code"],
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const { AskTeammate, RemoteRunApproval, approvedForMe, pendingForMe, secondsLeft } = await import(
  "./remote-runs"
);

const REQUEST: RemoteRun = {
  requestId: "R1",
  threadId: "thr_1",
  requestedBy: "monzim",
  runnerId: "joy",
  prompt: "make the banner teal",
  agent: "claude-code",
  model: null,
  status: "pending",
  auto: false,
  requestedAt: 1_000,
  expiresAt: 61_000,
  answeredAt: null,
  runId: null,
};

function thread(requests: RemoteRun[], userId = "joy"): SharedThreadView {
  return {
    sharedThreadId: "thr_1",
    title: "Banner",
    status: { remote: { userId, agents: ["claude-code"], accept: true, autoApprove: null, requests } },
  } as unknown as SharedThreadView;
}

const nameOf = (id: string) => ({ monzim: "Monzim", joy: "Joy" })[id] ?? id;

afterEach(cleanup);

describe("which requests ask this person", () => {
  it("asks the Runner about pending requests, never the asker", () => {
    expect(pendingForMe([thread([REQUEST])]).map((p) => p.request.requestId)).toEqual(["R1"]);
    expect(pendingForMe([thread([REQUEST], "monzim")])).toEqual([]);
    expect(pendingForMe([thread([{ ...REQUEST, status: "declined" }])])).toEqual([]);
  });

  it("runs approved requests once, and only its Runner's", () => {
    const approved = { ...REQUEST, status: "approved" as const };
    expect(approvedForMe([thread([approved])]).map((p) => p.request.requestId)).toEqual(["R1"]);
    expect(approvedForMe([thread([{ ...approved, runId: "run-1" }])])).toEqual([]);
    expect(approvedForMe([thread([approved], "monzim")])).toEqual([]);
  });

  it("runs nothing this machine does not accept, offer or auto-approve", () => {
    const approved = { ...REQUEST, status: "approved" as const };
    const view = (remote: object) =>
      ({
        sharedThreadId: "thr_1",
        title: "Banner",
        status: {
          remote: { userId: "joy", agents: ["claude-code"], accept: true, autoApprove: null, requests: [approved], ...remote },
        },
      }) as unknown as SharedThreadView;
    expect(approvedForMe([view({ accept: false })])).toEqual([]);
    expect(approvedForMe([view({ requests: [{ ...approved, agent: "codex" }] })])).toEqual([]);
    expect(approvedForMe([view({ requests: [{ ...approved, auto: true }] })])).toEqual([]);
    expect(approvedForMe([view({ autoApprove: "monzim", requests: [{ ...approved, auto: true }] })])).toHaveLength(1);
  });
});

describe("the approval dialog", () => {
  it("shows who asks, the thread, the exact prompt, the agent and the bill", () => {
    render(
      <RemoteRunApproval request={REQUEST} threadTitle="Banner" nameOf={nameOf} now={1_000} onAnswer={() => {}} />,
    );
    expect(screen.getByText("Monzim wants to run an agent on your machine")).toBeTruthy();
    expect(screen.getByText("Banner")).toBeTruthy();
    expect(screen.getByLabelText("Prompt").textContent).toBe("make the banner teal");
    expect(screen.getByText("Claude Code")).toBeTruthy();
    expect(screen.getByText(/on your bill/)).toBeTruthy();
    expect(screen.getByText(/Declines in 60s/)).toBeTruthy();
  });

  it("approves, with auto-approve for this person when ticked", () => {
    const onAnswer = vi.fn();
    render(<RemoteRunApproval request={REQUEST} threadTitle="Banner" nameOf={nameOf} now={1_000} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByLabelText("Always approve Monzim in this thread"));
    fireEvent.click(screen.getByText("Approve and run"));
    expect(onAnswer).toHaveBeenCalledWith(true, true);
    // Once only.
    fireEvent.click(screen.getByText("Decline"));
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  it("declines by hand, and by itself when the countdown runs out", () => {
    const byHand = vi.fn();
    render(<RemoteRunApproval request={REQUEST} threadTitle="Banner" nameOf={nameOf} now={1_000} onAnswer={byHand} />);
    fireEvent.click(screen.getByText("Decline"));
    expect(byHand).toHaveBeenCalledWith(false, false);
    cleanup();

    const late = vi.fn();
    const { rerender } = render(
      <RemoteRunApproval request={REQUEST} threadTitle="Banner" nameOf={nameOf} now={60_500} onAnswer={late} />,
    );
    expect(late).not.toHaveBeenCalled();
    rerender(<RemoteRunApproval request={REQUEST} threadTitle="Banner" nameOf={nameOf} now={61_000} onAnswer={late} />);
    expect(late).toHaveBeenCalledWith(false, false);
  });

  it("counts whole seconds down to zero", () => {
    expect(secondsLeft(61_000, 1_000)).toBe(60);
    expect(secondsLeft(61_000, 60_001)).toBe(1);
    expect(secondsLeft(61_000, 99_000)).toBe(0);
  });
});

describe("asking a teammate's agent", () => {
  it("offers each online Runner's agents and sends the prompt to the chosen one", () => {
    const onAsk = vi.fn(() => Promise.resolve());
    render(
      <AskTeammate
        runners={[
          { userId: "joy", agents: ["claude-code", "codex"] },
          { userId: "val", agents: ["codex"] },
        ]}
        nameOf={nameOf}
        busy={false}
        onAsk={onAsk}
      />,
    );
    const picker = screen.getByLabelText("Run on") as HTMLSelectElement;
    expect([...picker.options].map((o) => o.textContent)).toEqual([
      "Ask Joy's Claude Code",
      "Ask Joy's codex",
      "Ask val's codex",
    ]);
    fireEvent.change(picker, { target: { value: "val|codex" } });
    fireEvent.change(screen.getByLabelText("Prompt for a teammate's agent"), {
      target: { value: "  fix the footer " },
    });
    fireEvent.submit(picker.closest("form")!);
    expect(onAsk).toHaveBeenCalledWith("val", "codex", "fix the footer");
  });

  it("offers nobody when no Runner is online", () => {
    const { container } = render(<AskTeammate runners={[]} nameOf={nameOf} busy={false} onAsk={vi.fn()} />);
    expect(container.textContent).toBe("");
  });
});
