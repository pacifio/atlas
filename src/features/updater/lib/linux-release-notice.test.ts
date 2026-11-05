import { beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.fn();
const openUrl = vi.fn(async (_url: string) => {});
const invoke = vi.fn(async (_cmd: string, _args?: unknown) => {});
vi.mock("sonner", () => ({ toast }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const { announceLinuxRelease } = await import("./linux-release-notice");

interface ToastOptions {
  id: string;
  action: { onClick: () => void };
  cancel: { onClick: () => void };
}

describe("announceLinuxRelease", () => {
  beforeEach(() => {
    toast.mockClear();
    openUrl.mockClear();
    invoke.mockClear();
  });

  it("says nothing for an event without a release page", () => {
    announceLinuxRelease({ version: "0.4.2", currentVersion: "0.4.1" });
    expect(toast).not.toHaveBeenCalled();
  });

  it("names the version once, opens the page, and can skip the version", () => {
    const url = "https://github.com/pacifio/atlas/releases/tag/alpha-0.4.2";
    announceLinuxRelease({ version: "0.4.2", currentVersion: "0.4.1", url });

    expect(toast).toHaveBeenCalledTimes(1);
    const [title, options] = toast.mock.calls[0] as unknown as [string, ToastOptions];
    expect(title).toBe("Atlas 0.4.2 is available");
    expect(options.id).toBe("linux-release:0.4.2");

    options.action.onClick();
    expect(openUrl).toHaveBeenCalledWith(url);

    options.cancel.onClick();
    expect(invoke).toHaveBeenCalledWith("update_ignore", { version: "0.4.2" });
  });
});
