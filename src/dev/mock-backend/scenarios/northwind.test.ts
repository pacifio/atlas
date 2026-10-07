// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { invoke } from "@tauri-apps/api/core";

import type { BoardPage, SessionDetail } from "@/features/artifacts/types";
import type { CommentThreads } from "@/features/artifacts/lib/comments-api";
import type { CommitSession } from "@/features/git/components/git-manager/history-view";
import type { CommsSnapshot } from "@/features/comms/lib/comms-api";
import { northwindFilesAt } from "../fixtures/northwind-repo";
import { CONTENT } from "./northwind-content";
import { PROJECT, REMOTE_PROJECT_ID } from "./northwind-world";

/**
 * The `northwind` scenario is what the Atlas Learn videos are recorded
 * against, so two things must hold that nothing else checks: its content is
 * internally consistent (a comment on a step that exists, a card for a Session
 * that exists, a commit that names real Sessions), and the screens the videos
 * open are all answered — an unmocked command there is an empty panel on
 * camera.
 */

describe("northwind content", () => {
  const sessionIds = new Set(CONTENT.sessions.map((s) => s.id));
  const commitKeys = new Set(CONTENT.commits.map((c) => c.key));
  const stepsOf = (id: string) => {
    const s = CONTENT.sessions.find((x) => x.id === id);
    return new Set([...(s?.steps ?? []), ...(s?.live?.liveSteps ?? [])].map((step) => step.id));
  };

  it("has unique ids", () => {
    expect(sessionIds.size).toBe(CONTENT.sessions.length);
    expect(commitKeys.size).toBe(CONTENT.commits.length);
    for (const s of CONTENT.sessions) {
      const ids = [...s.steps, ...(s.live?.liveSteps ?? [])].map((step) => step.id);
      expect(new Set(ids).size, s.id).toBe(ids.length);
    }
  });

  it("links checkpoints and commits both ways", () => {
    for (const s of CONTENT.sessions) {
      for (const step of s.steps) {
        if (step.kind !== "checkpoint") continue;
        const commit = CONTENT.commits.find((c) => c.key === step.commit);
        expect(commit, `${s.id} → ${step.commit}`).toBeDefined();
        expect(commit?.sessions, `${step.commit} names ${s.id}`).toContain(s.id);
      }
    }
    for (const c of CONTENT.commits) {
      expect(c.sha, c.key).toMatch(/^[0-9a-f]{40}$/);
      for (const id of c.sessions) expect(sessionIds.has(id), `${c.key} → ${id}`).toBe(true);
    }
    // Video 10's whole point.
    expect(
      CONTENT.commits.find((c) => c.subject === "Validate discount codes on the server")?.sessions,
    ).toHaveLength(2);
  });

  // A tool call's diff on camera has to be the code the commit and blame show.
  it("writes every committed edit exactly as the repo has it", () => {
    const order = CONTENT.commits.map((c) => c.key);
    for (const s of CONTENT.sessions) {
      const checkpoint = s.steps.find((step) => step.kind === "checkpoint");
      if (checkpoint?.kind !== "checkpoint") continue;
      const upTo = new Set(order.slice(0, order.indexOf(checkpoint.commit) + 1));
      const files = northwindFilesAt((key) => upTo.has(key));
      for (const step of s.steps) {
        if (step.kind !== "tool" || !step.diff || !step.path) continue;
        expect(files[step.path]?.text, `${s.id} ${step.id}`).toContain(step.diff.after);
      }
    }
  });

  it("anchors comments, cards and cues on things that exist", () => {
    for (const c of CONTENT.comments) {
      expect(sessionIds.has(c.session), c.id).toBe(true);
      if (c.anchor.step) expect(stepsOf(c.session).has(c.anchor.step), c.id).toBe(true);
    }
    for (const m of CONTENT.chat) {
      if (!m.sessionRef) continue;
      expect(sessionIds.has(m.sessionRef.session), m.id).toBe(true);
      if (m.sessionRef.checkpoint) expect(commitKeys.has(m.sessionRef.checkpoint), m.id).toBe(true);
    }
    const { zuhayerComment, zuhayerMessage, zuhayerShare } = CONTENT.cues;
    expect(stepsOf(zuhayerComment.session).has(zuhayerComment.step)).toBe(true);
    for (const ref of [zuhayerMessage.sessionRef, zuhayerShare.sessionRef]) {
      if (ref) expect(sessionIds.has(ref.session)).toBe(true);
    }
    for (const run of CONTENT.runs) {
      if (run.replay) expect(sessionIds.has(run.replay), run.id).toBe(true);
    }
  });
});

describe("northwind scenario", () => {
  it("answers every command its key screens send", async () => {
    window.history.replaceState(null, "", "/?scenario=northwind&record=1");
    const { installMockBackend } = await import("../install");
    await installMockBackend("northwind");

    const board = await invoke<BoardPage>("artifacts_board", { projects: [PROJECT.path] });
    expect(board.sessions.length).toBeGreaterThanOrEqual(12);
    expect(board.sessions.some((s) => s.authorId === "usr_zuhayer")).toBe(true);

    for (const row of board.sessions) {
      const detail = await invoke<SessionDetail>("artifacts_cloud_session", {
        projectId: REMOTE_PROJECT_ID,
        sessionId: row.id,
      });
      expect(detail.entries.length, row.id).toBeGreaterThan(0);
    }

    const threads = await invoke<CommentThreads>("artifacts_cloud_comments", {
      projectId: REMOTE_PROJECT_ID,
      sessionId: "s-errors",
    });
    expect(Object.values(threads.byAnchor).flat().length).toBe(2);

    const validate = CONTENT.commits.find((c) => c.key === "c-validate")!;
    const produced = await invoke<CommitSession[]>("capture_commit_sessions", {
      repoPath: PROJECT.path,
      projectPath: PROJECT.path,
      path: PROJECT.path,
      commitSha: validate.sha,
    });
    expect(produced.map((s) => s.sessionId)).toEqual(["s-server-discounts", "s-discount-tests"]);

    const comms = await invoke<CommsSnapshot>("comms_snapshot");
    expect(comms.conversations.map((c) => c.name)).toEqual(
      expect.arrayContaining(["shop", "general"]),
    );

    expect(window.__atlasMock?.unmocked()).toEqual([]);
    // Recording mode draws none of the mock's own chrome.
    expect(document.querySelector("[data-mock-badge]")).toBeNull();
  });
});
