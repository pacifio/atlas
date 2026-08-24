//! `PathList` / `WorktreePaths` — Zed's path types, ported.
//!
//! Source: `zed-ref/crates/util/src/path_list.rs:18-130` and
//! `zed-ref/crates/project/src/worktree_store.rs:46-150`.
//!
//! Two properties carry the whole design and are the reason these are not just
//! `Vec<PathBuf>`:
//!
//! * **Equality ignores the order the paths were given in.** A project opened as
//!   `[a, b]` and as `[b, a]` is the same project, so it must be the same
//!   grouping key — which is what makes the sidebar's per-project bucket work.
//! * **Display order is preserved separately.** The user's ordering is theirs;
//!   it round-trips through the database in the `*_order` columns.
//!
//! Divergence from Zed: `SanitizedPath` (its Windows UNC/verbatim-prefix
//! normalisation) is not ported. Paths are stored as given, minus a trailing
//! separator, which is identity on the platforms Atlas ships.

use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// A list of absolute paths with an associated display order.
///
/// Equal when the same paths are present, whatever order they arrived in.
#[derive(Default, Debug, Clone)]
pub struct PathList {
    /// The paths, lexicographically ordered.
    paths: Arc<[PathBuf]>,
    /// For each lexicographic slot, the index it occupied when provided.
    order: Arc<[usize]>,
}

impl PartialEq for PathList {
    fn eq(&self, other: &Self) -> bool {
        self.paths == other.paths
    }
}

impl Eq for PathList {}

impl Hash for PathList {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.paths.hash(state);
    }
}

/// The two `TEXT` columns a [`PathList`] occupies in the database.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SerializedPathList {
    pub paths: String,
    pub order: String,
}

impl PathList {
    pub fn new<P: AsRef<Path>>(paths: &[P]) -> Self {
        let mut indexed: Vec<(usize, PathBuf)> = paths
            .iter()
            .enumerate()
            .map(|(ix, path)| (ix, normalize(path.as_ref())))
            .collect();
        indexed.sort_by(|(_, a), (_, b)| a.cmp(b));
        let order = indexed.iter().map(|e| e.0).collect::<Vec<_>>().into();
        let paths = indexed.into_iter().map(|e| e.1).collect::<Vec<_>>().into();
        Self { paths, order }
    }

    pub fn is_empty(&self) -> bool {
        self.paths.is_empty()
    }

    pub fn len(&self) -> usize {
        self.paths.len()
    }

    /// The paths, lexicographically ordered.
    pub fn paths(&self) -> &[PathBuf] {
        self.paths.as_ref()
    }

    /// The order in which the paths were provided.
    pub fn order(&self) -> &[usize] {
        self.order.as_ref()
    }

    /// The paths in the order the user provided them.
    pub fn ordered_paths(&self) -> impl Iterator<Item = &PathBuf> {
        let mut pairs: Vec<(usize, &PathBuf)> =
            self.order.iter().copied().zip(self.paths.iter()).collect();
        pairs.sort_by_key(|(i, _)| *i);
        pairs.into_iter().map(|(_, path)| path)
    }

    pub fn contains(&self, path: &Path) -> bool {
        let path = normalize(path);
        self.paths.contains(&path)
    }

    pub fn serialize(&self) -> SerializedPathList {
        SerializedPathList {
            paths: self
                .paths
                .iter()
                .map(|p| p.to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join("\n"),
            order: self
                .order
                .iter()
                .map(|i| i.to_string())
                .collect::<Vec<_>>()
                .join(","),
        }
    }

    /// The inverse of [`PathList::serialize`], tolerant of a torn `order`
    /// column: a length mismatch or an out-of-order `paths` column falls back
    /// to lexicographic order rather than failing the whole read
    /// (`path_list.rs:110-121`).
    pub fn deserialize(serialized: &SerializedPathList) -> Self {
        let mut paths: Vec<PathBuf> = if serialized.paths.is_empty() {
            Vec::new()
        } else {
            serialized.paths.split('\n').map(PathBuf::from).collect()
        };
        let mut order: Vec<usize> = serialized
            .order
            .split(',')
            .filter_map(|s| s.parse().ok())
            .collect();

        if !paths.is_sorted() || order.len() != paths.len() {
            paths.sort();
            order = (0..paths.len()).collect();
        }

        Self {
            paths: paths.into(),
            order: order.into(),
        }
    }
}

/// A thread's folder paths paired with the main worktree each one belongs to.
///
/// For an ordinary checkout the two are identical; for a linked git worktree the
/// main path is the original repository and the folder path is where the linked
/// worktree lives. The two lists are parallel and always the same length.
#[derive(Default, Debug, Clone)]
pub struct WorktreePaths {
    paths: PathList,
    main_paths: PathList,
}

impl PartialEq for WorktreePaths {
    fn eq(&self, other: &Self) -> bool {
        self.ordered_pairs().eq(other.ordered_pairs())
    }
}

impl Eq for WorktreePaths {}

impl WorktreePaths {
    /// Build from two parallel lists that already share an insertion order.
    ///
    /// Errors when the lengths disagree, which can only mean a torn write.
    pub fn from_path_lists(
        main_worktree_paths: PathList,
        folder_paths: PathList,
    ) -> Result<Self, LengthMismatch> {
        if main_worktree_paths.len() != folder_paths.len() {
            return Err(LengthMismatch {
                main: main_worktree_paths.len(),
                folder: folder_paths.len(),
            });
        }
        Ok(Self {
            paths: folder_paths,
            main_paths: main_worktree_paths,
        })
    }

    /// The ordinary case: every folder path is its own main worktree.
    pub fn from_folder_paths(folder_paths: &PathList) -> Self {
        Self {
            paths: folder_paths.clone(),
            main_paths: folder_paths.clone(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.paths.is_empty()
    }

    /// The folder paths — the sidebar's per-project grouping key.
    pub fn folder_path_list(&self) -> &PathList {
        &self.paths
    }

    /// The main worktree paths — the key that gathers a linked worktree's
    /// threads under the project they belong to.
    pub fn main_worktree_path_list(&self) -> &PathList {
        &self.main_paths
    }

    /// `(main_worktree_path, folder_path)` pairs in insertion order.
    pub fn ordered_pairs(&self) -> impl Iterator<Item = (&PathBuf, &PathBuf)> {
        self.main_paths
            .ordered_paths()
            .zip(self.paths.ordered_paths())
    }
}

/// The two path lists of a [`WorktreePaths`] disagreed on length.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LengthMismatch {
    pub main: usize,
    pub folder: usize,
}

impl std::fmt::Display for LengthMismatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "main_worktree_paths has {} entries but folder_paths has {}",
            self.main, self.folder
        )
    }
}

impl std::error::Error for LengthMismatch {}

fn normalize(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    let trimmed = text.trim_end_matches(std::path::MAIN_SEPARATOR);
    if trimmed.is_empty() {
        path.to_path_buf()
    } else {
        PathBuf::from(trimmed)
    }
}
