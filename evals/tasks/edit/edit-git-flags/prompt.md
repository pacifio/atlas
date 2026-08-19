Make exactly these two changes in `src-tauri/src/commands/git.rs` and
change nothing else in the repository.

1. The status command must use porcelain v1. Change the argument

   ```rust
   "--porcelain=v2",
   ```

   back to

   ```rust
   "--porcelain=v1",
   ```

2. The commit-log listing must be in topological order. Change the argument

   ```rust
   "--date-order".into(),
   ```

   back to

   ```rust
   "--topo-order".into(),
   ```

Do not reformat, rewrite, or touch any other line.
