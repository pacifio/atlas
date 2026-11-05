// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import {
  classifyPrError,
  GH_UNAVAILABLE_FOR_MS,
  ghGate,
  isPrError,
  noteGhOutcome,
  prErrorMessage,
  prRetryDelay,
  RATE_LIMIT_FALLBACK_MS,
  resetGhGateForTests,
  shouldRetryPrError,
} from "./pr-errors";

afterEach(() => resetGhGateForTests());

describe("classifyPrError", () => {
  it("passes a native PrError through, keeping only its known fields", () => {
    expect(classifyPrError({ kind: "rateLimited", retryAt: 1234, extra: true })).toEqual({
      kind: "rateLimited",
      retryAt: 1234,
    });
    expect(classifyPrError({ kind: "failed", message: "boom" })).toEqual({
      kind: "failed",
      message: "boom",
    });
  });

  it("reads a bare string or an Error by its words", () => {
    expect(classifyPrError("API rate limit exceeded").kind).toBe("rateLimited");
    expect(classifyPrError(new Error("run gh auth login first")).kind).toBe("notAuthenticated");
    expect(classifyPrError("request timed out").kind).toBe("network");
    expect(classifyPrError("something else")).toEqual({
      kind: "failed",
      message: "something else",
    });
  });

  it("does not mistake an object with an unknown kind for a PrError", () => {
    expect(classifyPrError({ kind: "mystery" }).kind).toBe("failed");
    expect(isPrError({ kind: "mystery" })).toBe(false);
    expect(isPrError({ kind: "notFound" })).toBe(true);
  });

  it("says what to do about each wall", () => {
    expect(prErrorMessage({ kind: "notInstalled" })).toMatch(/Install the GitHub CLI/);
    expect(prErrorMessage({ kind: "notAuthenticated" })).toMatch(/gh auth login/);
    expect(prErrorMessage({ kind: "failed", message: "Nope." })).toBe("Nope.");
  });
});

describe("retry policy", () => {
  it("retries only a transient failure, and only a few times", () => {
    expect(shouldRetryPrError(0, { kind: "network" })).toBe(true);
    expect(shouldRetryPrError(2, { kind: "network" })).toBe(true);
    expect(shouldRetryPrError(3, { kind: "network" })).toBe(false);
    for (const kind of ["notInstalled", "notAuthenticated", "rateLimited", "notFound", "failed"]) {
      expect(shouldRetryPrError(0, { kind })).toBe(false);
    }
  });

  it("backs off by doubling, jittered and capped", () => {
    expect(prRetryDelay(0, () => 0)).toBe(500);
    expect(prRetryDelay(0, () => 1)).toBe(1_000);
    expect(prRetryDelay(3, () => 1)).toBe(8_000);
    expect(prRetryDelay(20, () => 1)).toBe(30_000);
  });
});

describe("the gh gate", () => {
  it("holds reads back while gh is missing, for a bounded time", () => {
    noteGhOutcome({ kind: "notInstalled" }, 1_000);
    expect(ghGate(1_000 + GH_UNAVAILABLE_FOR_MS - 1)).toEqual({ kind: "notInstalled" });
    expect(ghGate(1_000 + GH_UNAVAILABLE_FOR_MS)).toBeNull();
  });

  it("opens when the window is focused, which is when a sign-in lands", () => {
    noteGhOutcome({ kind: "notAuthenticated" });
    expect(ghGate()).not.toBeNull();
    window.dispatchEvent(new Event("focus"));
    expect(ghGate()).toBeNull();
  });

  it("waits out a rate limit until the time GitHub named, focus or not", () => {
    const now = 10_000;
    noteGhOutcome({ kind: "rateLimited", retryAt: now + 5_000 }, now);
    window.dispatchEvent(new Event("focus"));
    expect(ghGate(now + 4_999)?.kind).toBe("rateLimited");
    expect(ghGate(now + 5_000)).toBeNull();

    noteGhOutcome({ kind: "rateLimited" }, now);
    expect(ghGate(now + RATE_LIMIT_FALLBACK_MS - 1)?.kind).toBe("rateLimited");
  });

  it("is not closed by a failure that belongs to one repository", () => {
    noteGhOutcome({ kind: "notFound" });
    noteGhOutcome({ kind: "network" });
    noteGhOutcome({ kind: "unsupported" });
    expect(ghGate()).toBeNull();
  });

  it("opens again after a read succeeds", () => {
    noteGhOutcome({ kind: "notAuthenticated" });
    noteGhOutcome(null);
    expect(ghGate()).toBeNull();
  });
});
