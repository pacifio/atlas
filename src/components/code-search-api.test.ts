import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pins the IPC shape of the project search: Tauri maps these camelCase keys
 * onto `code_grep`'s snake_case parameters, and a misspelt key is not an
 * error — the option just silently stays at its default.
 */

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

const { codeGrep, SEARCH_MAX_RESULTS } = await import("./code-search-api");

describe("codeGrep", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
  });

  it("sends the overlay's switches under the names the Rust command takes", async () => {
    const answer = {
      matches: [{ path: "src/a.ts", line: 3, text: "foo(1)" }],
      totalMatches: 1,
      totalFiles: 1,
      truncated: false,
      partial: false,
    };
    mocks.invoke.mockResolvedValue(answer);
    const res = await codeGrep("/p", "foo(", {
      regex: false,
      caseSensitive: true,
      wholeWord: false,
    });
    expect(mocks.invoke).toHaveBeenCalledWith("code_grep", {
      path: "/p",
      query: "foo(",
      regex: false,
      caseSensitive: true,
      wholeWord: false,
      maxResults: SEARCH_MAX_RESULTS,
    });
    expect(res).toEqual(answer);
  });

  it("rejects with the engine's message, for the overlay to show", async () => {
    const message =
      "regex error: look-around, including look-ahead and look-behind, is not supported.";
    mocks.invoke.mockRejectedValue(message);
    await expect(
      codeGrep("/p", "(?<=a)b", { regex: true, caseSensitive: false, wholeWord: false }),
    ).rejects.toBe(message);
  });
});
