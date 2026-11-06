// @vitest-environment happy-dom
// The copy button never sees the `toast.error(title, { description })` call — it
// lives in sonner's icon slot — so it reads the text back out of the rendered
// toast. These pin what that read produces, against a real `<Toaster>`.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Toaster, toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

const copyText = vi.fn(async (_text: string) => true);
vi.mock("@/lib/clipboard", () => ({ copyText: (text: string) => copyText(text) }));

import { useAskAgentStore } from "@/features/ask-agent/stores/ask-agent-store";
import { TOAST_ICONS, toastCopyText } from "./toast-icons";

// `globals: false` in vitest.config.ts — auto-cleanup is not registered.
beforeEach(() => {
  cleanup();
  toast.dismiss();
  copyText.mockClear();
});

function toastElement(title: string, description?: string): HTMLElement {
  const li = document.createElement("li");
  li.setAttribute("data-sonner-toast", "");
  li.innerHTML = `<div data-content><div data-title>${title}</div>${
    description === undefined ? "" : `<div data-description>${description}</div>`
  }</div>`;
  return li;
}

describe("toastCopyText", () => {
  it("is the title alone when there is no description", () => {
    expect(toastCopyText(toastElement("Saved"))).toBe("Saved");
  });

  it("puts the description on its own line after the title", () => {
    expect(toastCopyText(toastElement("Action failed", "  Failed to spawn Codex CLI  "))).toBe(
      "Action failed\nFailed to spawn Codex CLI",
    );
  });

  it("is empty for no toast", () => {
    expect(toastCopyText(null)).toBe("");
  });
});

describe("the copy button in a live toast", () => {
  it("copies an error toast's title and description", async () => {
    render(<Toaster closeButton icons={TOAST_ICONS} />);
    act(() => {
      toast.error("Action failed", { description: "Failed to spawn Codex CLI process" });
    });

    const button = await screen.findByRole("button", { name: "Copy message" });
    await act(async () => {
      fireEvent.click(button);
    });

    expect(copyText).toHaveBeenCalledWith("Action failed\nFailed to spawn Codex CLI process");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("offers Fix with agent on an error with a cause, with its text as the error", async () => {
    render(<Toaster closeButton icons={TOAST_ICONS} />);
    act(() => {
      toast.error("Couldn't refresh the model list", { description: "gateway answered 502" });
    });
    const fix = await screen.findByRole("button", { name: /Fix with agent/ });
    fireEvent.click(fix);
    expect(useAskAgentStore.getState().request).toMatchObject({
      prompt: "Fix this: ",
      context: [
        {
          kind: "error",
          source: "Atlas",
          message: "Couldn't refresh the model list\ngateway answered 502",
        },
      ],
    });
    useAskAgentStore.setState({ request: null });
  });

  it("leaves Fix with agent off an error with nothing to fix", async () => {
    render(<Toaster closeButton icons={TOAST_ICONS} />);
    act(() => {
      toast.error("Couldn't copy");
    });
    await screen.findByRole("button", { name: "Copy message" });
    expect(screen.queryByRole("button", { name: /Fix with agent/ })).toBeNull();
  });

  it("renders sonner's close button alongside", async () => {
    render(<Toaster closeButton icons={TOAST_ICONS} />);
    act(() => {
      toast.success("Saved");
    });
    expect(await screen.findByRole("button", { name: "Close toast" })).toBeTruthy();
  });
});
