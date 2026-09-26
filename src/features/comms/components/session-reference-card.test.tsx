// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));

import { MessageGroup } from "./message-group";
import { useArtifactsStore } from "@/features/artifacts/stores/artifacts-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import type { ChatSessionReference, CommsMessage, OrgMemberProfile } from "../types";

const ada: OrgMemberProfile = {
  id: "u_ada",
  name: "Ada Lovelace",
  email: "ada@x.test",
  role: "member",
};
const members = new Map([[ada.id, ada]]);

const sessionRef: ChatSessionReference = {
  kind: "session",
  workspace_ref_id: "ws_atlas",
  session_id: "rs_1",
  session_title: "Fix the theme importer",
  agent: "atlas-agent",
  started_at: 1_790_000_000_000,
  messages: 12,
  tool_calls: 1,
  checkpoints: 2,
};

const checkpointRef: ChatSessionReference = {
  kind: "checkpoint",
  workspace_ref_id: "ws_atlas",
  session_id: "rs_1",
  session_title: null,
  row_id: "row_9",
  commit_sha: "abc1234def5678",
  branch: "main",
  insertions: 4,
  deletions: 1,
  files: 2,
};

function message(id: string, body: string, refs: ChatSessionReference[] | undefined): CommsMessage {
  return {
    id,
    conv_id: "c1",
    seq: 1,
    author_id: ada.id,
    body,
    reply_to_id: null,
    edited_at: null,
    created_at: 1,
    attachments: [],
    code_refs: [],
    artifact_refs: refs,
    draft_id: null,
    status: "sent",
  };
}

function show(messages: CommsMessage[]) {
  const noop = () => {};
  return render(
    <MessageGroup
      messages={messages}
      own={false}
      author={ada}
      members={members}
      me="u_grace"
      lookup={() => undefined}
      onReply={noop}
      onEdit={noop}
      onDelete={noop}
      onReact={noop}
      onPin={noop}
      onJump={noop}
      showAuthor
    />,
  );
}

beforeEach(() => {
  useArtifactsStore.getState().actions.openSession(null);
});

afterEach(() => {
  cleanup();
});

describe("Session Reference card", () => {
  it("draws a card for each reference a message carries, with the sender's snapshot", () => {
    // As the web sends it: a body, a session and one of its checkpoints.
    const { container } = show([message("m1", "look at this run", [sessionRef, checkpointRef])]);
    const cards = container.querySelectorAll("[data-session-reference]");
    expect([...cards].map((c) => c.getAttribute("data-session-reference"))).toEqual([
      "session",
      "checkpoint",
    ]);
    expect(screen.getByText("Fix the theme importer")).toBeTruthy();
    expect(
      screen.getByText(
        "Recorded session · atlas-agent · 12 messages · 1 tool call · 2 checkpoints",
      ),
    ).toBeTruthy();
    // An untitled run says so rather than showing an id.
    expect(screen.getByText("Untitled session")).toBeTruthy();
    expect(screen.getByText("Checkpoint abc1234 · main · +4 −1 · 2 files")).toBeTruthy();
  });

  it("draws a recorded session with the Timeline's icon, as the mention picker and chip do", () => {
    const { container } = show([message("m1", "look", [sessionRef, checkpointRef])]);
    expect(
      container.querySelector('[data-session-reference="session"] svg.lucide-layers'),
    ).toBeTruthy();
    expect(
      container.querySelector(
        '[data-session-reference="checkpoint"] svg.lucide-git-commit-horizontal',
      ),
    ).toBeTruthy();
  });

  it("draws the card on the agent's report, and none on a message without references", () => {
    // As `org_send` sends it: the prose summary and one Session Reference.
    const { container } = show([
      message("m1", "Session report: the importer is fixed.", [sessionRef]),
      message("m2", "an ordinary message", undefined),
      message("m3", "another", []),
    ]);
    expect(container.querySelectorAll("[data-session-reference]")).toHaveLength(1);
    expect(
      screen.getByRole("button", {
        name: "Session Reference: Fix the theme importer. Open it on the Timeline",
      }),
    ).toBeTruthy();
  });

  it("opens the recorded session on the Timeline when clicked", () => {
    show([message("m1", "report", [sessionRef])]);
    fireEvent.click(
      screen.getByRole("button", { name: /Session Reference: Fix the theme importer/ }),
    );
    expect(useArtifactsStore.getState().open).toEqual({
      sessionId: "rs_1",
      projectPath: "",
      remoteProjectId: "ws_atlas",
      commitSha: undefined,
    });
    const layout = useLayoutStore.getState();
    expect(layout.tabs.some((t) => t.type === "artifacts")).toBe(true);
  });

  it("lands a checkpoint reference on its commit", () => {
    show([message("m1", "", [checkpointRef])]);
    fireEvent.click(screen.getByRole("button", { name: /Session Reference: Untitled session/ }));
    expect(useArtifactsStore.getState().open).toMatchObject({
      sessionId: "rs_1",
      remoteProjectId: "ws_atlas",
      commitSha: "abc1234def5678",
    });
  });
});
