Make exactly these two changes in `crates/atlas-redact/src/credential.rs`
and change nothing else in the repository.

1. The minimum-value-length constant was lowered by mistake. Change

   ```rust
   const MIN_VALUE_LEN: usize = 3;
   ```

   back to

   ```rust
   const MIN_VALUE_LEN: usize = 4;
   ```

2. In the `is_quoted` function, the length guard must admit two-character
   quoted values. Change

   ```rust
   value.len() > 2
   ```

   back to

   ```rust
   value.len() >= 2
   ```

Do not reformat, rewrite, or touch any other line.
