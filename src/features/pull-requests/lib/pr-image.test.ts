// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  IMAGE_CACHE_CAPACITY,
  isProxiedImageUrl,
  loadPrImage,
  releasePrImage,
  resetPrImagesForTests,
  retainPrImage,
} from "./pr-image";

let created = 0;
const revoked: string[] = [];

beforeEach(() => {
  created = 0;
  revoked.length = 0;
  URL.createObjectURL = vi.fn(() => `blob:fake/${++created}`);
  URL.revokeObjectURL = vi.fn((url: string) => void revoked.push(url));
  invoke.mockResolvedValue({ contentType: "image/png", data: "iVBORw0KGgo=" });
});

afterEach(() => {
  resetPrImagesForTests();
  invoke.mockReset();
});

describe("pr-image", () => {
  it("mirrors the native allowlist", () => {
    expect(isProxiedImageUrl("https://github.com/user-attachments/assets/abc")).toBe(true);
    expect(isProxiedImageUrl("https://camo.githubusercontent.com/x/y")).toBe(true);
    expect(isProxiedImageUrl("https://github.com/cli/cli")).toBe(false);
    expect(isProxiedImageUrl("http://camo.githubusercontent.com/x")).toBe(false);
    expect(isProxiedImageUrl("https://camo.githubusercontent.com:444/x")).toBe(false);
    expect(isProxiedImageUrl("https://example.com/a.png")).toBe(false);
    expect(isProxiedImageUrl("not a url")).toBe(false);
  });

  it("fetches an image once and shares its URL", async () => {
    const address = "https://camo.githubusercontent.com/one";
    const [a, b] = await Promise.all([
      loadPrImage("/repo", address),
      loadPrImage("/repo", address),
    ]);
    expect(a).toBe("blob:fake/1");
    expect(b).toBe(a);
    expect(await loadPrImage("/repo", address)).toBe(a);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("pr_image", { path: "/repo", url: address });
  });

  it("never asks for an address the proxy would refuse", async () => {
    await expect(loadPrImage("/repo", "https://example.com/a.png")).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("revokes the oldest URL past its bound", async () => {
    for (let i = 0; i <= IMAGE_CACHE_CAPACITY; i++) {
      await loadPrImage("/repo", `https://camo.githubusercontent.com/${i}`);
    }
    expect(revoked).toEqual(["blob:fake/1"]);
  });

  it("never revokes a URL an image still shows", async () => {
    const first = "https://camo.githubusercontent.com/0";
    await loadPrImage("/repo", first);
    retainPrImage(first);
    for (let i = 1; i <= IMAGE_CACHE_CAPACITY; i++) {
      await loadPrImage("/repo", `https://camo.githubusercontent.com/${i}`);
    }
    // The oldest is on screen, so the next-oldest goes instead.
    expect(revoked).toEqual(["blob:fake/2"]);

    await loadPrImage("/repo", "https://camo.githubusercontent.com/extra");
    expect(revoked).toEqual(["blob:fake/2", "blob:fake/3"]);

    // Once nothing shows it, it is the oldest, and goes as the cache trims.
    releasePrImage(first);
    expect(revoked).toEqual(["blob:fake/2", "blob:fake/3"]);
    await loadPrImage("/repo", "https://camo.githubusercontent.com/extra-2");
    expect(revoked).toContain("blob:fake/1");
  });

  it("does not cache a failed fetch", async () => {
    invoke.mockRejectedValueOnce({ kind: "network" });
    const address = "https://camo.githubusercontent.com/flaky";
    await expect(loadPrImage("/repo", address)).rejects.toEqual({ kind: "network" });
    await expect(loadPrImage("/repo", address)).resolves.toMatch(/^blob:/);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
