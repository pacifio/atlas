Make exactly these two changes in
`src/features/chat/stores/recent-files-store.ts` and change nothing else in
the repository.

1. In the `clear` action, the workspace guard is inverted. Change

   ```ts
   if (workspaceId) return;
   ```

   back to

   ```ts
   if (!workspaceId) return;
   ```

   Careful: the `push` action a few lines above contains the correct
   `if (!workspaceId) return;` guard already — that one must not change.

2. In the `push` action's catch handler, the warning label lost its
   underscores. Change

   ```ts
   console.warn("recent files push failed:", e)
   ```

   back to

   ```ts
   console.warn("recent_files_push failed:", e)
   ```

Do not reformat, rewrite, or touch any other line.
