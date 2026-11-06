import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { classifySearchError } from "./github-api";

describe("classifySearchError", () => {
  it("reads a rate limit as a wait", () => {
    expect(classifySearchError("GitHub rate limit reached. Try again in 3 min.")).toEqual({
      kind: "rate-limited",
      message: "GitHub rate limit reached. Try again in 3 min.",
    });
  });

  it("reads anything else as a failure", () => {
    expect(classifySearchError(new Error("GitHub answered 500"))).toEqual({
      kind: "failed",
      message: "GitHub answered 500",
    });
    expect(classifySearchError("GitHub answered 403").kind).toBe("failed");
  });
});
