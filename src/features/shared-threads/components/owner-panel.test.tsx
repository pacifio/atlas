// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { OwnerView } from "../lib/shared-threads-api";

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

const VIEW: OwnerView = {
  joinPolicy: "approval",
  status: "open",
  closedAt: null,
  purgeAt: null,
  participants: [
    { userId: "joy", role: "owner", joinedAt: 1 },
    { userId: "monzim", role: "participant", joinedAt: 2 },
  ],
  requests: [{ userId: "alice", requestedAt: 3 }],
};

const api = {
  ownerView: vi.fn(),
  setRole: vi.fn(),
  declineJoin: vi.fn(),
  setJoinPolicy: vi.fn(),
  setThreadOpen: vi.fn(),
};
vi.mock("../lib/shared-threads-api", () => ({
  ...api,
  sharedThreadError: (e: unknown) => ({ code: "x", message: String(e) }),
  listThreads: () => Promise.resolve([]),
  onSharedThreadsChanged: () => Promise.resolve(() => {}),
  onSharedRunFrame: () => Promise.resolve(() => {}),
  onJoinRequested: () => Promise.resolve(() => {}),
}));

const { OwnerPanel } = await import("./owner-panel");

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  // Resolved by hand: a mock that returns a rejected promise trips Vitest 4.
  api.ownerView.mockImplementation(() => Promise.resolve(VIEW));
});
afterEach(cleanup);

describe("the owner's panel (ATL-406)", () => {
  it("approves a join request, and shows the answer", async () => {
    api.setRole.mockImplementation(() =>
      Promise.resolve({
        ...VIEW,
        requests: [],
        participants: [...VIEW.participants, { userId: "alice", role: "participant", joinedAt: 4 }],
      }),
    );
    render(<OwnerPanel sharedThreadId="T" />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve alice" }));
    expect(api.setRole).toHaveBeenCalledWith("T", "alice", "participant");
    await waitFor(() => expect(screen.queryByText("Waiting to join")).toBeNull());
    expect(screen.getByRole("group", { name: "alice's role" })).toBeTruthy();
  });

  it("declines a join request", async () => {
    api.declineJoin.mockImplementation(() => Promise.resolve({ ...VIEW, requests: [] }));
    render(<OwnerPanel sharedThreadId="T" />);
    fireEvent.click(await screen.findByRole("button", { name: "Decline alice" }));
    expect(api.declineJoin).toHaveBeenCalledWith("T", "alice");
    await waitFor(() => expect(screen.queryByText("alice")).toBeNull());
  });

  it("changes a role, and never offers to change the owner's", async () => {
    api.setRole.mockImplementation(() => Promise.resolve(VIEW));
    render(<OwnerPanel sharedThreadId="T" />);
    const group = await screen.findByRole("group", { name: "monzim's role" });
    fireEvent.click(group.querySelector('[aria-pressed="false"]')!);
    expect(api.setRole).toHaveBeenCalledWith("T", "monzim", "viewer");
    expect(screen.queryByRole("group", { name: "joy's role" })).toBeNull();
  });

  it("toggles approval required", async () => {
    api.setJoinPolicy.mockImplementation(() => Promise.resolve({ ...VIEW, joinPolicy: "auto" }));
    render(<OwnerPanel sharedThreadId="T" />);
    const box = await screen.findByRole("checkbox", { name: "Approval required to join" });
    expect((box as HTMLInputElement).checked).toBe(true);
    fireEvent.click(box);
    expect(api.setJoinPolicy).toHaveBeenCalledWith("T", "auto");
    await waitFor(() => expect((box as HTMLInputElement).checked).toBe(false));
  });

  it("closes only after confirming, and reopens", async () => {
    api.setThreadOpen.mockImplementation((_id: string, open: boolean) =>
      Promise.resolve({ ...VIEW, status: open ? "open" : "closed" }),
    );
    render(<OwnerPanel sharedThreadId="T" />);
    fireEvent.click(await screen.findByRole("button", { name: /Close…/ }));
    expect(api.setThreadOpen).not.toHaveBeenCalled();
    expect(screen.getByText(/read-only/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close thread" }));
    expect(api.setThreadOpen).toHaveBeenCalledWith("T", false);
    fireEvent.click(await screen.findByRole("button", { name: /Reopen/ }));
    expect(api.setThreadOpen).toHaveBeenCalledWith("T", true);
  });
});
