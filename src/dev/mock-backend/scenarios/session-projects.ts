// A session with two projects attached — `docs` read and write, the
// migration experiments read only — whose turn changed files in its own
// project, in `docs`, and in a scratch folder outside every project.
//
// What it shows:
// - the Details card's Projects section (main first, then each attached
//   project with its branch, uncommitted counts, access badge and ⋯ menu);
// - the changed-files card grouped by root, with an "Other" group;
// - the diff panel's turn scope grouped the same way, and its Uncommitted
//   scope with each attached repository's working tree as its own group;
// - the sidebar row's "+2" and the hover card's attached list, and, with the
//   project filter on `docs`, this session listed as "attached";
// - the composer's `@` picker leading with the attached projects.

import type { AttachedProject, ThreadProject, ThreadRow } from "@/features/chat/lib/history-api";
import { RESTING_LIFECYCLE } from "@/features/chat/lib/session-lifecycle";
import type { DiffFileStatus } from "@/features/git/lib/git-review-api";
import type { GitSummary } from "@/features/projects/stores/project-git-store";
import type { ToolCall } from "@/types/agents";
import type { Scenario } from "../types";
import { ended, text, tool, tools, user, t } from "../fixtures/chat";
import { diffPreviewOf, unifiedDiff, type PreviewChange } from "../fixtures/diff";
import { gitHandlers } from "../fixtures/git";
import { miscHandlers } from "../fixtures/misc";
import { playTurns, setSessionSeeder } from "../fake-agent";
import { abs, MOCK_PROJECT, OTHER_PROJECTS } from "../project";

const DOCS = OTHER_PROJECTS[1];
const MIGRATION = OTHER_PROJECTS[0];
const SCRATCH_NOTE = "/Users/dev/scratch/refresh-notes.md";
const TITLE = "Refresh sessions early and document it";

/** The opened session's id, once the fake agent has minted it. */
let live: string | null = null;

let n = 0;
const nextId = () => `spr-${++n}`;

function replace(file: string, oldString: string, newString: string): ToolCall {
  return {
    id: nextId(),
    tool_name: "Edit",
    title: `Edit ${file}`,
    kind: "edit",
    status: "completed",
    result: null,
    locations: [],
    arguments: { file_path: file, old_string: oldString, new_string: newString },
  };
}

function write(file: string, content: string): ToolCall {
  return {
    id: nextId(),
    tool_name: "Write",
    title: `Write ${file}`,
    kind: "edit",
    status: "completed",
    result: null,
    locations: [],
    arguments: { file_path: file, content },
  };
}

const turns = () => [
  [
    user(
      "Make sessions refresh a minute before they expire, document it in the docs site, and keep a note of the edge cases.",
      t(0),
    ),
    tools(
      [
        tool.read("src/features/auth/session.ts"),
        replace(
          abs("src/features/auth/session.ts"),
          "export function isExpired(session: Session, now = Date.now()): boolean {\n  return session.expiresAt < now;\n}\n",
          "export function isExpired(session: Session, now = Date.now()): boolean {\n  return session.expiresAt < now;\n}\n\n/** Refresh a minute early, so a request never races the expiry. */\nexport function needsRefresh(session: Session, now = Date.now()): boolean {\n  return session.expiresAt - 60_000 < now;\n}\n",
        ),
        write(
          abs("src/features/auth/session.test.ts"),
          `import { describe, expect, it } from "vitest";\nimport { needsRefresh } from "./session";\n\ndescribe("needsRefresh", () => {\n  it("is true inside the last minute", () => {\n    expect(needsRefresh({ userId: "u", expiresAt: 30_000 }, 0)).toBe(true);\n  });\n});\n`,
        ),
        replace(
          `${DOCS.path}/guide/sessions.mdx`,
          "Sessions last an hour.\n",
          "Sessions last an hour. The app refreshes a session a minute before it\nexpires, so a request in flight never meets an expired token.\n",
        ),
        write(
          SCRATCH_NOTE,
          "# Refresh edge cases\n\n- A laptop asleep past the expiry wakes to a 401; the retry refreshes.\n- Two tabs refresh at once: the second gets the first's token.\n",
        ),
      ],
      t(4),
    ),
    ended(
      text(
        "Sessions now refresh a minute before they expire (`needsRefresh`, with a test). The docs site says so in the sessions guide, and the edge cases are in a scratch note.",
        t(30),
      ),
      26,
    ),
  ],
];

// ── The attached repositories' working trees ───────────────────────────────

const docsGuideBefore = "# Sessions\n\nSessions last an hour.\n\nSign in again when one ends.\n";
const docsGuideAfter =
  "# Sessions\n\nSessions last an hour. The app refreshes a session a minute before it\nexpires, so a request in flight never meets an expired token.\n\nSign in again when one ends.\n";
