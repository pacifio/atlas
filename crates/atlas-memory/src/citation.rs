//! Evidence for a memory: the lines of code that support it, and whether
//! they still do (M3, ADR-0018). A citation is checked at read time: the
//! exact span, then (when the memory names a symbol and a resolver knows it)
//! the symbol's current span, then any same-length window of the file. A
//! memory whose evidence changed is stale — shown as such, never as truth.
//!
//! The hash is the server's: [`cite`] reads the cited lines from disk when
//! the memory is written; an agent never supplies one.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// Files larger than this are not read for validation.
pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// A citation spans at most this many lines.
pub const MAX_LINES: u32 = 200;
/// A memory carries at most this many citations.
pub const MAX_CITATIONS: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Citation {
    /// Scope-root relative, `/`-separated.
    pub path: String,
    /// 1-based, inclusive.
    pub start_line: u32,
    pub end_line: u32,
    /// The function or type, so the lines can be found again if they move.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
    /// blake3 hex of the cited lines, each with its whitespace collapsed.
    pub hash: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Validity {
    /// The cited lines are unchanged.
    Valid,
    /// The same lines are elsewhere in the file (the citation as found now
    /// carries the new lines).
    Moved,
    /// The lines changed or the file is gone: the memory may no longer hold.
    Stale,
    /// The file can't be judged (too large, binary, unreadable).
    Unverifiable,
}

impl Validity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Valid => "valid",
            Self::Moved => "moved",
            Self::Stale => "stale",
            Self::Unverifiable => "unverifiable",
        }
    }
}

pub enum Read {
    Lines(Vec<String>),
    /// No such file (deleted, renamed): the evidence is gone.
    Missing,
    /// Too large, binary, not UTF-8, or unreadable: can't judge.
    Unreadable,
}

/// How citations are read: the files, and (when a code index is open) where
/// a symbol is now.
pub trait Resolver: Send + Sync {
    fn read(&self, rel: &str) -> Read;
    /// `(size, mtime in ns)`, for the cache.
    fn stamp(&self, rel: &str) -> Option<(u64, i128)>;
    /// The current 1-based `(start, end)` of `symbol` in `rel`, if known.
    fn symbol_span(&self, rel: &str, symbol: &str) -> Option<(u32, u32)>;
    /// The tree it reads (its root), so one cache can serve many projects.
    fn scope(&self) -> String {
        String::new()
    }
}

/// A line with its whitespace collapsed, as [`span_hash`] reads it.
fn normalized(line: &str) -> String {
    line.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// blake3 hex of the lines, each with its whitespace collapsed (so a
/// re-indent is not a change of meaning).
pub fn span_hash(lines: &[&str]) -> String {
    let mut h = blake3::Hasher::new();
    for l in lines {
        h.update(normalized(l).as_bytes());
        h.update(b"\n");
    }
    h.finalize().to_hex().to_string()
}

/// `rel` when it is a relative path that stays inside the root (no `..`,
/// not absolute, not empty).
pub fn safe_rel(rel: &str) -> Option<&str> {
    let p = Path::new(rel);
    let ok = !rel.is_empty()
        && !rel.starts_with('/')
        && !rel.starts_with('\\')
        && p.components()
            .all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
    ok.then_some(rel)
}

/// Reads citations from the files under a root.
pub struct FileResolver {
    root: PathBuf,
}

impl FileResolver {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }
}

impl Resolver for FileResolver {
    fn read(&self, rel: &str) -> Read {
        let Some(rel) = safe_rel(rel) else {
            return Read::Unreadable;
        };
        // Only a file that isn't there is gone; any other failure (no
        // permission, a sharing lock) can't be judged.
        let failed = |e: std::io::Error| match e.kind() {
            std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory => Read::Missing,
            _ => Read::Unreadable,
        };
        let path = self.root.join(rel);
        let meta = match std::fs::metadata(&path) {
            Ok(meta) => meta,
            Err(e) => return failed(e),
        };
        if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
            return Read::Unreadable;
        }
        match std::fs::read(&path) {
            Ok(bytes) if !bytes.contains(&0) => match String::from_utf8(bytes) {
                Ok(text) => Read::Lines(text.lines().map(str::to_string).collect()),
                Err(_) => Read::Unreadable,
            },
            Ok(_) => Read::Unreadable,
            Err(e) => failed(e),
        }
    }

    fn stamp(&self, rel: &str) -> Option<(u64, i128)> {
        let meta = std::fs::metadata(self.root.join(safe_rel(rel)?)).ok()?;
        let mtime = meta
            .modified()
            .ok()?
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_nanos() as i128;
        Some((meta.len(), mtime))
    }

    fn symbol_span(&self, _rel: &str, _symbol: &str) -> Option<(u32, u32)> {
        None
    }

    fn scope(&self) -> String {
        self.root.to_string_lossy().into_owned()
    }
}

