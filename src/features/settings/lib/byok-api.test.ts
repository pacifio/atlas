import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Reference pattern for testing an IPC seam module.
 *
 * `invoke` is mocked, so these tests assert the *wire contract*: which command
 * a call targets and the exact payload shape Rust will deserialise. They do
 * not prove the command exists — `tests/ipc-contract.test.ts` does that for
 * every command in the app at once. Together the two cover the seam without
 * either needing a running Tauri process.
 *
 * Since 2026-08-22 this seam edits the user's shell profile instead of a
 * private key store, so the argument names below (`envVar`, `value`) are what
 * `byok_env_set` / `byok_env_unset` destructure — a rename on either side is a
 * silent no-op at runtime, which is exactly what these catch.
 */
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { byok } = await import("./byok-api");

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

describe("byok.envList", () => {
  it("calls byok_env_list with no payload", async () => {
    invoke.mockResolvedValue([]);
    await byok.envList();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("byok_env_list");
  });

  it("returns the rows untouched", async () => {
    const rows = [{ provider: "openai", envVar: "OPENAI_API_KEY", last4: "1234" }];
    invoke.mockResolvedValue(rows);
    await expect(byok.envList()).resolves.toEqual(rows);
  });
});

describe("byok.entries", () => {
  it("calls byok_env_entries with no payload", async () => {
    invoke.mockResolvedValue([]);
    await byok.entries();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("byok_env_entries");
  });

  it("preserves the file/line/editable fields the editor renders", async () => {
    const rows = [
      {
        provider: "google",
        envVar: "GEMINI_API_KEY",
        last4: "9876",
        file: "/Users/a/.zshrc",
        line: 42,
        editable: true,
      },
      {
        provider: "openai",
        envVar: "OPENAI_API_KEY",
        last4: "4321",
        file: null,
        line: null,
        editable: false,
      },
    ];
    invoke.mockResolvedValue(rows);
    await expect(byok.entries()).resolves.toEqual(rows);
  });

  it("propagates a rejection rather than swallowing it", async () => {
    invoke.mockRejectedValue("no home directory");
    await expect(byok.entries()).rejects.toBe("no home directory");
  });
});

describe("byok.profileInfo", () => {
  it("calls byok_profile_info with no payload", async () => {
    invoke.mockResolvedValue({ shell: "/bin/zsh", target: "/Users/a/.zshrc", scanned: [] });
    await byok.profileInfo();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("byok_profile_info");
  });
});

describe("byok.reveal", () => {
  it("sends the variable name under `envVar`", async () => {
    invoke.mockResolvedValue("sk-secret");
    await byok.reveal("ANTHROPIC_API_KEY");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("byok_env_reveal", {
      envVar: "ANTHROPIC_API_KEY",
    });
  });

  it("passes through a null for an unset variable", async () => {
    invoke.mockResolvedValue(null);
    await expect(byok.reveal("NOPE")).resolves.toBeNull();
  });
});

describe("byok.set", () => {
  it("sends the variable and the raw value", async () => {
    invoke.mockResolvedValue("/Users/a/.zshrc");
    await byok.set("ANTHROPIC_API_KEY", "sk-ant-abcd1234");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("byok_env_set", {
      envVar: "ANTHROPIC_API_KEY",
      value: "sk-ant-abcd1234",
    });
  });

  it("does NOT derive metadata — Rust owns what lands in the file", async () => {
    // The old store took `last4`/`addedAt` from here. The profile editor writes
    // one `export` line and nothing else, so sending extras would be a lie.
    invoke.mockResolvedValue("/Users/a/.zshrc");
    await byok.set("OPENAI_API_KEY", "sk-openai-wxyz9876");
    expect(Object.keys(invoke.mock.calls[0][1])).toEqual(["envVar", "value"]);
  });

  it("resolves to the file that was written", async () => {
    invoke.mockResolvedValue("/Users/a/.zshrc");
    await expect(byok.set("GROQ_API_KEY", "gsk-1")).resolves.toBe("/Users/a/.zshrc");
  });

  it("propagates a rejection", async () => {
    invoke.mockRejectedValue("read-only file system");
    await expect(byok.set("GROQ_API_KEY", "gsk-1")).rejects.toBe("read-only file system");
  });
});

describe("byok.unset", () => {
  it("calls byok_env_unset with just the variable", async () => {
    await byok.unset("ANTHROPIC_API_KEY");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("byok_env_unset", {
      envVar: "ANTHROPIC_API_KEY",
    });
  });

  it("propagates the refusal for an env-only key", async () => {
    // Rust refuses rather than guessing at a file it never found the value in;
    // the UI turns this into a message, so it must not be swallowed here.
    invoke.mockRejectedValue("This key is set outside your shell profile");
    await expect(byok.unset("OPENAI_API_KEY")).rejects.toBe(
      "This key is set outside your shell profile",
    );
  });
});
