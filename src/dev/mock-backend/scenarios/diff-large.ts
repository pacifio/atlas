// A review diff big enough to measure: 60 changed TypeScript files and about
// 3,600 changed lines, so the patch passes the 120 KB cap and most files load
// one at a time. Opens the diff beside the session on load.
//
// `__atlasMock.actions.edit()` rewrites one line of a file, as an agent's
// write would, and fires the watcher event, so a live refresh can be watched
// (and timed) without a backend.

import { emit } from "@tauri-apps/api/event";
import type { Scenario } from "../types";
import type { Entitlement } from "@/features/chat/stores/ai-grant-store";
import { diffPreviewOf, unifiedDiff, type PreviewChange } from "../fixtures/diff";
import { MOCK_PROJECT } from "../project";

const FILES = 60;
const LINES = 120;

/** A deterministic module, with every third line rewritten in the "after",
 *  except for a run in the middle left alone: the unchanged lines between two
 *  hunks, which the viewer folds behind "N unmodified lines". */
function moduleText(index: number, edited: boolean): string {
  const lines: string[] = [`// module ${index}`, `import { assert } from "./assert";`, ""];
  for (let i = 0; i < LINES; i++) {
    const touched = edited && i % 3 === 0 && (i < 30 || i >= 60);
    const name = `value${index}_${i}`;
    lines.push(
      touched
        ? `export const ${name} = compute(${i}, "edited-${index}") ?? fallback(${i * 2}); // updated`
        : `export const ${name} = compute(${i}, "seed-${index}");`,
    );
    if (i % 10 === 9)
      lines.push(`export function check${i}(x: number): boolean {`, `  return x > ${i};`, "}");
  }
  return `${lines.join("\n")}\n`;
}

const CHANGES: PreviewChange[] = Array.from({ length: FILES }, (_, i) => ({
  path: `src/modules/group-${Math.floor(i / 10)}/module-${String(i).padStart(2, "0")}.ts`,
  before: moduleText(i, false),
  after: moduleText(i, true),
  status: "modified",
}));

const byPath = new Map(CHANGES.map((c) => [c.path, c]));
const previewOf = () =>
  diffPreviewOf(CHANGES, { baseRef: "origin/main", mergeBase: "0".repeat(40) });
let preview = previewOf();
let edits = 0;

export const diffLarge: Scenario = {
  name: "diff-large",
  description: "The review diff on 60 files and ~3,600 changed lines, past the patch cap.",
  commands: {
    git_diff_preview: () => preview,
    git_diff_file_contents: ({ filePath }) => {
      const change = byPath.get(String(filePath));
      return {
        oldText: change?.before ?? "",
        newText: change?.after ?? "",
        truncated: false,
        binary: false,
      };
    },
    git_diff_file_patch: ({ filePath }) => {
      const change = byPath.get(String(filePath));
      const patch = change ? unifiedDiff(change.before ?? "", change.after ?? "", change.path) : "";
      return { patch, truncated: false, binary: false };
    },
  },
  actions: {
    /** An agent's write to the first file: one more changed line. */
    edit: async () => {
      edits += 1;
      const first = CHANGES[0];
      first.after = `${first.after}export const appended${edits} = ${edits};\n`;
      preview = previewOf();
      await emit("atlas:explorer:changed", {
        dirs: [`${MOCK_PROJECT.path}/src/modules/group-0`],
        fullRefresh: false,
      });
      return `edit ${edits} to ${first.path}`;
    },
  },
  setup: async () => {
    const { openGitDiff } = await import("@/features/git/lib/git-diff-api");
    openGitDiff(MOCK_PROJECT.path, "", false);
  },
};

/** How long the default session takes to bind, so it has an agent session id. */
const BIND_WAIT_MS = 1500;

/**
 * The same diff as the session's changes, beside the session: line comments
 * go to its composer (`use-diff-review-comments.tsx`).
 * `__atlasMock.actions.openFile()` opens a project file in its tab, for the
 * file view's line comments.
 */
export const diffComments: Scenario = {
  name: "diff-comments",
  description: "The large review diff beside the session, where diff lines can be commented on.",
  commands: diffLarge.commands,
  rawCommands: {
    // An org with the AI grant: the local-only answer locks the native
    // agent's composer, and a comment needs a composer to go in.
    native_agent_entitlement: (): Entitlement => ({ state: "entitled", models: [] }),
  },
  actions: {
    openFile: async () => {
      const { openFile } = await import("@/lib/open-file");
      await openFile(`${MOCK_PROJECT.path}/src/lib/api.ts`);
      return "opened src/lib/api.ts";
    },
  },
  setup: async () => {
    await new Promise((r) => setTimeout(r, BIND_WAIT_MS));
    const { useChatStore } = await import("@/features/chat/stores/chat-store");
    const { openSessionChanges } = await import("@/features/git/lib/open-session-changes");
    const chat = useChatStore.getState();
    const tabId = chat.activeSessionId;
    const sessionId = tabId ? chat.sessions[tabId]?.acpSessionId : null;
    if (!sessionId) return;
    openSessionChanges({ projectPath: MOCK_PROJECT.path, sessionId, file: "" });
  },
};
