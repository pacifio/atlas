import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Reference pattern for testing an IPC seam module.
 *
 * `invoke` is mocked, so these tests assert the *wire contract*: which command
 * a call targets and the exact payload shape Rust will deserialise. They do
 * not prove the command exists — `tests/ipc-contract.test.ts` does that for
 * every command in the app at once. Together the two cover the seam without
 * either needing a running Tauri process.
 */
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { byok } = await import("./byok-api");

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

describe("byok.list", () => {
  it("calls byok_list with no payload", async () => {
    invoke.mockResolvedValue([]);
    await byok.list();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("byok_list");
  });

  it("returns the metadata rows untouched", async () => {
    const rows = [{ provider: "openai", last4: "sk-1", addedAt: "2026-01-01T00:00:00.000Z" }];
    invoke.mockResolvedValue(rows);
    await expect(byok.list()).resolves.toEqual(rows);
  });

  it("propagates a rejection rather than swallowing it", async () => {
    // Keychain reads fail when the user denies the OS prompt; the settings
    // panel needs to see that, not an empty list.
    invoke.mockRejectedValue("keychain access denied");
    await expect(byok.list()).rejects.toBe("keychain access denied");
  });
});

describe("byok.set", () => {
  it("sends the provider, the raw key, and derived metadata", async () => {
    await byok.set("anthropic", "sk-ant-abcd1234");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("byok_set", {
      provider: "anthropic",
      key: "sk-ant-abcd1234",
      last4: "1234",
      addedAt: expect.any(String),
    });
  });

  it("stamps addedAt as a parseable ISO-8601 instant", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    try {
      await byok.set("openai", "sk-openai-wxyz9876");
      const { addedAt } = invoke.mock.calls[0][1];
      expect(addedAt).toBe("2026-06-15T12:00:00.000Z");
      expect(Number.isNaN(Date.parse(addedAt))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("last4 derivation", () => {
    async function last4For(key: string): Promise<string> {
      invoke.mockReset();
      invoke.mockResolvedValue(undefined);
      await byok.set("openai", key);
      return invoke.mock.calls[0][1].last4;
    }

    it("takes the final four characters of a normal key", async () => {
      await expect(last4For("sk-proj-0000abcd")).resolves.toBe("abcd");
    });

    it("handles a key of exactly four characters", async () => {
      await expect(last4For("wxyz")).resolves.toBe("wxyz");
    });

    it("returns the whole key when it is shorter than four characters", async () => {
      // `String.slice(-4)` cannot truncate here, so the "non-secret" metadata
      // becomes the entire secret. Harmless for real credentials (no provider
      // issues 3-character keys) but worth pinning: if `last4` ever moves
      // somewhere less trusted than the settings panel, this is the case that
      // makes it a leak.
      await expect(last4For("abc")).resolves.toBe("abc");
    });

    it("returns an empty string for an empty key", async () => {
      // The panel is expected to reject this before calling; nothing here does.
      await expect(last4For("")).resolves.toBe("");
    });

    it("counts UTF-16 code units, not glyphs", async () => {
      // Keys are ASCII in practice; this pins what happens if one is not,
      // since slicing mid-surrogate would otherwise silently corrupt display.
      await expect(last4For("key-🔑")).resolves.toHaveLength(4);
    });
  });
});

describe("byok.delete", () => {
  it("calls byok_delete with just the provider", async () => {
    await byok.delete("anthropic");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("byok_delete", { provider: "anthropic" });
  });

  it("propagates a rejection", async () => {
    invoke.mockRejectedValue("no such entry");
    await expect(byok.delete("ghost")).rejects.toBe("no such entry");
  });
});
