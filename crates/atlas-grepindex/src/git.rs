//! The two questions the index asks git, answered by the real git binary (atlas-git).

use std::path::Path;

use atlas_git::GitCommand;

use crate::error::{git_err, Error};

/// Work-tree-relative paths that differ from HEAD: staged, unstaged, deleted and untracked
/// (not ignored). Renames are reported as a delete plus an add.
pub fn status_paths(root: &Path) -> Result<Vec<String>, Error> {
    let out = GitCommand::new(
        root,
        &[
            "status",
            "--porcelain=2",
            "-z",
            "--untracked-files=all",
            "--no-renames",
            "--ignore-submodules=all",
        ],
    )
    .read_only()
    .run()
    .map_err(git_err)?;
    Ok(atlas_git::status::parse(out.stdout.as_bytes())
        .entries
        .into_iter()
        .filter(|e| !e.is_submodule)
        .map(|e| e.path)
        .collect())
}

/// Paths whose content differs between two trees (hex object ids).
pub fn diff_tree_paths(root: &Path, from: &str, to: &str) -> Result<Vec<String>, Error> {
    let out = GitCommand::new(
        root,
        &[
            "diff-tree",
            "-r",
            "-z",
            "--name-only",
            "--no-renames",
            from,
            to,
        ],
    )
    .read_only()
    .run()
    .map_err(git_err)?;
    Ok(out
        .stdout
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect())
}