fn span(lines: &[String], start: u32, end: u32) -> Option<Vec<&str>> {
    if start == 0 || end < start || end as usize > lines.len() {
        return None;
    }
    Some(
        lines[(start - 1) as usize..end as usize]
            .iter()
            .map(String::as_str)
            .collect(),
    )
}

/// Cite lines `start..=end` of `rel` as they are now.
pub fn cite(
    r: &dyn Resolver,
    rel: &str,
    start: u32,
    end: u32,
    symbol: Option<String>,
) -> Result<Citation, String> {
    let rel =
        safe_rel(rel).ok_or_else(|| format!("`{rel}` is not a path inside the repository"))?;
    if end < start || start == 0 {
        return Err(format!("lines {start}-{end} are not a range"));
    }
    if end - start + 1 > MAX_LINES {
        return Err(format!("a citation spans at most {MAX_LINES} lines"));
    }
    let Read::Lines(lines) = r.read(rel) else {
        return Err(format!("`{rel}` can't be read as text"));
    };
    let cited =
        span(&lines, start, end).ok_or_else(|| format!("`{rel}` has {} lines", lines.len()))?;
    Ok(Citation {
        path: rel.replace('\\', "/"),
        start_line: start,
        end_line: end,
        symbol,
        hash: span_hash(&cited),
    })
}

/// Whether `c` still holds, and the citation as it stands now.
pub fn validate(c: &Citation, r: &dyn Resolver) -> (Validity, Citation) {
    let lines = match r.read(&c.path) {
        Read::Lines(l) => l,
        Read::Missing => return (Validity::Stale, c.clone()),
        Read::Unreadable => return (Validity::Unverifiable, c.clone()),
    };
    if span(&lines, c.start_line, c.end_line).is_some_and(|s| span_hash(&s) == c.hash) {
        return (Validity::Valid, c.clone());
    }
    let moved = |start: u32, end: u32| Citation {
        start_line: start,
        end_line: end,
        ..c.clone()
    };
    if let Some((s, e)) = c
        .symbol
        .as_deref()
        .and_then(|sym| r.symbol_span(&c.path, sym))
    {
        if span(&lines, s, e).is_some_and(|x| span_hash(&x) == c.hash) {
            return (Validity::Moved, moved(s, e));
        }
    }
    let len = c.end_line.saturating_sub(c.start_line) as usize + 1;
    let Ok(want) = blake3::Hash::from_hex(&c.hash) else {
        return (Validity::Stale, c.clone());
    };
    if lines.len() >= len {
        // Each line normalized once; a window's hash is then one slice of
        // the bytes span_hash would feed for those lines.
        let mut text = String::new();
        let mut at = Vec::with_capacity(lines.len() + 1);
        at.push(0);
        for l in &lines {
            text.push_str(&normalized(l));
            text.push('\n');
            at.push(text.len());
        }
        for (start, w) in at.windows(len + 1).enumerate() {
            if blake3::hash(&text.as_bytes()[w[0]..w[len]]) == want {
                let first = start as u32 + 1;
                return (Validity::Moved, moved(first, first + len as u32 - 1));
            }
        }
    }
    (Validity::Stale, c.clone())
}

/// Validation results, reused while a file's size and mtime are unchanged.
/// A validation result's key: `(scope, path, size, mtime, hash, start, end)`.
type CacheKey = (String, String, u64, i128, String, u32, u32);

pub struct ValidationCache {
    seen: Mutex<HashMap<CacheKey, (Validity, Citation)>>,
}

impl Default for ValidationCache {
    fn default() -> Self {
        Self::new()
    }
}

impl ValidationCache {
    pub fn new() -> Self {
        Self {
            seen: Mutex::new(HashMap::new()),
        }
    }

