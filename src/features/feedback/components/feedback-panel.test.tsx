// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The panel reaches Tauri only through the store's actions; `convertFileSrc` is
// imported by the avatar for the photo path this fixture deliberately leaves
// null. The submit test observes invoke; avatar imports resolve outside Tauri.
const invokeMock = vi.hoisted(() =>
  vi.fn(async (command: string) =>
    command === "feedback_submit"
      ? { sent: true, anonymous: true, screenshotDropped: false }
      : null,
  ),
);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  convertFileSrc: (path: string) => path,
}));

// The settings store subscribes to config events at import time, behind a
// `typeof window` guard that happy-dom satisfies. Outside a real Tauri host
// that `listen` throws, which surfaces as an unhandled rejection and fails the
// run even when every assertion passed.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { useAuthStore } from "@/features/auth/stores/auth-store";

import { useFeedbackStore } from "../stores/feedback-store";

import { FeedbackPanel } from "./feedback-panel";

const USER = {
  id: "user_1",
  name: "Jane Doe",
  email: "jane@example.com",
  avatarPath: null,
};

/** Issue #69: the identity row read as a status line, and its state could not
 *  be told apart from a label. It is a switch now, and these pin the parts of
 *  that which a screenshot cannot show. */
describe("feedback anonymity control (issue #69)", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    useAuthStore.setState({
      snapshot: {
        status: "signed-in",
        user: USER,
        orgs: null,
        activeOrgId: null,
        commsOrgId: null,
      },
    });
    useFeedbackStore.setState({
      open: true,
      anonymous: false,
      message: "",
      shot: null,
      submitting: false,
      sent: false,
      error: null,
    });
  });

  afterEach(() => {
    cleanup();
    useFeedbackStore.setState({ open: false });
  });

  const switchControl = () => screen.getByRole("switch", { name: "Send anonymously" });

  it("is a switch, named by what it controls rather than by the state it shows", () => {
    render(<FeedbackPanel />);

    expect(switchControl().getAttribute("aria-checked")).toBe("false");
    // The visible text changes with the state. If it doubled as the accessible
    // name, a screen reader would read "Sending as Jane Doe, switch, off" —
    // a control whose name contradicts its own state.
    expect(screen.queryByRole("switch", { name: /Sending as/ })).toBeNull();
    expect(screen.getByText("Sending as Jane Doe")).toBeTruthy();
  });

  it("drops the native title, so the hint is the app's own tooltip", () => {
    render(<FeedbackPanel />);

    // `Hint` clears the title and carries the copy in the themed tooltip, which
    // opens on the shared delay instead of the ~1s OS one.
    expect(switchControl().getAttribute("title")).toBeNull();
  });

  it("confirms the new mode in the visible label and in aria-checked", async () => {
    const user = userEvent.setup();
    render(<FeedbackPanel />);

    await user.click(switchControl());

    expect(switchControl().getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Sending anonymously")).toBeTruthy();
    expect(screen.queryByText("Sending as Jane Doe")).toBeNull();
    // The store is the submit payload's source, so the toggle has to land here.
    expect(useFeedbackStore.getState().anonymous).toBe(true);
  });

  it("passes anonymous mode through the actual feedback submission", async () => {
    const user = userEvent.setup();
    render(<FeedbackPanel />);

    await user.type(screen.getByRole("textbox", { name: "Your feedback" }), "Anonymous report");
    await user.click(switchControl());
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("feedback_submit", {
        input: expect.objectContaining({
          anonymous: true,
          message: "Anonymous report",
        }),
      }),
    );
  });
});
