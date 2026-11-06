// A merge stopped on conflicts: three conflicted files and two ordinary
// changes. Resolving a file in the panel removes it from the list, so the
// resolve flow can be clicked through without touching a real repo.

import type { Scenario } from "../types";

interface FakeFile {
  path: string;
  status: string;
  staged: boolean;
  conflicted: boolean;
  markers: number;
}

const initial = (): FakeFile[] => [
  { path: "src/lib/api.ts", status: "modified", staged: false, conflicted: true, markers: 3 },
  {
    path: "src/components/header.tsx",
    status: "modified",
    staged: false,
    conflicted: true,
    markers: 1,
  },
  { path: "package.json", status: "modified", staged: false, conflicted: true, markers: 2 },
  { path: "src/lib/utils.ts", status: "modified", staged: true, conflicted: false, markers: 0 },
  {
    path: "src/components/badge.tsx",
    status: "added",
    staged: true,
    conflicted: false,
    markers: 0,
  },
];

let files = initial();

const API_DIFF = `diff --git a/src/lib/api.ts b/src/lib/api.ts
--- a/src/lib/api.ts
+++ b/src/lib/api.ts
@@ -1,9 +1,17 @@
 export async function getUser(id: string) {
+<<<<<<< HEAD
   const res = await fetch(\`/api/users/\${id}\`);
+=======
+  const res = await fetch(\`/api/v2/users/\${id}\`, { credentials: "include" });
+>>>>>>> feature/auth-v2
   if (!res.ok) throw new Error("request failed");
   return res.json();
 }
`;

export const gitConflict: Scenario = {
  name: "git-conflict",
  description: "Merge of feature/auth-v2 into main stopped on 3 conflicted files.",
  init: () => {
    files = initial();
  },
  commands: {
    git_snapshot: () => ({
      isRepo: true,
      branch: "main",
      detached: false,
      upstream: "origin/main",
      ahead: 2,
      behind: 1,
      files: files.map(({ path, status, staged, conflicted }) => ({
        path,
        status,
        staged,
        conflicted,
      })),
      branches: [
        {
          name: "main",
          isCurrent: true,
          isRemote: false,
          upstream: "origin/main",
          ahead: 2,
          behind: 1,
          subject: "Tighten header spacing",
          date: "2026-09-17T09:12:00Z",
        },
        {
          name: "feature/auth-v2",
          isCurrent: false,
          isRemote: false,
          upstream: "origin/feature/auth-v2",
          ahead: 0,
          behind: 0,
          subject: "Switch API client to v2 endpoints",
          date: "2026-09-16T17:40:00Z",
        },
      ],
      stashes: [],
      inProgress: { merge: true, rebase: false, cherryPick: false, revert: false },
    }),
    git_inprogress: () => ({ merge: true, rebase: false, cherryPick: false, revert: false }),
    git_workspace_summary: () => ({
      isRepo: true,
      branch: "main",
      headSubject: "Tighten header spacing",
      dirty: true,
      additions: 42,
      deletions: 11,
    }),
    git_conflict_state: () => ({
      message: "Merge branch 'feature/auth-v2'",
      files: files
        .filter((f) => f.conflicted)
        .map((f) => ({ path: f.path, markerCount: f.markers, xy: "UU" })),
    }),
    git_resolve_file: ({ file }) => {
      files = files.map((f) => (f.path === file ? { ...f, conflicted: false, staged: true } : f));
      return null;
    },
    git_diff_file: () => API_DIFF,
    git_log: () => [
      {
        hash: "a1b2c3d4e5f6",
        short_hash: "a1b2c3d",
        message: "Tighten header spacing",
        author: "Dev",
        email: "dev@acme.dev",
        date: "2026-09-17T09:12:00Z",
      },
      {
        hash: "9f8e7d6c5b4a",
        short_hash: "9f8e7d6",
        message: "Add Button disabled state",
        author: "Dev",
        email: "dev@acme.dev",
        date: "2026-09-16T15:03:00Z",
      },
    ],
  },
};
