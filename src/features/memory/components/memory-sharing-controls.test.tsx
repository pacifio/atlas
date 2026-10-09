// @vitest-environment happy-dom
// The Memory panel's sharing popover: the "sessions outside Atlas" switch is
// off by default, persists through its own command, and is inert while Shared
// is off (nothing is extracted then, so it would promise nothing).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemorySharingControls } from "./memory-sharing-controls";
import { useMemorySharingStore } from "../stores/memory-sharing-store";
import {
  EXTERNAL_SESSIONS_LABEL,
  EXTERNAL_SESSIONS_NEEDS_SHARING,
} from "../lib/memory-sharing-copy";

const PROJECT = "/work/acme";

function backend({ sharing, external }: { sharing: boolean; external: boolean }) {
  invoke.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "memory_sharing_get":
        return sharing;
      case "memory_from_external_sessions_get":
        return external;
      case "memory_summarizer_get":
        return { mode: "raw", provider: "", model: "" };
      case "byok_list":
        return {};
      default:
        return null;
    }
  });
}

async function openPopover() {
  render(<MemorySharingControls projectPath={PROJECT} />);
  await waitFor(() => expect(useMemorySharingStore.getState().loaded).toBe(true));
  await userEvent.click(screen.getByLabelText("Memory sharing settings"));
  return screen.findByRole("switch", { name: EXTERNAL_SESSIONS_LABEL });
}

beforeEach(() => {
  invoke.mockReset();
  useMemorySharingStore.setState({
    projectPath: null,
    enabled: true,
    fromExternalSessions: false,
    loaded: false,
  });
});
afterEach(cleanup);

describe("the sessions-outside-Atlas switch", () => {
  it("is off by default and turning it on persists for the project", async () => {
    backend({ sharing: true, external: false });
    const toggle = await openPopover();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.hasAttribute("disabled")).toBe(false);

    await userEvent.click(toggle);
    expect(invoke).toHaveBeenCalledWith("memory_from_external_sessions_set", {
      projectPath: PROJECT,
      enabled: true,
    });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("shows the stored choice but is disabled while Shared is off", async () => {
    backend({ sharing: false, external: true });
    const toggle = await openPopover();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(EXTERNAL_SESSIONS_NEEDS_SHARING)).toBeTruthy();

    await userEvent.click(toggle);
    expect(invoke).not.toHaveBeenCalledWith("memory_from_external_sessions_set", expect.anything());
  });
});
