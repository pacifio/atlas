// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { copyText } from "./clipboard";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

describe("copyText", () => {
  const originalClipboard = navigator.clipboard;

  beforeEach(() => {
    vi.clearAllMocks();
    document.execCommand = vi.fn();
  });

  afterEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: originalClipboard,
      writable: true,
      configurable: true,
    });
  });

  it("returns true when invoke succeeds", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    const ok = await copyText("hello world");
    expect(ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith("clipboard_write_text", { text: "hello world" });
  });

  it("falls back to navigator.clipboard when invoke fails", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("IPC failed"));
    const writeTextMock = vi.fn().mockResolvedValueOnce(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextMock },
      writable: true,
      configurable: true,
    });

    const ok = await copyText("test fallback");
    expect(ok).toBe(true);
    expect(writeTextMock).toHaveBeenCalledWith("test fallback");
  });

  it("falls back to document.execCommand when navigator.clipboard fails", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("IPC failed"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValueOnce(new Error("NotAllowedError")) },
      writable: true,
      configurable: true,
    });
    const execMock = vi.spyOn(document, "execCommand").mockReturnValueOnce(true);

    const ok = await copyText("test execCommand");
    expect(ok).toBe(true);
    expect(execMock).toHaveBeenCalledWith("copy");
    execMock.mockRestore();
  });

  it("returns false when all copy mechanisms fail", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("IPC failed"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValueOnce(new Error("NotAllowedError")) },
      writable: true,
      configurable: true,
    });
    const execMock = vi.spyOn(document, "execCommand").mockReturnValueOnce(false);

    const ok = await copyText("fail test");
    expect(ok).toBe(false);
    execMock.mockRestore();
  });

  it("cleans up textarea DOM node even if execCommand throws", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("IPC failed"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValueOnce(new Error("NotAllowedError")) },
      writable: true,
      configurable: true,
    });
    const removeChildSpy = vi.spyOn(document.body, "removeChild");
    const execMock = vi.spyOn(document, "execCommand").mockImplementationOnce(() => {
      throw new Error("execCommand failed");
    });

    const ok = await copyText("throw test");
    expect(ok).toBe(false);
    expect(removeChildSpy).toHaveBeenCalled();
    execMock.mockRestore();
    removeChildSpy.mockRestore();
  });
});
