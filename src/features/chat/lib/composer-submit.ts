// The composer's submit pipeline as plain data: what an Enter (or the send
// button) does with the text and the composer's gates, and what the tri-state
// button shows; plus two text helpers the composer's hooks share. No React,
// store or DOM here — `use-composer-submit.ts` carries out the plan.

export type ComposerButtonMode = "send" | "queue" | "stop";

export type SubmitPlan =
  /** A gate holds the send; the text stays in the composer. */
  | { kind: "blocked" }
  /** Nothing typed and nothing running. */
  | { kind: "noop" }
  /** Nothing typed while a turn runs: the button is a stop button. */
  | { kind: "stop" }
  /** `/fork`, typed in full. */
  | { kind: "fork" }
  /** `/queue <message>`; `message` is null for a bare `/queue`. */
  | { kind: "queue-command"; message: string | null }
  /** A turn is running: the text waits in the queue. */
  | { kind: "enqueue"; text: string }
  | { kind: "send"; text: string };

export interface SubmitInput {
  text: string;
  disabled: boolean;
  githubSyncing: boolean;
  running: boolean;
  remoteDriving: boolean;
  modeUnrestored: boolean;
  heldForTerminal: boolean;
  supportsFork: boolean;
}

export function planSubmit({
  text,
  disabled,
  githubSyncing,
  running,
  remoteDriving,
  modeUnrestored,
  heldForTerminal,
  supportsFork,
}: SubmitInput): SubmitPlan {
  // Hard gate: Claude Code missing or not authed — sending would just
  // surface a confusing ACP spawn error. The banner above tells the user
  // what to do instead.
  if (disabled) return { kind: "blocked" };
  // A GitHub repo is still syncing into `.atlas/repos` — block the send so the
  // prompt can't reference a half-cloned repo.
  if (githubSyncing) return { kind: "blocked" };
  const trimmed = text.trim();
  if (!trimmed) {
    // Empty + running → act as a stop button.
    return running ? { kind: "stop" } : { kind: "noop" };
  }
  // Someone else holds the seat: nothing typed here sends or queues, not
  // even `/queue` (which used to slip past this check and park the prompt
  // locally, to be drained under the remote driver's seat later). The
  // strip above says who is driving and offers Take over.
  if (remoteDriving) return { kind: "blocked" };
  // Atlas-surface commands, typed in full (the picker's Enter lands here
  // too). They drive app affordances, so they never reach the agent.
  if (trimmed === "/fork" && supportsFork) return { kind: "fork" };
  if (trimmed === "/queue" || trimmed.startsWith("/queue ")) {
    const queued = trimmed.slice("/queue".length).trim();
    return { kind: "queue-command", message: queued || null };
  }
  if (running) {
    // Queued messages don't carry mentions yet — the queue holds raw
    // strings and the agent will see whatever shortform text was in the
    // composer. Mentions are dropped here intentionally; promoting the
    // queue to a structured shape is a follow-up. Staged images likewise
    // stay in the composer strip and ride the next direct send. A paste or
    // a cite is the exception: its token alone would lose what the user
    // pasted or cited, so the queue puts its text into the queued string.
    return { kind: "enqueue", text: trimmed };
  }
  if (modeUnrestored || heldForTerminal) return { kind: "blocked" };
  return { kind: "send", text: trimmed };
}

// Tri-state button:
//   running + empty   → STOP
//   running + text    → QUEUE  (STOP while someone else drives: queueing is
//                               theirs, Stop is the owner's, and a draft
//                               must not hide the one control that works)
//   not running + any → SEND
export function submitButtonState({
  running,
  hasText,
  disabled,
  modeUnrestored,
  heldForTerminal,
  remoteDriving,
}: {
  running: boolean;
  hasText: boolean;
  disabled: boolean;
  modeUnrestored: boolean;
  heldForTerminal: boolean;
  remoteDriving: boolean;
}): { mode: ComposerButtonMode; enabled: boolean } {
  const mode: ComposerButtonMode = running
    ? hasText && !remoteDriving
      ? "queue"
      : "stop"
    : "send";
  const enabled =
    disabled ||
    (mode === "send" && (modeUnrestored || heldForTerminal)) ||
    (mode !== "stop" && remoteDriving)
      ? false
      : mode === "stop"
        ? true
        : hasText;
  return { mode, enabled };
}

/** A recalled queued message joins whatever is already in the composer. */
export function mergeQueued(current: string, recalled: string): string {
  return current.trim() ? `${current}\n${recalled}` : recalled;
}

/** A file chip's label: relative to the project when the file lives inside
 *  it; otherwise just the basename (dropped files can be anywhere). */
export function fileChipDisplayName(absPath: string, projectPath: string | null): string {
  const root = projectPath && !projectPath.endsWith("/") ? `${projectPath}/` : projectPath;
  return root && absPath.startsWith(root)
    ? absPath.slice(root.length)
    : absPath.split("/").pop() || absPath;
}
