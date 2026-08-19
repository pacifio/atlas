Make exactly these two changes in `crates/atlas-codeindex/src/lib.rs` and
change nothing else in the repository.

1. In the `scan` function's `WalkBuilder` chain, gitignore handling was
   disabled by mistake. Change

   ```rust
   .git_ignore(false)
   ```

   back to

   ```rust
   .git_ignore(true)
   ```

   Note the chain contains several similar-looking builder calls
   (`.git_global(true)`, `.git_exclude(true)`, `.ignore(true)`) — only the
   `git_ignore` line changes.

2. In `language_label`, the Go arm uses the wrong label. Change

   ```rust
   Language::Go => "golang",
   ```

   back to

   ```rust
   Language::Go => "go",
   ```

Do not reformat, rewrite, or touch any other line.
