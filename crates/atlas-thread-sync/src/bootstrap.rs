//! Getting a thread's Base onto a machine that lacks it (ATL-402).
//!
//! Joy may share a thread on commits she never pushed, or from a repository
//! with no remote at all; Alice may join with an older clone, or with no copy
//! of the repository. Either way the joiner reports the commits it has, a
//! replica that holds the Base builds a `git bundle` of only what is missing
//! (everything, when the joiner has nothing), uploads it to the thread, and
//! the joiner fetches it.
//!
//! Neither side ever writes to the person's own repository. Each machine keeps
//! a **thread repository** per joined thread — a bare repository under the
//! app's data directory that *borrows* the person's objects through git's
//! alternates — and does all bundle work there: a builder needs a ref to
//! bundle, and a joiner needs somewhere to fetch into. The joiner's replica
//! worktree is then checked out of the thread repository.

use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::git::{self, GitError};

/// Where the Base lives in a thread repository.
pub const BASE_REF: &str = "refs/atlas/base";

/// The most commits a joiner reports (the server's own cap).
pub const MAX_HAVE: usize = 256;

#[derive(Debug, thiserror::Error)]
pub enum BootstrapError {
    #[error(transparent)]
    Git(#[from] GitError),
    #[error("i/o on {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("the bundle does not hash to the name it was fetched by")]
    Corrupt,
    #[error("the bundle does not hold the thread's Base {0}")]
    WrongBase(String),
}

fn io(path: &Path) -> impl FnOnce(std::io::Error) -> BootstrapError + '_ {
    move |source| BootstrapError::Io {
        path: path.to_path_buf(),
        source,
    }
}

/// A bundle built for somebody: its bytes, their SHA-256 (its name under the
/// thread) and the commits it needs the receiver to have.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bundle {
    pub bytes: Vec<u8>,
    pub sha256: String,
    pub prerequisites: Vec<String>,
}

/// One thread's bare repository on this machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadRepo {
    path: PathBuf,
}

impl ThreadRepo {
    pub fn at(path: &Path) -> Self {
        Self {
            path: path.to_path_buf(),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Create it if needed, borrowing `borrow_from`'s objects (the person's
    /// own repository) when there is one. Borrowing is read-only: git never
    /// writes into an alternate.
    pub fn ensure(&self, borrow_from: Option<&Path>) -> Result<(), BootstrapError> {
        git::init_bare(&self.path)?;
        let ours = self.path.join("objects");
        let mut lines = Vec::new();
        if let Some(repo) = borrow_from {
            let theirs = git::objects_dir(repo)?;
            let same = fs::canonicalize(&theirs).ok() == fs::canonicalize(&ours).ok();
            if !same {
                lines.push(theirs.to_string_lossy().into_owned());
            }
        }
        let info = ours.join("info");
        fs::create_dir_all(&info).map_err(io(&info))?;
        let alternates = info.join("alternates");
        if lines.is_empty() {
            match fs::remove_file(&alternates) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(io(&alternates)(e)),
            }
            return Ok(());
        }
        fs::write(&alternates, lines.join("\n") + "\n").map_err(io(&alternates))
    }

    /// Does it hold `base`, fetched or borrowed?
    pub fn has(&self, base: &str) -> bool {
        self.path.join("HEAD").exists() && git::has_commit(&self.path, base)
    }

    /// Build a bundle of `base` for a joiner who holds `have`. The thread
    /// repository must already reach `base` (through the person's objects).
    pub fn build(&self, base: &str, have: &[String]) -> Result<Bundle, BootstrapError> {
        git::update_ref(&self.path, BASE_REF, base)?;
        let mut have = have;
        let mut prerequisites = git::boundary(&self.path, base, have)?;
        // The server names at most this many; past it, a full bundle needs none.
        if prerequisites.len() > MAX_HAVE {
            have = &[];
            prerequisites = Vec::new();
        }
        let file = self.scratch("out")?;
        let built = git::bundle_create(&self.path, &file, BASE_REF, have);
        let bytes = built
            .map_err(BootstrapError::from)
            .and_then(|()| fs::read(&file).map_err(io(&file)));
        let _ = fs::remove_file(&file);
        let bytes = bytes?;
        Ok(Bundle {
            sha256: sha256_hex(&bytes),
            bytes,
            prerequisites,
        })
    }

    /// Fetch the Base out of a downloaded bundle, checking it is the bundle
    /// that was named and that it carries the Base.
    pub fn install(&self, base: &str, sha256: &str, bytes: &[u8]) -> Result<(), BootstrapError> {
        if sha256_hex(bytes) != sha256 {
            return Err(BootstrapError::Corrupt);
        }
        let file = self.scratch("in")?;
        fs::write(&file, bytes).map_err(io(&file))?;
        let fetched = git::fetch_bundle(&self.path, &file, BASE_REF);
        let _ = fs::remove_file(&file);
        fetched?;
        if git::resolve_ref(&self.path, BASE_REF).as_deref() != Some(base) {
            return Err(BootstrapError::WrongBase(base.to_string()));
        }
        Ok(())
    }

    fn scratch(&self, what: &str) -> Result<PathBuf, BootstrapError> {
        let dir = self.path.join("atlas-bundles");
        fs::create_dir_all(&dir).map_err(io(&dir))?;
        Ok(dir.join(format!("{what}-{}.bundle", uuid::Uuid::new_v4().simple())))
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