    pub fn check(&self, c: &Citation, r: &dyn Resolver) -> (Validity, Citation) {
        let Some((size, mtime)) = r.stamp(&c.path) else {
            return validate(c, r);
        };
        let key = (
            r.scope(),
            c.path.clone(),
            size,
            mtime,
            c.hash.clone(),
            c.start_line,
            c.end_line,
        );
        if let Some(hit) = self
            .seen
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&key)
        {
            return hit.clone();
        }
        let out = validate(c, r);
        // Unverifiable may be passing (a lock, a permission later fixed)
        // without the stamp changing: judged again next time.
        if out.0 == Validity::Unverifiable {
            return out;
        }
        let mut seen = self
            .seen
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if seen.len() > 10_000 {
            seen.clear();
        }
        seen.insert(key, out.clone());
        out
    }
}

/// The overall validity of a memory's citations: stale if any is stale,
/// else moved if any moved, else valid; unverifiable only when every one is.
/// `None` for a memory without citations.
pub fn overall(results: &[Validity]) -> Option<Validity> {
    if results.is_empty() {
        return None;
    }
    if results.contains(&Validity::Stale) {
        return Some(Validity::Stale);
    }
    if results.iter().all(|v| *v == Validity::Unverifiable) {
        return Some(Validity::Unverifiable);
    }
    if results.contains(&Validity::Moved) {
        return Some(Validity::Moved);
    }
    Some(Validity::Valid)
}

/// Whether one file a session landed in a commit still holds that work.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kept {
    Yes,
    No,
    /// No fingerprint to compare (an old row, a binary or huge file), or the
    /// tree it lived in is gone.
    Unknown,
}

/// A commit that carried the work of the turn a memory was written in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitEvidence {
    /// The first 12 hex of the commit, as the record holds it now (a rebase
    /// re-points it).
    pub sha: String,
    pub orphaned: bool,
}

