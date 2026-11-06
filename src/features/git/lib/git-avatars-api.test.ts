import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The `git_repo_avatars` seam: which command it targets and the payload Rust
 * destructures (`path`), plus the "gh unavailable" back-off. Pattern:
 * `byok-api.test.ts`.
 */
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { fetchRepoAvatars, repoAvatars, resetGhAvatarsAvailabilityForTests } =
  await import("./git-avatars-api");

beforeEach(() => {
  invoke.mockReset();
  resetGhAvatarsAvailabilityForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("repoAvatars", () => {
  it("calls git_repo_avatars with the repository path", async () => {
    invoke.mockResolvedValue({ kind: "ok", byEmail: {} });
    await repoAvatars("/repo");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("git_repo_avatars", { path: "/repo" });
  });
});

describe("fetchRepoAvatars", () => {
  it("stops asking once gh is unavailable", async () => {
    invoke.mockResolvedValue({ kind: "unavailable" });
    await fetchRepoAvatars("/a");
    expect(await fetchRepoAvatars("/b")).toEqual({ kind: "unavailable" });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("asks again after the back-off, so a gh sign-in is picked up", async () => {
    vi.useFakeTimers();
    invoke.mockResolvedValueOnce({ kind: "unavailable" });
    await fetchRepoAvatars("/a");
    vi.advanceTimersByTime(10 * 60_000 + 1);
    invoke.mockResolvedValueOnce({ kind: "ok", byEmail: { "a@x.dev": "u" } });
    expect(await fetchRepoAvatars("/a")).toEqual({ kind: "ok", byEmail: { "a@x.dev": "u" } });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("a failed repository does not stop the others", async () => {
    invoke.mockResolvedValueOnce({ kind: "failed" });
    await fetchRepoAvatars("/a");
    invoke.mockResolvedValueOnce({ kind: "ok", byEmail: {} });
    await fetchRepoAvatars("/b");
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
