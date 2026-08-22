import type { ChatMessage } from "@/types/agent";
import { getEditParts, getFilePathFromInput } from "./tool-files";
import { toRepoRelative } from "./open-turn-diff";

/** The before/after text for one file, as a turn left it. */
export interface TurnEdit {
  old: string;
  new: string;
}

export interface TurnEdits {
  /** Files the turn changed, in the order it first touched them. */
  files: string[];
  /** Which file the viewer should land on. */
  initial: string;
  sources: Record<string, TurnEdit>;
}

/**
 * The before/after text a single turn produced, per file.
 *
 * Walks the turn's assistant run — `turnId` is `t:<first assistant message id>`,
 * the same formula the row projection uses — and folds every edit a tool call
 * reported into one before/after pair per path, so a turn that touched a file
 * three times reads as one diff rather than three competing ones.
 *
 * # Two shapes of edit, folded differently
 *
 * An edit reaches Atlas either as recognisable tool ARGUMENTS or as an ACP
 * `diff` CONTENT BLOCK, and the two carry different things:
 *
 * - **Arguments** carry a fragment. An `Edit` names the text it replaced, so
 *   successive edits CONCATENATE — the pair covers every fragment the turn
 *   touched, which is honest about what the record holds. (A `Write` carries
 *   whole content with an empty `old`, which is why a file the turn created
 *   renders in full.)
 * - **Diff blocks** carry the WHOLE FILE, before and after (`acp::Diff`; Zed
 *   loads `new_text` straight into a buffer and diffs it against `old_text`,
 *   `diff.rs:18-28`). Concatenating those produces nonsense: two edits to one
 *   file would give `old = v0 + v1` against `new = v1 + v2`. They fold by
 *   taking the FIRST block's before and the LAST block's after — the state the
 *   turn found the file in, and the state it left it in.
 *
 * A path reported both ways takes the whole-file answer: it is the complete
 * file, and a fragment pair cannot improve on it.
 *
 * A file the turn only deleted contributes no edit at all and simply does not
 * appear, which is the correct answer — there is nothing to browse.
 */
export function collectTurnEdits(
  messages: ChatMessage[],
  turnId: string,
  repoPath: string,
  preferredFile?: string,
): TurnEdits {
  const firstId = turnId.startsWith("t:") ? turnId.slice(2) : turnId;
  const start = messages.findIndex((m) => m.id === firstId);
  /** Fragment pairs, accumulated from tool arguments. */
  const fragments: Record<string, TurnEdit> = {};
  /** Whole-file pairs, from diff blocks: first `old` wins, last `new` wins. */
  const whole: Record<string, TurnEdit> = {};
  const order: string[] = [];

  const see = (path: string) => {
    if (!order.includes(path)) order.push(path);
  };

  if (start >= 0) {
    // The turn is the consecutive assistant run beginning at that message.
    for (let i = start; i < messages.length && messages[i].role === "assistant"; i++) {
      for (const tc of messages[i].toolCalls) {
        // P1.4: an ACP agent may report its edit as a `diff` content block
        // instead of as recognisable Write/Edit arguments. Those carry the
        // before/after text outright, so they fold in the same way — and this
        // is the ONLY record of an edit that is not on disk yet (plan mode,
        // preview), where a git-backed diff has nothing to compare against.
        for (const block of tc.contentBlocks ?? []) {
          if (block.type !== "diff") continue;
          const path = toRepoRelative(block.path, repoPath);
          see(path);
          const seen = whole[path];
          whole[path] = { old: seen ? seen.old : (block.oldText ?? ""), new: block.newText };
        }
        const args = tc.arguments ?? {};
        const parts = getEditParts(tc.toolName, args);
        if (parts.length === 0) continue;
        const abs = getFilePathFromInput(args);
        if (!abs) continue;
        const path = toRepoRelative(abs, repoPath);
        see(path);
        const acc = (fragments[path] ??= { old: "", new: "" });
        for (const p of parts) {
          acc.old += p.old;
          acc.new += p.neu;
        }
      }
    }
  }

  const sources: Record<string, TurnEdit> = {};
  for (const path of order) sources[path] = whole[path] ?? fragments[path];

  const wanted = preferredFile ? toRepoRelative(preferredFile, repoPath) : "";
  return {
    files: order,
    initial: wanted && sources[wanted] ? wanted : (order[0] ?? ""),
    sources,
  };
}
