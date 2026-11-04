// @vitest-environment happy-dom
//
// The sign-in surface's own rules: which phases get the dialog and which the
// dock, that the dock never takes the keyboard from the terminal behind it,
// and which ways out dismiss. The flow itself is the container's; the phase →
// surface decision is `lib/sign-in-methods.test.ts`.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AuthMethodWire, SignInPhase } from "../../lib/sign-in-methods";
import { AgentSignInView } from "./agent-sign-in-view";

const BROWSER: AuthMethodWire = {
  id: "browser",
  name: "Sign in with a browser",
  description: null,
  kind: "agent",
  link: null,
  terminalCommand: null,
  terminalArgs: null,
  terminalLabel: null,
  apiKeyProvider: null,
};
const CLI: AuthMethodWire = {
  id: "cli",
  name: "Sign in from a terminal",
  description: null,
  kind: "terminal",
  link: null,
  terminalCommand: null,
  terminalArgs: null,
  terminalLabel: null,
  apiKeyProvider: null,
};

function renderView(phase: SignInPhase) {
  const handlers = {
    onChooseMethod: vi.fn(),
    onDismiss: vi.fn(),
    onTerminalDone: vi.fn(),
  };
  render(
    <AgentSignInView
      label="Demo"
      phase={phase}
      env={[]}
      tail={[]}
      authUrl={null}
      supportsLogout={false}
      centerX={null}
      dockHidden={false}
      onBackToMethods={vi.fn()}
      onContinueEnv={vi.fn()}
      onRetry={vi.fn()}
      onSignOut={vi.fn()}
      onOpenUrl={vi.fn()}
      onCopyCommand={vi.fn()}
      {...handlers}
    />,
  );
  return handlers;
}

const TERMINAL: SignInPhase = {
  kind: "terminal",
  method: CLI,
  command: "demo-agent login",
  terminal: null,
};

afterEach(cleanup);

describe("AgentSignInView", () => {
  it("asks in a dialog: choosing a method answers with it", () => {
    const { onChooseMethod } = renderView({ kind: "choose", methods: [BROWSER, CLI] });
    expect(screen.getByTestId("sign-in-dialog")).toBeTruthy();
    expect(screen.queryByTestId("sign-in-dock")).toBeNull();
    fireEvent.click(screen.getByText("Sign in from a terminal"));
    expect(onChooseMethod).toHaveBeenCalledWith(CLI);
  });

  it("Esc dismisses the dialog", () => {
    const { onDismiss } = renderView({ kind: "choose", methods: [BROWSER] });
    fireEvent.keyDown(screen.getByTestId("sign-in-dialog"), { key: "Escape" });
    expect(onDismiss).toHaveBeenCalled();
  });

  it("hands the terminal phase to the dock, which never takes focus", async () => {
    renderView(TERMINAL);
    expect(screen.getByTestId("sign-in-dock")).toBeTruthy();
    expect(screen.queryByTestId("sign-in-dialog")).toBeNull();
    // Give Base UI its chance to move focus; it must not.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId("sign-in-dock").contains(document.activeElement)).toBe(false);
  });

  it("Esc does not dismiss the terminal dock — the TUI uses it", () => {
    const { onDismiss } = renderView(TERMINAL);
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.keyDown(screen.getByTestId("sign-in-dock"), { key: "Escape" });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("a click outside the dock does not dismiss it", () => {
    const { onDismiss } = renderView(TERMINAL);
    fireEvent.pointerDown(document.body);
    fireEvent.mouseDown(document.body);
    fireEvent.click(document.body);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("the dock's ✕ and \"I've finished\" answer", async () => {
    const { onDismiss, onTerminalDone } = renderView(TERMINAL);
    fireEvent.click(screen.getByText("I've finished signing in"));
    expect(onTerminalDone).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
  });

  it("shows a status pill while it resolves the methods", () => {
    renderView({ kind: "loading" });
    expect(screen.getByTestId("sign-in-dock").textContent).toContain("Starting Demo…");
  });
});
