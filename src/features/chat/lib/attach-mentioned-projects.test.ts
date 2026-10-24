// A send attaches the projects it mentions and tells compose_prompt the
// access each holds; a refused folder is still mentioned, just unattached.

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { attachMentionedProjects } from "./attach-mentioned-projects";
import type { MentionData } from "./mentions";

const PROJECT: MentionData = {
  kind: "workspace",
  id: "ws-2",
  displayName: "server",
  absPath: "/work/server/",
  orgName: null,
};
const FILE: MentionData = { kind: "file", id: "/a.rs", displayName: "a.rs", absPath: "/a.rs" };
const HOME: MentionData = {
  kind: "repo",
  id: "/Users/me",
  displayName: "me",
  absPath: "/Users/me",
  hasReadme: false,
};

beforeEach(() => invoke.mockReset());

describe("attachMentionedProjects", () => {
  it("attaches a project mention and carries its access to the composer", async () => {
    invoke.mockResolvedValueOnce({
      projects: [
        {
          path: "/work/server",
          displayName: "server",
          access: "read_write",
          attachedAt: "2026-10-24T00:00:00Z",
          source: "mention",
        },
      ],
      changed: false,
      appliedLive: true,
    });
    const out = await attachMentionedProjects("sess-1", [FILE, PROJECT]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("session_projects_attach", {
      sessionId: "sess-1",
      path: "/work/server/",
      displayName: "server",
      access: null,
      source: "mention",
    });
    expect(out.mentions[0]).toBe(FILE);
    expect(out.mentions[1]).toEqual({ ...PROJECT, access: "read_write" });
    expect(out.projects).toHaveLength(1);
    expect(out.refused).toEqual([]);
  });

  it("keeps a refused folder's mention, unattached, and reports why", async () => {
    invoke.mockRejectedValueOnce({ message: "~ is your home folder or above it" });
    const out = await attachMentionedProjects("sess-1", [HOME]);
    expect(out.mentions).toEqual([HOME]);
    expect(out.projects).toBeNull();
    expect(out.refused).toEqual([
      { displayName: "me", reason: "~ is your home folder or above it" },
    ]);
  });
});
