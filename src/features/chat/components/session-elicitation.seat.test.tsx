// @vitest-environment happy-dom
//
// An agent's question is steering (design review §4.4): while someone else
// holds the remote-control seat, the local card and dialog say so and send
// nothing — Rust refuses the answer anyway; this is the explanation first.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));

import { cleanup, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { SessionElicitation } from "./session-elicitation";
import { ElicitationModal, type PendingElicitation } from "./elicitation-modal";

afterEach(cleanup);

const question: PendingElicitation = {
  agentId: "agent-1",
  requestId: "req-1",
  mode: "form",
  message: "Which branch?",
  requestedSchema: {
    type: "object",
    properties: { branch: { type: "string", enum: ["main", "dev"] } },
    required: ["branch"],
  },
};

describe("SessionElicitation under a remote driver", () => {
  it("replaces the card with a line naming the driver", () => {
    render(<SessionElicitation pending={question} onClose={() => {}} remoteDriver="Ada" />);
    const notice = screen.getByTestId("elicitation-seat-notice");
    expect(notice.textContent).toContain("Ada is driving");
    expect(screen.queryByRole("button", { name: /Decline/ })).toBeNull();
  });

  it("shows the card when the seat is ours", () => {
    render(<SessionElicitation pending={question} onClose={() => {}} remoteDriver={null} />);
    expect(screen.queryByTestId("elicitation-seat-notice")).toBeNull();
    expect(screen.getByRole("button", { name: /Decline/ })).toBeTruthy();
  });
});

describe("ElicitationModal under a remote driver", () => {
  it("disables Send and Decline and says why", () => {
    render(
      <ElicitationModal
        pending={{ ...question, mode: "url", url: "https://example.invalid/login" }}
        onClose={() => {}}
        remoteDriver="Ada"
      />,
    );
    expect(screen.getByTestId("elicitation-seat-notice").textContent).toContain("Ada");
    expect((screen.getByRole("button", { name: "I'm done" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: "Decline" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });
});
