import { GitCommitHorizontal, Layers } from "lucide-react";

import { useArtifactsStore } from "@/features/artifacts/stores/artifacts-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import type { ChatSessionReference } from "../types";

/**
 * Open the recorded session a reference points at on the Timeline, the way
 * the git panel opens one from a commit: the board's open Session set first,
 * then the Timeline tab. The Session is addressed by its Workspace (the
 * Timeline's `remoteProjectId`) with no local checkout, so it is read from
 * the server — a teammate's run may never have existed on this machine. A
 * checkpoint reference lands on its commit.
 */
export function openRecordedSession(ref: ChatSessionReference): void {
  useArtifactsStore.getState().actions.openSession({
    sessionId: ref.session_id,
    projectPath: "",
    remoteProjectId: ref.workspace_ref_id,
    commitSha: ref.kind === "checkpoint" ? ref.commit_sha : undefined,
  });
  useLayoutStore.getState().actions.addTab({
    id: "artifacts",
    type: "artifacts",
    title: "Timeline",
    closable: true,
    dirty: false,
    data: {},
  });
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

/** The card's second line: what the snapshot says about the run or commit. */
function detailOf(ref: ChatSessionReference): string {
  if (ref.kind === "checkpoint") {
    return [
      `Checkpoint ${ref.commit_sha.slice(0, 7)}`,
      ref.branch,
      `+${ref.insertions} −${ref.deletions}`,
      plural(ref.files, "file"),
    ]
      .filter(Boolean)
      .join(" · ");
  }
  return [
    "Recorded session",
    ref.agent,
    plural(ref.messages, "message"),
    plural(ref.tool_calls, "tool call"),
    plural(ref.checkpoints, "checkpoint"),
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * A **Session Reference** a message carries: the recorded session (or one
 * checkpoint in it) the sender pointed at, drawn as the attachment file card
 * is drawn, and opening that recorded session on the Timeline when clicked.
 * The figures are the sender's snapshot; the Timeline has the current truth.
 */
export function SessionReferenceCard({ reference }: { reference: ChatSessionReference }) {
  const title = reference.session_title ?? "Untitled session";
  const Icon = reference.kind === "checkpoint" ? GitCommitHorizontal : Layers;
  return (
    <button
      type="button"
      data-session-reference={reference.kind}
      aria-label={`Session Reference: ${title}. Open it on the Timeline`}
      onClick={() => openRecordedSession(reference)}
      className="flex w-full max-w-[420px] cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-2 text-left transition-colors hover:border-border-strong hover:bg-element-hover"
    >
      <Icon size={15} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-secondary-foreground">{title}</span>
        <span className="block truncate text-2xs tabular-nums text-disabled">
          {detailOf(reference)}
        </span>
      </span>
    </button>
  );
}