/// What work evidence says about a memory that cites no code: valid when any
/// landed file still holds the work, stale when every file was judged and
/// none does, unverifiable otherwise. `None` without evidence.
pub fn work_validity(kept: &[Kept]) -> Option<Validity> {
    if kept.is_empty() {
        return None;
    }
    if kept.contains(&Kept::Yes) {
        return Some(Validity::Valid);
    }
    if kept.iter().all(|k| *k == Kept::No) {
        return Some(Validity::Stale);
    }
    Some(Validity::Unverifiable)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (rel, text) in files {
            let p = dir.path().join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
        dir
    }

    const SRC: &str = "use x;\n\npub fn ttl() -> u32 {\n    15\n}\n";

    #[test]
    fn an_unchanged_span_is_valid() {
        let dir = project(&[("src/ttl.rs", SRC)]);
        let r = FileResolver::new(dir.path());
        let c = cite(&r, "src/ttl.rs", 3, 5, None).unwrap();
        assert_eq!(validate(&c, &r).0, Validity::Valid);
    }

    #[test]
    fn a_moved_span_is_found_and_reported() {
        let dir = project(&[("src/ttl.rs", SRC)]);
        let r = FileResolver::new(dir.path());
        let c = cite(&r, "src/ttl.rs", 3, 5, None).unwrap();
        std::fs::write(
            dir.path().join("src/ttl.rs"),
            format!("// header\n// more\n{SRC}"),
        )
        .unwrap();
        let (v, now) = validate(&c, &r);
        assert_eq!(v, Validity::Moved);
        assert_eq!((now.start_line, now.end_line), (5, 7));
    }

    #[test]
    fn whitespace_only_changes_do_not_make_it_stale() {
        let dir = project(&[("src/ttl.rs", SRC)]);
        let r = FileResolver::new(dir.path());
        let c = cite(&r, "src/ttl.rs", 3, 5, None).unwrap();
        std::fs::write(
            dir.path().join("src/ttl.rs"),
            SRC.replace("    15", "        15"),
        )
        .unwrap();
        assert_eq!(validate(&c, &r).0, Validity::Valid);
    }

    #[test]
    fn a_changed_span_is_stale() {
        let dir = project(&[("src/ttl.rs", SRC)]);
        let r = FileResolver::new(dir.path());
        let c = cite(&r, "src/ttl.rs", 3, 5, None).unwrap();
        std::fs::write(dir.path().join("src/ttl.rs"), SRC.replace("15", "30")).unwrap();
        assert_eq!(validate(&c, &r).0, Validity::Stale);
    }

    #[test]
    fn a_missing_file_makes_the_citation_stale() {
        let dir = project(&[("src/ttl.rs", SRC)]);
        let r = FileResolver::new(dir.path());
        let c = cite(&r, "src/ttl.rs", 3, 5, None).unwrap();
        std::fs::remove_file(dir.path().join("src/ttl.rs")).unwrap();
        assert_eq!(validate(&c, &r).0, Validity::Stale);
    }

    #[test]
    fn a_path_through_a_file_is_stale() {
        let dir = project(&[("src/ttl.rs", SRC)]);
        let r = FileResolver::new(dir.path());
        assert!(matches!(r.read("src/ttl.rs/inner"), Read::Missing));
    }

    /// A file that exists but can't be read is unverifiable, not stale, and
    /// that verdict isn't cached: once it is readable again (same size and
    /// mtime) it is valid.
    #[cfg(unix)]
    #[test]
    fn an_unreadable_file_is_unverifiable_and_not_cached() {
        use std::os::unix::fs::PermissionsExt;
        let dir = project(&[("src/ttl.rs", SRC)]);
        let r = FileResolver::new(dir.path());
        let c = cite(&r, "src/ttl.rs", 3, 5, None).unwrap();
        let file = dir.path().join("src/ttl.rs");
        let mode = |m: u32| {
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(m)).unwrap();
        };
        mode(0o000);
        if std::fs::read(&file).is_ok() {
            // Root reads it anyway: nothing to check.
            mode(0o644);
            return;
        }
        let cache = ValidationCache::new();
        assert_eq!(cache.check(&c, &r).0, Validity::Unverifiable);
        mode(0o644);
        assert_eq!(cache.check(&c, &r).0, Validity::Valid);
    }

    #[test]
    fn a_huge_or_binary_file_is_unverifiable() {
        let dir = project(&[("bin.dat", "a\0b\n")]);
        let r = FileResolver::new(dir.path());
        let c = Citation {
            path: "bin.dat".into(),
            start_line: 1,
            end_line: 1,
            symbol: None,
            hash: "x".into(),
        };
        assert_eq!(validate(&c, &r).0, Validity::Unverifiable);
        assert!(
            cite(&r, "bin.dat", 1, 1, None).is_err(),
            "nothing to cite in a binary file"
        );
    }

    #[test]
    fn citing_needs_a_real_range_and_stays_inside_the_root() {
        let dir = project(&[("src/ttl.rs", SRC)]);
        let r = FileResolver::new(dir.path());
        assert!(cite(&r, "src/ttl.rs", 4, 2, None).is_err());
        assert!(cite(&r, "src/ttl.rs", 1, 99, None).is_err());
        assert!(cite(&r, "../outside.rs", 1, 1, None).is_err());
        assert!(cite(&r, "/etc/passwd", 1, 1, None).is_err());
    }

    #[test]
    fn the_cache_rechecks_only_when_the_file_changes() {
        struct Counting<'a>(&'a FileResolver, std::sync::atomic::AtomicUsize);
        impl Resolver for Counting<'_> {
            fn read(&self, rel: &str) -> Read {
                self.1.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                self.0.read(rel)
            }
            fn stamp(&self, rel: &str) -> Option<(u64, i128)> {
                self.0.stamp(rel)
            }
            fn symbol_span(&self, rel: &str, s: &str) -> Option<(u32, u32)> {
                self.0.symbol_span(rel, s)
            }
        }
        let dir = project(&[("src/ttl.rs", SRC)]);
        let files = FileResolver::new(dir.path());
        let c = cite(&files, "src/ttl.rs", 3, 5, None).unwrap();
        let counting = Counting(&files, Default::default());
        let cache = ValidationCache::new();
        cache.check(&c, &counting);
        cache.check(&c, &counting);
        assert_eq!(counting.1.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn work_is_valid_while_any_file_keeps_it_and_stale_only_when_none_does() {
        use Kept::*;
        assert_eq!(work_validity(&[]), None);
        assert_eq!(work_validity(&[No, Yes]), Some(Validity::Valid));
        assert_eq!(work_validity(&[No, No]), Some(Validity::Stale));
        assert_eq!(work_validity(&[No, Unknown]), Some(Validity::Unverifiable));
    }
}