const docsReadmeBefore = "# docs\n\nThe Acme docs site.\n";
const docsReadmeAfter = "# docs\n\nThe Acme docs site. Run `bun dev` to preview it.\n";
const planBefore = "# Migration plan\n\n1. Move reads.\n2. Move writes.\n";
const planAfter = "# Migration plan\n\n1. Move reads.\n2. Move writes.\n3. Drop the v1 tables.\n";

function change(
  path: string,
  before: string,
  after: string,
  status: DiffFileStatus = "modified",
): PreviewChange {
  return { path, before, after, status };
}

const WORKING: Record<string, PreviewChange[]> = {
  [DOCS.path]: [
    change("guide/sessions.mdx", docsGuideBefore, docsGuideAfter),
    change("README.md", docsReadmeBefore, docsReadmeAfter),
  ],
  [MIGRATION.path]: [change("notes/plan.md", planBefore, planAfter)],
};

const SUMMARY: Record<string, GitSummary> = {
  [DOCS.path]: {
    isRepo: true,
    branch: "docs/session-refresh",
    headSubject: "docs: sessions guide",
    dirty: true,
    additions: 3,
    deletions: 2,
  },
  [MIGRATION.path]: {
    isRepo: true,
    branch: "main",
    headSubject: "plan: first draft",
    dirty: true,
    additions: 1,
    deletions: 0,
  },
};

const changeIn = (path: string, file: string) =>
  WORKING[path]?.find((c) => c.path === file) ?? null;

// ── History: the opened session, with its attached projects ────────────────

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

function liveRow(): ThreadRow | null {
  if (!live) return null;
  return {
    threadId: `th-${live}`,
    sessionId: live,
    agentId: "claude-code",
    title: TITLE,
    updatedAt: hoursAgo(0),
    createdAt: hoursAgo(1),
    ...RESTING_LIFECYCLE,
    projectName: MOCK_PROJECT.name,
    folderPaths: [MOCK_PROJECT.path],
    liveElsewhere: false,
    heldWorking: false,
    pullRequests: [],
    forkedFromSessionId: null,
    attachedProjects: miscHandlers.session_projects_list({ sessionId: live }) as AttachedProject[],
    model: "Claude Sonnet 4.5",
    branch: "feature/auth-v2",
  };
}

function attachBoth(sessionId: string): void {
  miscHandlers.session_projects_attach({
    sessionId,
    path: DOCS.path,
    displayName: DOCS.name,
    access: "read_write",
    source: "mention",
  });
  miscHandlers.session_projects_attach({
    sessionId,
    path: MIGRATION.path,
    displayName: MIGRATION.name,
    access: "read_only",
    source: "agent_request",
  });
}

/** The chat tab binds its session shortly after mount; the turn plays then. */
const BIND_WAIT_MS = 1500;

export const sessionProjects: Scenario = {
  name: "session-projects",
  description: "Two attached projects (read, read & write), changes across three roots and Other.",
  init: () => {
    live = null;
    setSessionSeeder((info) => {
      if (!live) {
        live = info.sessionId;
        attachBoth(live);
      }
      return null;
    });
  },
  setup: async () => {
    await new Promise((r) => setTimeout(r, BIND_WAIT_MS));
    await playTurns(turns());
  },
  commands: {
    git_diff_preview: (args) => {
      const changes = WORKING[String(args.path)];
      if (!changes) return gitHandlers.git_diff_preview(args);
      return diffPreviewOf(changes, { baseRef: "origin/main", mergeBase: "0000000" });
    },
    git_diff_file_patch: (args) => {
      const c = changeIn(String(args.path), String(args.filePath));
      if (!WORKING[String(args.path)]) return gitHandlers.git_diff_file_patch(args);
      return {
        patch: c ? unifiedDiff(c.before ?? "", c.after ?? "", c.path) : "",
        truncated: false,
        binary: false,
      };
    },
    git_diff_file_contents: (args) => {
      if (!WORKING[String(args.path)]) return gitHandlers.git_diff_file_contents(args);
      const c = changeIn(String(args.path), String(args.filePath));
      return {
        oldText: c?.before ?? "",
        newText: c?.after ?? "",
        truncated: false,
        binary: false,
      };
    },
    git_workspace_summary: (args) =>
      SUMMARY[String(args.path)] ?? gitHandlers.git_workspace_summary(args),
  },
  rawCommands: {
    threads_history: () => {
      const base = miscHandlers.threads_history({}) as ThreadRow[];
      const row = liveRow();
      return row ? [...base, row] : base;
    },
    threads_projects: (args) => {
      const base = miscHandlers.threads_projects(args) as ThreadProject[];
      const row = liveRow();
      if (!row) return base;
      return base.map((group) =>
        group.name === MOCK_PROJECT.name ? { ...group, threads: [row, ...group.threads] } : group,
      );
    },
  },
};
