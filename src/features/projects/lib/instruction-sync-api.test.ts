import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Wire contract for the mirrored-instructions seam (pattern:
 * `settings/lib/byok-api.test.ts`). `projectPath` and `workspaceId` are what
 * `instruction_sync_start` / `instruction_sync_stop` destructure; a rename on
 * either side is a silent no-op at runtime.
 */
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { instructionSync } = await import("./instruction-sync-api");

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

describe("instructionSync.start", () => {
  it("names the project and its id", async () => {
    await instructionSync.start("/repo", "p1");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("instruction_sync_start", {
      projectPath: "/repo",
      workspaceId: "p1",
    });
  });

  it("passes a missing id through as null", async () => {
    await instructionSync.start("/repo", null);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("instruction_sync_start", {
      projectPath: "/repo",
      workspaceId: null,
    });
  });
});

describe("instructionSync.stop", () => {
  it("names the project id", async () => {
    await instructionSync.stop("p1");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("instruction_sync_stop", {
      workspaceId: "p1",
    });
  });
});
