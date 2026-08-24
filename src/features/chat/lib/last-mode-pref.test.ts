// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { loadLastModePref, saveLastModePref } from "./last-mode-pref";

beforeEach(() => {
  localStorage.clear();
});

describe("last-mode-pref", () => {
  it("round-trips an explicit pick", () => {
    saveLastModePref("codex", "danger-full-access");
    expect(loadLastModePref("codex")).toBe("danger-full-access");
  });

  it("keeps agents isolated — registry externals key by their plugin id", () => {
    saveLastModePref("codex", "danger-full-access");
    saveLastModePref("claude-code", "bypassPermissions");
    saveLastModePref("some-registry-agent@1.2", "yolo");
    expect(loadLastModePref("codex")).toBe("danger-full-access");
    expect(loadLastModePref("claude-code")).toBe("bypassPermissions");
    expect(loadLastModePref("some-registry-agent@1.2")).toBe("yolo");
  });

  it("clearing one agent never touches another's pick", () => {
    saveLastModePref("codex", "auto");
    saveLastModePref("claude-code", "acceptEdits");
    saveLastModePref("codex", null);
    expect(loadLastModePref("codex")).toBeNull();
    expect(loadLastModePref("claude-code")).toBe("acceptEdits");
  });

  it("missing preference reads as null (defer to the agent's own default)", () => {
    expect(loadLastModePref("codex")).toBeNull();
  });
});
