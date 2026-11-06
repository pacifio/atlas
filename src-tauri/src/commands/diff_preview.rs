//! The review diff: every change in a project as raw unified patches, for the
//! diff viewer that renders patches itself.
//!
//! `git_diff_preview` answers with two sources. `working-tree` is everything
//! uncommitted against `HEAD`; `branch-range` is the working tree against the
//! merge base with the base branch, so it holds the branch's commits too. Each
//! carries the complete per-file numstat and a patch capped at
//! [`PATCH_CAP`]. The cap cuts at a file boundary, so every file the patch
//! holds is whole. `truncated` means some listed file is not in the patch —
//! past the cap, or an untracked file too large to count — and the viewer
//! loads each missing one through `git_diff_file_contents`.
//!
//! Untracked files belong in a review — they are usually most of what an agent
//! wrote — but `git diff` cannot see them. Rather than staging them into a
//! scratch index (three more spawns and an index copy), their patches are
//! written here: an untracked file's diff is the whole file added, so there is
//! nothing to compute.
//!
//! Paths are relative to the project path (`--relative`), matching the file
//! tree, and a project opened in a subdirectory of its repository sees only
//! its own changes.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::{Component, Path};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};

/// Patch bytes per source. Past this a review is read file by file anyway,
/// and every byte crosses IPC and is parsed on the UI thread.
pub const PATCH_CAP: usize = 120_000;
/// Text per side for `git_diff_file_contents`.
pub const FILE_CAP: usize = 1024 * 1024;
/// Untracked files whose lines are counted. Past this they are listed with
/// unknown counts and the source is marked truncated.
const UNTRACKED_COUNT_MAX: usize = 5_000;
/// The largest untracked file whose lines are counted. Counting means reading
/// it, on every refresh; a stray video or dump should not cost that.
const COUNT_CAP: u64 = 4 * 1024 * 1024;
/// Git's own binary sniff: a NUL in the first 8000 bytes.
const BINARY_SNIFF: usize = 8000;

const DIFF_ARGS: &[&str] = &[
    "diff",
    "--relative",
    "--find-renames",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    // A user's `diff.noprefix` / `diff.mnemonicPrefix` would otherwise leak
    // into the patch and leave the parser with unnamed files.
    "--src-prefix=a/",
    "--dst-prefix=b/",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SourceKind {
    #[serde(rename = "working-tree")]
    WorkingTree,
    #[serde(rename = "branch-range")]
    BranchRange,
}

#[derive(Debug, Clone, Serialize, Hash)]
#[serde(rename_all = "camelCase")]
pub struct DiffFileStat {
    pub path: String,
    /// The path before a rename or copy.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    /// `None` when not counted: an untracked file over [`COUNT_CAP`], or past
    /// the first [`UNTRACKED_COUNT_MAX`] untracked files. The source is then
    /// marked truncated. Binary files count 0, as git's `-` does.
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
    /// "added" | "deleted" | "modified" | "renamed" | "copied" |
    /// "conflicted" | "untracked".
    pub status: &'static str,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub binary: bool,
    /// The working-tree file's modification time and size, so a client can
    /// tell a file changed when its counts did not. `None` when it is absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sig: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffSource {
    pub kind: SourceKind,
    /// `branch-range` only: the base it was taken against (`origin/main`),
    /// or `None` when no base branch could be found and the range is just
    /// the working tree.
    pub base_ref: Option<String>,
    /// `branch-range` only: the merge-base commit. Pass it back as
    /// `git_diff_file_contents`' `base_ref` to skip resolving the base again.
    pub merge_base: Option<String>,
    pub diff: String,
    /// Changes when the patch or the file list does; stable within a run.
    pub diff_hash: String,
    /// Some file in `files` is not in `diff`; check each before rendering.
    pub truncated: bool,
    /// Complete even when `diff` is truncated.
    pub files: Vec<DiffFileStat>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct DiffPreview {
    /// Empty outside a git repository.
    pub sources: Vec<DiffSource>,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiffFileContents {
    pub old_text: String,
    pub new_text: String,
    /// A side was longer than [`FILE_CAP`] and is cut at a line boundary.
    pub truncated: bool,
    /// Either side is binary; both texts are then empty.
    pub binary: bool,
}

// ── Commands ────────────────────────────────────────────────────────────────

/// Coalescing state for one `(path, base_ref, ignore_ws)`.
///
/// Runs are serialised by `run`. A caller may only take the result of a run
/// that STARTED after it arrived: one arriving mid-run may be asking because
/// of a write that run cannot have seen (an agent saves `foo.rs`, the watcher
/// asks again while the earlier run is still reading). So each caller notes
/// the number of the next run to start, waits its turn, and either finds that
/// run's result already stored or starts it itself. Every caller that queued
/// behind the same run shares it.
#[derive(Default)]
struct Slot {
    run: tokio::sync::Mutex<()>,
    state: parking_lot::Mutex<SlotState>,
}

#[derive(Default)]
struct SlotState {
    /// Runs started so far.
    started: u64,
    /// The newest finished run: its number and result.
    last: Option<(u64, Result<DiffPreview, String>)>,
}

fn slots() -> &'static Mutex<HashMap<String, Arc<Slot>>> {
    static MAP: OnceLock<Mutex<HashMap<String, Arc<Slot>>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Drops the slot once its last caller is gone, on every exit path —
/// including a caller whose future is dropped mid-run — so neither the slot
/// nor its stored result outlives the callers that wanted it.
struct SlotGuard {
    key: String,
    slot: Arc<Slot>,
}

impl Drop for SlotGuard {
    fn drop(&mut self) {
        let mut map = slots()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // Clones are only made under this lock: map + this guard = no one else.
        if Arc::strong_count(&self.slot) == 2 {
            map.remove(&self.key);
        }
    }
}

/// Both review sources for the project at `path`. Concurrent identical calls
/// (the watcher's refresh racing the panel's own) share one computation, but
/// never one that started before they were made.
#[tauri::command]
#[expect(
    clippy::await_holding_invalid_type,
    reason = "the turn guard must span the run: it is what serialises runs per key so callers can queue behind one"
)]
pub async fn git_diff_preview(
    path: String,
    base_ref: Option<String>,
    ignore_whitespace: Option<bool>,
) -> Result<DiffPreview, String> {
    let ignore_ws = ignore_whitespace.unwrap_or(false);
    let key = format!("{path}\0{}\0{ignore_ws}", base_ref.as_deref().unwrap_or(""));
    let guard = {
        let mut map = slots()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let slot = map.entry(key.clone()).or_default().clone();
        SlotGuard { key, slot }
    };
    let slot = &guard.slot;
    let wanted = slot.state.lock().started + 1;

    // Held until this run's result is stored. A dropped future releases it
    // with nothing stored, and the next caller in line runs instead.
    let _turn = slot.run.lock().await;
    let number = {
        let mut st = slot.state.lock();
        if let Some((n, result)) = &st.last {
            if *n >= wanted {
                return result.clone();
            }
        }
        st.started += 1;
        st.started
    };
    let result = tokio::task::spawn_blocking(move || {
        compute_preview(Path::new(&path), base_ref.as_deref(), ignore_ws)
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    slot.state.lock().last = Some((number, result.clone()));
    result
}

/// Both sides of one file, for a viewer expanding a file the capped patch
/// left out (or showing full context). `source_kind` picks the old side:
/// `HEAD` for the working tree, the merge base for the branch range. The new
/// side is always the file on disk. A side that does not exist (added,
/// deleted) is empty.
#[tauri::command]
pub async fn git_diff_file_contents(
    path: String,
    source_kind: SourceKind,
    base_ref: Option<String>,
    file_path: String,
    old_path: Option<String>,
) -> Result<DiffFileContents, String> {
    tokio::task::spawn_blocking(move || {
        file_contents(
            Path::new(&path),
            source_kind,
            base_ref.as_deref(),
            &file_path,
            old_path.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One file's unified patch for a review source, diffed by git: what the
/// review panel shows for a file the capped preview left out. Computed here so
/// the UI thread only parses a patch, and so `ignore_whitespace` applies to it
/// as it does to the preview.
#[tauri::command]
pub async fn git_diff_file_patch(
    path: String,
    source_kind: SourceKind,
    base_ref: Option<String>,
    file_path: String,
    old_path: Option<String>,
    ignore_whitespace: Option<bool>,
) -> Result<DiffFilePatch, String> {
    tokio::task::spawn_blocking(move || {
        file_patch(
            Path::new(&path),
            source_kind,
            base_ref.as_deref(),
            &file_path,
            old_path.as_deref(),
            ignore_whitespace.unwrap_or(false),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A unified patch between two texts (see [`texts_patch`]): a session turn's
/// edit, diffed from the before/after its tool call carried.
#[tauri::command]
pub async fn diff_texts_patch(
    old_text: String,
    new_text: String,
    file: String,
    ignore_whitespace: Option<bool>,
) -> Result<DiffFilePatch, String> {
    tokio::task::spawn_blocking(move || {
        texts_patch(
            &old_text,
            &new_text,
            &file,
            ignore_whitespace.unwrap_or(false),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Git plumbing ────────────────────────────────────────────────────────────

/// A read-only git: `--no-optional-locks` so a background read never takes
/// `index.lock` from under a commit (see `git::git_read`), and unquoted paths.
/// `LC_ALL=C` keeps git's messages in English whatever the user's locale, so
/// nothing that reads stderr depends on a translation.
fn git(cwd: &Path) -> Command {
    let mut cmd = atlas_process::command("git");
    cmd.args(["--no-optional-locks", "-c", "core.quotePath=false"])
        .env("LC_ALL", "C")
        .current_dir(cwd);
    cmd
}

struct Out {
    ok: bool,
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: String,
}

fn run(mut cmd: Command) -> Result<Out, String> {
    let o = cmd.output().map_err(|e| format!("git: {e}"))?;
    Ok(Out {
        ok: o.status.success(),
        code: o.status.code(),
        stdout: o.stdout,
        stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
    })
}

fn stdout_line(cmd: Command) -> Option<String> {
    let o = run(cmd).ok()?;
    if !o.ok {
        return None;
    }
    let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

/// Run `cmd` and keep at most `cap` bytes of stdout. Past the cap the child
/// is killed rather than drained: a 50 MB patch should cost 120 KB of reading.
/// Returns the bytes, whether the cap cut them, and whether git succeeded
/// (unknowable once killed, so `true` then).
fn run_capped(mut cmd: Command, cap: usize) -> Result<(Vec<u8>, bool, bool), String> {
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| format!("git: {e}"))?;
    let mut out = Vec::new();
    let mut stdout = child.stdout.take().expect("piped stdout");
    // One byte past the cap tells "exactly cap" from "more than cap".
    let read = (&mut stdout).take(cap as u64 + 1).read_to_end(&mut out);
    drop(stdout);
    // Reaped on every path: a read error must not leave a zombie behind.
    if read.is_err() || out.len() > cap {
        let _ = child.kill();
        let _ = child.wait();
        read.map_err(|e| e.to_string())?;
        return Ok((out, true, true));
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    Ok((out, false, status.success()))
}

enum Head {
    NotARepo,
    Unborn,
    Commit(String),
}

fn resolve_head(cwd: &Path) -> Result<Head, String> {
    let mut cmd = git(cwd);
    cmd.args(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    let o = run(cmd)?;
    if o.ok {
        return Ok(Head::Commit(
            String::from_utf8_lossy(&o.stdout).trim().to_string(),
        ));
    }
    // `--verify --quiet` exits 1, silently, when HEAD names no commit yet;
    // every fatal error — outside a repository among them — is 128.
    match o.code {
        Some(1) => Ok(Head::Unborn),
        Some(128) if o.stderr.contains("not a git repository") => Ok(Head::NotARepo),
        _ => Err(o.stderr.trim().to_string()),
    }
}

/// The empty tree's id, for diffing a repository with no commits. Asked of
/// git so SHA-256 repositories get theirs.
fn empty_tree(cwd: &Path) -> Result<String, String> {
    let mut cmd = git(cwd);
    cmd.args(["hash-object", "-t", "tree", "--stdin"])
        .stdin(Stdio::null());
    stdout_line(cmd).ok_or_else(|| "could not hash the empty tree".to_string())
}

/// The branch a review compares against when the caller names none: the
/// remote's default (`origin/HEAD`), else the first of `origin/main`,
/// `origin/master`, `main`, `master` that exists.
fn default_base(cwd: &Path) -> Option<String> {
    let mut cmd = git(cwd);
    cmd.args([
        "symbolic-ref",
        "--quiet",
        "--short",
        "refs/remotes/origin/HEAD",
    ]);
    if let Some(r) = stdout_line(cmd) {
        return Some(r);
    }
    const CANDIDATES: [&str; 4] = [
        "refs/remotes/origin/main",
        "refs/remotes/origin/master",
        "refs/heads/main",
        "refs/heads/master",
    ];
    let mut cmd = git(cwd);
    cmd.args(["for-each-ref", "--format=%(refname)"])
        .args(CANDIDATES);
    let found = stdout_line(cmd)?;
    let found: Vec<&str> = found.lines().collect();
    CANDIDATES.iter().find(|c| found.contains(c)).map(|c| {
        c.trim_start_matches("refs/remotes/")
            .trim_start_matches("refs/heads/")
            .to_string()
    })
}

fn merge_base(cwd: &Path, base: &str) -> Option<String> {
    let mut cmd = git(cwd);
    cmd.args(["merge-base", "--end-of-options", base, "HEAD"]);
    stdout_line(cmd)
}

// ── Preview ─────────────────────────────────────────────────────────────────

/// One diff against `rev` (to the working tree), before untracked files.
struct Tracked {
    files: Vec<DiffFileStat>,
    patch: Vec<u8>,
    truncated: bool,
}

fn diff_against(cwd: &Path, rev: &str, ignore_ws: bool) -> Result<Tracked, String> {
    let ws: &[&str] = if ignore_ws {
        &["--ignore-all-space"]
    } else {
        &[]
    };
    // The full file list and the capped patch, side by side: neither waits
    // for the other.
    std::thread::scope(|s| {
        let stat = s.spawn(|| {
            let mut cmd = git(cwd);
            cmd.args(DIFF_ARGS)
                .args(ws)
                .args(["--raw", "--numstat", "-z", rev, "--"]);
            run(cmd)
        });
        let patch = s.spawn(|| {
            let mut cmd = git(cwd);
            cmd.args(DIFF_ARGS).args(ws).args(["--patch", rev, "--"]);
            run_capped(cmd, PATCH_CAP)
        });
        let stat = stat
            .join()
            .map_err(|_| "diff stat panicked".to_string())??;
        if !stat.ok {
            return Err(format!("git diff --numstat: {}", stat.stderr.trim()));
        }
        let (patch, truncated, _) = patch.join().map_err(|_| "diff panicked".to_string())??;
        let files = parse_raw_numstat(&stat.stdout);
        let (patch, truncated) = if truncated {
            (cut_at_file_boundary(patch, PATCH_CAP), true)
        } else {
            (patch, false)
        };
        Ok(Tracked {
            files,
            patch,
            truncated,
        })
    })
}

fn status_word(c: u8) -> &'static str {
    match c {
        b'A' => "added",
        b'D' => "deleted",
        b'R' => "renamed",
        b'C' => "copied",
        b'U' => "conflicted",
        _ => "modified",
    }
}

/// Parse `git diff --raw --numstat -z`: every raw record, then every numstat
/// record.
///
/// ```text
/// raw:     :100644 100644 <sha> <sha> M\0path\0
///          :100644 100644 <sha> <sha> R087\0old\0new\0
///          :000000 000000 <sha> <sha> U\0path\0      (unmerged)
/// numstat: 3\t1\tpath\0
///          3\t1\t\0old\0new\0         (rename / copy)
///          -\t-\tpath\0               (binary)
/// ```
///
/// Statuses join the counts by path, not by position: an unmerged path gets
/// a `U` record and, beside it, a content record, so the two lists need not
/// line up. A path listed twice is reported once, `conflicted` winning.
pub fn parse_raw_numstat(out: &[u8]) -> Vec<DiffFileStat> {
    let mut fields = out.split(|b| *b == 0);
    let mut statuses: HashMap<String, u8> = HashMap::new();
    let mut files: Vec<DiffFileStat> = Vec::new();
    let mut seen: HashMap<String, usize> = HashMap::new();
    let text = |b: &[u8]| String::from_utf8_lossy(b).into_owned();
    while let Some(f) = fields.next() {
        if f.is_empty() {
            continue;
        }
        if f[0] == b':' {
            // Status is the last space-separated word; R/C carry two paths,
            // and the second is the one numstat names.
            let status = f
                .rsplit(|b| *b == b' ')
                .next()
                .and_then(|w| w.first().copied())
                .unwrap_or(b'M');
            if matches!(status, b'R' | b'C') {
                fields.next();
            }
            if let Some(p) = fields.next() {
                let e = statuses.entry(text(p)).or_insert(status);
                if status == b'U' {
                    *e = b'U';
                }
            }
            continue;
        }
        let mut cols = f.splitn(3, |b| *b == b'\t');
        let (Some(a), Some(d), Some(rest)) = (cols.next(), cols.next(), cols.next()) else {
            continue;
        };
        let binary = a == b"-" || d == b"-";
        let num = |c: &[u8]| {
            std::str::from_utf8(c)
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(0)
        };
        let (path, old_path) = if rest.is_empty() {
            let old = fields.next().map(text);
            let new = fields.next().map(text).unwrap_or_default();
            (new, old)
        } else {
            (text(rest), None)
        };
        if seen.contains_key(&path) {
            continue;
        }
        seen.insert(path.clone(), files.len());
        files.push(DiffFileStat {
            path,
            old_path,
            additions: Some(num(a)),
            deletions: Some(num(d)),
            status: "modified",
            binary,
            sig: None,
        });
    }
    for f in &mut files {
        f.status = match statuses.get(&f.path) {
            Some(s) => status_word(*s),
            None if f.old_path.is_some() => "renamed",
            None => "modified",
        };
    }
    // An unmerged path with no numstat line of its own still belongs in the list.
    for (path, s) in statuses {
        if s == b'U' && !seen.contains_key(&path) {
            files.push(DiffFileStat {
                path,
                old_path: None,
                additions: Some(0),
                deletions: Some(0),
                status: "conflicted",
                binary: false,
                sig: None,
            });
        }
    }
    files
}

/// Cut an over-cap patch so it ends on a whole file: everything up to the
/// last `diff --git` header that starts within the cap. A first file larger
/// than the cap leaves an empty patch, which the viewer handles as lazy.
pub fn cut_at_file_boundary(mut patch: Vec<u8>, cap: usize) -> Vec<u8> {
    const HEADER: &[u8] = b"\ndiff --git ";
    let window = &patch[..cap.min(patch.len())];
    let cut = window
        .windows(HEADER.len())
        .rposition(|w| w == HEADER)
        .map(|i| i + 1)
        .unwrap_or(0);
    patch.truncate(cut);
    patch
}

/// The repository's untracked, non-ignored files under `cwd`, relative to it.
///
/// An embedded repository (a nested clone, an unregistered submodule) comes
/// back as `sub/`: a directory, not a file anyone can diff, so it is dropped.
fn untracked(cwd: &Path) -> Result<Vec<String>, String> {
    let mut cmd = git(cwd);
    cmd.args(["ls-files", "--others", "--exclude-standard", "-z", "--"]);
    let o = run(cmd)?;
    if !o.ok {
        return Err(format!("git ls-files: {}", o.stderr.trim()));
    }
    Ok(o.stdout
        .split(|b| *b == 0)
        .filter(|f| !f.is_empty() && !f.ends_with(b"/"))
        .map(|f| String::from_utf8_lossy(f).into_owned())
        .collect())
}

/// Every unmerged path, relative to `cwd`: the files a merge or rebase left
/// in conflict.
fn unmerged(cwd: &Path) -> Vec<String> {
    let mut cmd = git(cwd);
    cmd.args(["diff", "--relative", "--name-only", "--diff-filter=U", "-z"]);
    match run(cmd) {
        Ok(o) if o.ok => o
            .stdout
            .split(|b| *b == 0)
            .filter(|f| !f.is_empty())
            .map(|f| String::from_utf8_lossy(f).into_owned())
            .collect(),
        _ => Vec::new(),
    }
}

/// What became of an untracked file's patch.
enum NewPatch {
    Ready(Vec<u8>),
    /// Larger than the room left: the source is truncated from here on.
    TooBig,
    /// Counted but not rendered (counts unknown, or past the count limit).
    /// Truncates the source too, so the viewer loads it on its own.
    Skipped,
}

/// An untracked file, read once: its stat row and, when it fits, its patch.
struct NewFile {
    stat: DiffFileStat,
    patch: NewPatch,
}

/// Git's C-style quoting of a path in a patch header: a name holding `"`,
/// `\` or a control character is wrapped in quotes and escaped, so the
/// parser can find where it ends. Anything else goes out as is (non-ASCII
/// included, as with `core.quotePath=false`).
pub fn quote_path(prefix: &str, path: &str) -> String {
    let needs = path
        .bytes()
        .any(|b| b < 0x20 || b == b'"' || b == b'\\' || b == 0x7f);
    if !needs {
        return format!("{prefix}{path}");
    }
    let mut s = String::with_capacity(path.len() + prefix.len() + 4);
    s.push('"');
    s.push_str(prefix);
    for c in path.chars() {
        match c {
            '"' => s.push_str("\\\""),
            '\\' => s.push_str("\\\\"),
            '\t' => s.push_str("\\t"),
            '\n' => s.push_str("\\n"),
            '\r' => s.push_str("\\r"),
            '\x07' => s.push_str("\\a"),
            '\x08' => s.push_str("\\b"),
            '\x0b' => s.push_str("\\v"),
            '\x0c' => s.push_str("\\f"),
            c if (c as u32) < 0x20 || c as u32 == 0x7f => {
                s.push_str(&format!("\\{:03o}", c as u32));
            }
            c => s.push(c),
        }
    }
    s.push('"');
    s
}

/// Count and (budget permitting) render one untracked file as all-added.
/// `None` when it is not a file or link (a directory) or vanished since
/// `ls-files` listed it: nothing to show, and nothing to charge the budget.
fn new_file(cwd: &Path, rel: &str, budget: usize, count: bool) -> Option<NewFile> {
    let mut stat = DiffFileStat {
        path: rel.to_string(),
        old_path: None,
        additions: None,
        deletions: Some(0),
        status: "untracked",
        binary: false,
        sig: None,
    };
    let abs = cwd.join(rel);
    let meta = std::fs::symlink_metadata(&abs).ok()?;
    let ft = meta.file_type();
    if !ft.is_file() && !ft.is_symlink() {
        return None;
    }
    if !count {
        stat.deletions = None;
        return Some(NewFile {
            stat,
            patch: NewPatch::Skipped,
        });
    }
    let (bytes, mode) = if ft.is_symlink() {
        let t = std::fs::read_link(&abs).ok()?;
        (t.to_string_lossy().into_owned().into_bytes(), "120000")
    } else if meta.len() > COUNT_CAP {
        // Unknown counts beat reading a 2 GB file on every refresh.
        stat.deletions = None;
        return Some(NewFile {
            stat,
            patch: NewPatch::Skipped,
        });
    } else if meta.len() as usize > budget {
        // Too big to patch anyway: count it without holding it in memory.
        let (lines, binary) = count_streaming(&abs)?;
        stat.additions = Some(if binary { 0 } else { lines });
        stat.binary = binary;
        return Some(NewFile {
            stat,
            patch: NewPatch::TooBig,
        });
    } else {
        let b = std::fs::read(&abs).ok()?;
        #[cfg(unix)]
        let mode = {
            use std::os::unix::fs::PermissionsExt;
            if meta.permissions().mode() & 0o111 != 0 {
                "100755"
            } else {
                "100644"
            }
        };
        #[cfg(not(unix))]
        let mode = "100644";
        (b, mode)
    };

    let a_path = quote_path("a/", rel);
    let b_path = quote_path("b/", rel);
    let mut patch = format!("diff --git {a_path} {b_path}\nnew file mode {mode}\n").into_bytes();

    if bytes[..bytes.len().min(BINARY_SNIFF)].contains(&0) {
        stat.binary = true;
        stat.additions = Some(0);
        patch.extend_from_slice(format!("Binary files /dev/null and {b_path} differ\n").as_bytes());
    } else {
        let lines = bytes.split_inclusive(|b| *b == b'\n').count();
        stat.additions = Some(lines as u32);
        if lines > 0 {
            let range = if lines == 1 {
                "1".to_string()
            } else {
                format!("1,{lines}")
            };
            patch.extend_from_slice(
                format!("--- /dev/null\n+++ {b_path}\n@@ -0,0 +{range} @@\n").as_bytes(),
            );
            // The '+' prefixes add one byte per line.
            if patch.len() + bytes.len() + lines + 32 > budget {
                return Some(NewFile {
                    stat,
                    patch: NewPatch::TooBig,
                });
            }
            for line in bytes.split_inclusive(|b| *b == b'\n') {
                patch.push(b'+');
                patch.extend_from_slice(line);
            }
            if bytes.last() != Some(&b'\n') {
                patch.extend_from_slice(b"\n\\ No newline at end of file\n");
            }
        }
    }
    let patch = if patch.len() <= budget {
        NewPatch::Ready(patch)
    } else {
        NewPatch::TooBig
    };
    Some(NewFile { stat, patch })
}

/// Line count and binary sniff for a file, read in chunks.
fn count_streaming(path: &Path) -> Option<(u32, bool)> {
    let mut f = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; 64 * 1024];
    let (mut lines, mut seen, mut last) = (0u32, 0usize, b'\n');
    loop {
        let n = f.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        let chunk = &buf[..n];
        if seen < BINARY_SNIFF && chunk[..n.min(BINARY_SNIFF - seen)].contains(&0) {
            return Some((0, true));
        }
        seen += n;
        lines += chunk.iter().filter(|b| **b == b'\n').count() as u32;
        last = chunk[n - 1];
    }
    Some((lines + u32::from(last != b'\n'), false))
}

/// Append untracked files to a source: every stat row, and patches until the
/// first one that does not fit (keeping the patch a prefix of whole files).
/// Marks unmerged paths `conflicted`.
fn assemble(
    cwd: &Path,
    kind: SourceKind,
    base_ref: Option<String>,
    merge_base: Option<String>,
    tracked: Tracked,
    news: &[NewFile],
    conflicted: &[String],
) -> DiffSource {
    let Tracked {
        mut files,
        mut patch,
        mut truncated,
    } = tracked;
    for f in &mut files {
        if conflicted.contains(&f.path) {
            f.status = "conflicted";
        }
    }
    // Once the patch is full nothing more goes in. A skipped file leaves a
    // gap (so `truncated`) but does not close it.
    let mut full = truncated;
    for n in news {
        files.push(n.stat.clone());
        if full {
            continue;
        }
        match &n.patch {
            NewPatch::Ready(p) if patch.len() + p.len() <= PATCH_CAP => patch.extend_from_slice(p),
            NewPatch::Skipped => truncated = true,
            _ => {
                truncated = true;
                full = true;
            }
        }
    }
    for f in &mut files {
        f.sig = worktree_sig(cwd, &f.path);
    }
    let diff = String::from_utf8_lossy(&patch).into_owned();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    diff.hash(&mut h);
    files.hash(&mut h);
    DiffSource {
        kind,
        base_ref,
        merge_base,
        diff,
        diff_hash: format!("{:016x}", h.finish()),
        truncated,
        files,
    }
}

pub fn compute_preview(
    cwd: &Path,
    base_ref: Option<&str>,
    ignore_ws: bool,
) -> Result<DiffPreview, String> {
    let head = match resolve_head(cwd)? {
        Head::NotARepo => return Ok(DiffPreview::default()),
        Head::Unborn => None,
        Head::Commit(sha) => Some(sha),
    };
    let head_rev = match &head {
        Some(sha) => sha.clone(),
        None => empty_tree(cwd)?,
    };

    // The base, its merge base, the untracked and unmerged lists and the
    // working-tree diff are independent; run them together.
    let (range, working, untracked_paths, conflicted) = std::thread::scope(|s| {
        let range = s.spawn(|| {
            head.as_ref()?;
            let base = base_ref.map(str::to_string).or_else(|| default_base(cwd))?;
            let mb = merge_base(cwd, &base)?;
            Some((base, mb))
        });
        let working = s.spawn(|| diff_against(cwd, &head_rev, ignore_ws));
        let untracked_paths = s.spawn(|| untracked(cwd));
        let conflicted = s.spawn(|| unmerged(cwd));
        (
            range.join().ok().flatten(),
            working.join(),
            untracked_paths.join(),
            conflicted.join().unwrap_or_default(),
        )
    });
    let working = working.map_err(|_| "diff panicked".to_string())??;
    let untracked_paths = untracked_paths.map_err(|_| "ls-files panicked".to_string())??;

    // A merge base equal to HEAD (on the base branch, or no commits of its
    // own) makes the range the working tree: compute it once.
    let range_tracked = match &range {
        Some((_, mb)) if Some(mb) != head.as_ref() => Some(diff_against(cwd, mb, ignore_ws)?),
        _ => None,
    };

    // Room left after the smaller tracked patch: no untracked patch larger
    // than this can land in either source, so none is built.
    let tracked_len = working
        .patch
        .len()
        .min(range_tracked.as_ref().map_or(usize::MAX, |t| t.patch.len()));
    let mut budget = PATCH_CAP.saturating_sub(tracked_len);
    let news: Vec<NewFile> = untracked_paths
        .iter()
        .enumerate()
        .filter_map(|(i, p)| {
            let n = new_file(cwd, p, budget, i < UNTRACKED_COUNT_MAX)?;
            // Only a patch that was built spends the budget; one that did not
            // fit closes it, since nothing after it may be shown either.
            match &n.patch {
                NewPatch::Ready(p) => budget = budget.saturating_sub(p.len()),
                NewPatch::TooBig => budget = 0,
                NewPatch::Skipped => {}
            }
            Some(n)
        })
        .collect();

    let range_tracked = match range_tracked {
        Some(t) => t,
        None => Tracked {
            files: working.files.clone(),
            patch: working.patch.clone(),
            truncated: working.truncated,
        },
    };
    let (base, mb) = match range {
        Some((b, m)) => (Some(b), Some(m)),
        None => (None, None),
    };
    Ok(DiffPreview {
        sources: vec![
            assemble(
                cwd,
                SourceKind::WorkingTree,
                None,
                None,
                working,
                &news,
                &conflicted,
            ),
            assemble(
                cwd,
                SourceKind::BranchRange,
                base,
                mb,
                range_tracked,
                &news,
                &conflicted,
            ),
        ],
    })
}

// ── File contents ───────────────────────────────────────────────────────────

fn safe_relative(rel: &str) -> Result<&Path, String> {
    let p = Path::new(rel);
    if rel.is_empty()
        || !p
            .components()
            .all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return Err(format!("Path must be inside the project: {rel}"));
    }
    Ok(p)
}

/// Cut `bytes` to `cap` at the last line break inside it.
fn cap_text(mut bytes: Vec<u8>, cap: usize) -> (String, bool) {
    if bytes.len() <= cap {
        return (String::from_utf8_lossy(&bytes).into_owned(), false);
    }
    let cut = bytes[..cap]
        .iter()
        .rposition(|b| *b == b'\n')
        .map_or(cap, |i| i + 1);
    bytes.truncate(cut);
    (String::from_utf8_lossy(&bytes).into_owned(), true)
}

fn is_binary(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(BINARY_SNIFF)].contains(&0)
}

/// Read the working-tree file, refusing anything that resolves (through a
/// link) outside the project. A missing file is an empty side.
fn read_worktree(cwd: &Path, rel: &Path) -> Result<Vec<u8>, String> {
    let target = cwd.join(rel);
    // `symlink_metadata`, not `metadata`: a symlink is diffed as the path it
    // points at (mode 120000), the way git and `new_file` present it, never as
    // the file behind it. Following it showed a link's target file against
    // the old side's link text, and a dangling link as a deletion.
    let Ok(meta) = std::fs::symlink_metadata(&target) else {
        return Ok(Vec::new());
    };
    let real_root = std::fs::canonicalize(cwd).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() {
        // The link itself must sit inside the project, wherever it points.
        if let Some(parent) = target.parent() {
            let real_parent = std::fs::canonicalize(parent).map_err(|e| e.to_string())?;
            if !real_parent.starts_with(&real_root) {
                return Err(format!("{} resolves outside the project", rel.display()));
            }
        }
        let link = std::fs::read_link(&target).map_err(|e| e.to_string())?;
        return Ok(link.into_os_string().into_encoded_bytes());
    }
    if !meta.is_file() {
        return Ok(Vec::new());
    }
    let real = std::fs::canonicalize(&target).map_err(|e| e.to_string())?;
    if !real.starts_with(&real_root) {
        return Err(format!("{} resolves outside the project", rel.display()));
    }
    let mut out = Vec::new();
    std::fs::File::open(&real)
        .map_err(|e| e.to_string())?
        .take(FILE_CAP as u64 + 1)
        .read_to_end(&mut out)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

pub fn file_contents(
    cwd: &Path,
    kind: SourceKind,
    base_ref: Option<&str>,
    file_path: &str,
    old_path: Option<&str>,
) -> Result<DiffFileContents, String> {
    let new_rel = safe_relative(file_path)?;
    let old_rel = safe_relative(old_path.unwrap_or(file_path))?;

    let old_rev: Option<String> = match kind {
        SourceKind::WorkingTree => Some("HEAD".to_string()),
        SourceKind::BranchRange => {
            let base = base_ref.map(str::to_string).or_else(|| default_base(cwd));
            // No base (or no common history): the range is the working
            // tree, as `git_diff_preview` reports it.
            base.and_then(|b| merge_base(cwd, &b))
                .or_else(|| Some("HEAD".to_string()))
        }
    };

    let (old, new) = std::thread::scope(|s| {
        let old = s.spawn(|| -> Result<Vec<u8>, String> {
            let Some(rev) = old_rev else {
                return Ok(Vec::new());
            };
            // `<rev>:./<path>` resolves against the cwd, so the path stays
            // relative to the project like everything else here.
            let spec = format!("{rev}:./{}", old_rel.to_string_lossy());
            let mut cmd = git(cwd);
            cmd.args(["cat-file", "blob", &spec]);
            let (bytes, _, ok) = run_capped(cmd, FILE_CAP)?;
            // Absent at that revision (an added file, an unborn HEAD).
            Ok(if ok { bytes } else { Vec::new() })
        });
        let new = read_worktree(cwd, new_rel);
        (old.join(), new)
    });
    let old = old.map_err(|_| "cat-file panicked".to_string())??;
    let new = new?;

    if is_binary(&old) || is_binary(&new) {
        return Ok(DiffFileContents {
            binary: true,
            ..Default::default()
        });
    }
    let (old_text, old_cut) = cap_text(old, FILE_CAP);
    let (new_text, new_cut) = cap_text(new, FILE_CAP);
    Ok(DiffFileContents {
        old_text,
        new_text,
        truncated: old_cut || new_cut,
        binary: false,
    })
}

// ── One file's patch ────────────────────────────────────────────────────────

/// Patch bytes for one file. Past this the patch is cut at a hunk boundary:
/// the reader sees the first hunks whole and is told the rest is missing.
pub const FILE_PATCH_CAP: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiffFilePatch {
    /// A unified patch of this one file, or empty when there is nothing to
    /// show (binary, or too large for even one hunk).
    pub patch: String,
    /// Over [`FILE_PATCH_CAP`]: `patch` holds only the hunks that fit.
    pub truncated: bool,
    pub binary: bool,
}

/// The working-tree file's modification time and size, and on unix its
/// inode and status-change time: a cheap stand-in for its content that
/// changes on every write. The ctime catches what mtime alone misses: a
/// same-size rewrite that restores the mtime (`touch -r`, an archive
/// extract), or a file replaced by rename.
fn worktree_sig(cwd: &Path, rel: &str) -> Option<String> {
    let meta = std::fs::symlink_metadata(cwd.join(rel)).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some(format!(
            "{mtime:x}-{:x}-{:x}-{:x}.{:x}",
            meta.len(),
            meta.ino(),
            meta.ctime(),
            meta.ctime_nsec()
        ))
    }
    #[cfg(not(unix))]
    Some(format!("{mtime:x}-{:x}", meta.len()))
}

/// Cut a one-file patch at the last hunk that starts within `cap`. `None`
/// when not even the first hunk fits.
fn cut_at_hunk_boundary(mut patch: Vec<u8>, cap: usize) -> Option<Vec<u8>> {
    const HUNK: &[u8] = b"\n@@ ";
    let window = &patch[..cap.min(patch.len())];
    let starts: Vec<usize> = window
        .windows(HUNK.len())
        .enumerate()
        .filter(|(_, w)| *w == HUNK)
        .map(|(i, _)| i + 1)
        .collect();
    // The last hunk starting inside the window may run past it; keep only
    // the hunks before it, which end where it starts.
    if starts.len() < 2 {
        return None;
    }
    patch.truncate(starts[starts.len() - 1]);
    Some(patch)
}

fn is_binary_patch(patch: &[u8]) -> bool {
    patch.starts_with(b"Binary files ")
        || patch.windows(14).any(|w| w == b"\nBinary files ")
        || patch.windows(17).any(|w| w == b"GIT binary patch\n")
}

/// The patch of one file of a review source, computed by git: what the review
/// panel renders for a file the capped preview left out. Whitespace-only
/// changes are dropped with `ignore_ws`, as in the preview.
pub fn file_patch(
    cwd: &Path,
    kind: SourceKind,
    base_ref: Option<&str>,
    file_path: &str,
    old_path: Option<&str>,
    ignore_ws: bool,
) -> Result<DiffFilePatch, String> {
    let new_rel = safe_relative(file_path)?;
    let old_rel = safe_relative(old_path.unwrap_or(file_path))?;
    let rev = match kind {
        SourceKind::WorkingTree => match resolve_head(cwd)? {
            Head::Commit(sha) => sha,
            Head::NotARepo => return Err("Not a git repository".to_string()),
            Head::Unborn => empty_tree(cwd)?,
        },
        SourceKind::BranchRange => base_ref
            .map(str::to_string)
            .or_else(|| default_base(cwd))
            .and_then(|b| merge_base(cwd, &b))
            // No base, or no common history: the range is the working tree,
            // as `git_diff_preview` reports it.
            .unwrap_or_else(|| "HEAD".to_string()),
    };
    let ws: &[&str] = if ignore_ws {
        &["--ignore-all-space"]
    } else {
        &[]
    };
    let diff = || {
        let mut cmd = git(cwd);
        cmd.args(DIFF_ARGS).args(ws).args(["--patch", &rev, "--"]);
        if old_rel != new_rel {
            cmd.arg(old_rel);
        }
        cmd.arg(new_rel);
        cmd
    };
    let (mut patch, mut truncated, ok) = run_capped(diff(), FILE_PATCH_CAP)?;

    if !ok && patch.is_empty() {
        // Git refused (a base that no longer resolves, say), which is not
        // "no change". The capped run drops stderr; the rerun is as cheap,
        // since git failed before diffing anything.
        let out = run(diff())?;
        let why = out.stderr.trim();
        return Err(if why.is_empty() {
            "git diff failed".to_string()
        } else {
            format!("git diff: {why}")
        });
    }
    if patch.is_empty() {
        // Either unchanged now, or not in git's view at all: an untracked
        // file, which is all added.
        let mut ls = git(cwd);
        ls.args(["ls-files", "--others", "--exclude-standard", "--"])
            .arg(new_rel);
        if !run(ls).is_ok_and(|o| !o.stdout.is_empty()) {
            return Ok(DiffFilePatch::default());
        }
        match new_file(cwd, file_path, FILE_PATCH_CAP, true) {
            Some(NewFile {
                stat,
                patch: NewPatch::Ready(p),
            }) => {
                if stat.binary {
                    return Ok(DiffFilePatch {
                        binary: true,
                        ..Default::default()
                    });
                }
                patch = p;
            }
            Some(NewFile { stat, .. }) => {
                return Ok(DiffFilePatch {
                    binary: stat.binary,
                    truncated: !stat.binary,
                    ..Default::default()
                });
            }
            None => return Ok(DiffFilePatch::default()),
        }
    }
    if is_binary_patch(&patch) {
        return Ok(DiffFilePatch {
            binary: true,
            ..Default::default()
        });
    }
    if truncated {
        match cut_at_hunk_boundary(patch, FILE_PATCH_CAP) {
            Some(cut) => patch = cut,
            None => {
                return Ok(DiffFilePatch {
                    truncated: true,
                    ..Default::default()
                })
            }
        }
    }
    // A cut that lands exactly on the end is not a cut.
    truncated &= !patch.is_empty();
    Ok(DiffFilePatch {
        patch: String::from_utf8_lossy(&patch).into_owned(),
        truncated,
        binary: false,
    })
}

/// A unified patch between two texts, with no repository involved, for a
/// change known only as the before/after an agent's tool call carried (a
/// session turn's edit, which the working tree may no longer show).
///
/// Git diffs the two through temp files named after the file, so the patch
/// headers carry its name; the caller re-labels the path.
pub fn texts_patch(
    old_text: &str,
    new_text: &str,
    file: &str,
    ignore_ws: bool,
) -> Result<DiffFilePatch, String> {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    if old_text.len() > FILE_CAP || new_text.len() > FILE_CAP {
        return Ok(DiffFilePatch {
            truncated: true,
            ..Default::default()
        });
    }
    let name = Path::new(file)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "file".to_string());
    // Unique per call: a turn's files diff concurrently.
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let base =
        std::env::temp_dir().join(format!("atlas-diff-{}-{stamp:x}-{n}", std::process::id()));
    let result = (|| {
        fs::create_dir_all(base.join("a")).map_err(|e| e.to_string())?;
        fs::create_dir_all(base.join("b")).map_err(|e| e.to_string())?;
        fs::write(base.join("a").join(&name), old_text).map_err(|e| e.to_string())?;
        fs::write(base.join("b").join(&name), new_text).map_err(|e| e.to_string())?;
        if is_binary(old_text.as_bytes()) || is_binary(new_text.as_bytes()) {
            return Ok(DiffFilePatch {
                binary: true,
                ..Default::default()
            });
        }
        let a = format!("a/{name}");
        let b = format!("b/{name}");
        // `--no-prefix`: the relative paths already carry `a/` and `b/`.
        // `--no-index` exits 1 when the texts differ, the normal case, so
        // the status is ignored.
        let mut cmd = atlas_process::command("git");
        cmd.args([
            "diff",
            "--no-index",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--no-prefix",
        ])
        .args(if ignore_ws {
            &["--ignore-all-space"][..]
        } else {
            &[]
        })
        .args(["--", &a, &b])
        .env("LC_ALL", "C")
        .current_dir(&base);
        let out = run(cmd)?;
        if out.code.is_some_and(|c| c > 1) {
            return Err(format!("git diff --no-index: {}", out.stderr.trim()));
        }
        Ok(DiffFilePatch {
            patch: String::from_utf8_lossy(&out.stdout).into_owned(),
            truncated: false,
            binary: false,
        })
    })();
    // Best effort: a leftover temp dir is harmless, a failed diff is not.
    let _ = fs::remove_dir_all(&base);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Repo(PathBuf);
    impl Repo {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!(
                "atlas-diff-preview-{tag}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(&p).unwrap();
            let r = Self(p);
            r.git(&["init", "-q", "-b", "main"]);
            r.git(&["config", "user.email", "t@example.com"]);
            r.git(&["config", "user.name", "t"]);
            r.git(&["config", "commit.gpgsign", "false"]);
            r
        }
        fn git(&self, args: &[&str]) {
            let o = atlas_process::command("git")
                .args(args)
                .current_dir(&self.0)
                .output()
                .unwrap();
            assert!(
                o.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&o.stderr)
            );
        }
        fn write(&self, rel: &str, body: &str) {
            let p = self.0.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
        }
        fn commit(&self, msg: &str) {
            self.git(&["add", "-A"]);
            self.git(&["commit", "-q", "-m", msg]);
        }
        fn working(&self) -> DiffSource {
            compute_preview(&self.0, None, false)
                .unwrap()
                .sources
                .into_iter()
                .find(|s| s.kind == SourceKind::WorkingTree)
                .unwrap()
        }
    }
    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn parses_a_rename_in_numstat() {
        let raw = b":100644 100644 aaa bbb R087\0old/name.ts\0new/name.ts\0:100644 100644 ccc ddd M\0x.rs\0:000000 100644 000 eee A\0img.png\0\
2\t1\t\0old/name.ts\0new/name.ts\0\
4\t0\tx.rs\0\
-\t-\timg.png\0";
        let files = parse_raw_numstat(raw);
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].path, "new/name.ts");
        assert_eq!(files[0].old_path.as_deref(), Some("old/name.ts"));
        assert_eq!((files[0].additions, files[0].deletions), (Some(2), Some(1)));
        assert_eq!(files[0].status, "renamed");
        assert_eq!(files[1].status, "modified");
        assert_eq!(files[1].additions, Some(4));
        assert_eq!(files[2].status, "added");
        assert!(files[2].binary);
    }

    #[test]
    fn a_real_rename_comes_back_with_its_old_path() {
        let r = Repo::new("rename");
        let body: String = (0..40).map(|i| format!("line {i}\n")).collect();
        r.write("src/a.ts", &body);
        r.commit("init");
        r.git(&["mv", "src/a.ts", "src/b.ts"]);
        r.write("src/b.ts", &format!("{body}line 40\n"));
        let w = r.working();
        let f = w.files.iter().find(|f| f.path == "src/b.ts").unwrap();
        assert_eq!(f.old_path.as_deref(), Some("src/a.ts"));
        assert_eq!(f.status, "renamed");
        assert_eq!((f.additions, f.deletions), (Some(1), Some(0)));
        assert!(w.diff.contains("rename from src/a.ts"));
        assert!(!w.truncated);
    }

    #[test]
    fn untracked_files_are_listed_and_patched_as_added() {
        let r = Repo::new("untracked");
        r.write("a.txt", "a\n");
        r.commit("init");
        r.write("new.txt", "one\ntwo");
        r.write(".gitignore", "ignored.txt\n");
        r.write("ignored.txt", "x\n");
        let w = r.working();
        let f = w.files.iter().find(|f| f.path == "new.txt").unwrap();
        assert_eq!(f.status, "untracked");
        assert_eq!(f.additions, Some(2));
        assert!(w.files.iter().all(|f| f.path != "ignored.txt"));
        assert!(w
            .diff
            .contains("+++ b/new.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n\\ No newline"));
    }

    #[test]
    fn an_oversized_patch_is_cut_at_a_file_boundary_with_every_file_listed() {
        let r = Repo::new("truncate");
        // 40 files × ~4 KB of changed lines ≈ 160 KB of patch: over the cap.
        for i in 0..40 {
            r.write(&format!("f{i:02}.txt"), "seed\n");
        }
        r.commit("init");
        let big: String = (0..100)
            .map(|i| format!("changed line {i} {}\n", "x".repeat(24)))
            .collect();
        for i in 0..40 {
            r.write(&format!("f{i:02}.txt"), &big);
        }
        let w = r.working();
        assert!(w.truncated);
        assert_eq!(w.files.len(), 40, "the file list is complete");
        assert!(w.diff.len() <= PATCH_CAP);
        assert!(w.diff.starts_with("diff --git "));
        // Ends on a whole file: the last hunk's final line is complete.
        assert!(w.diff.ends_with('\n'));
        let shown = w.diff.matches("diff --git ").count();
        assert!(shown > 0 && shown < 40);
        // And the lazy path still answers for a file the patch left out.
        let c = file_contents(&r.0, SourceKind::WorkingTree, None, "f39.txt", None).unwrap();
        assert_eq!(c.old_text, "seed\n");
        assert_eq!(c.new_text, big);
    }

    #[test]
    fn branch_range_reaches_back_to_the_merge_base() {
        let r = Repo::new("range");
        r.write("a.txt", "a\n");
        r.commit("init");
        r.git(&["checkout", "-q", "-b", "feature"]);
        r.write("b.txt", "b\n");
        r.commit("feature work");
        r.write("a.txt", "a2\n");
        let p = compute_preview(&r.0, None, false).unwrap();
        let range = p
            .sources
            .iter()
            .find(|s| s.kind == SourceKind::BranchRange)
            .unwrap();
        assert_eq!(range.base_ref.as_deref(), Some("main"));
        let paths: Vec<_> = range.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["a.txt", "b.txt"]);
        let working = p
            .sources
            .iter()
            .find(|s| s.kind == SourceKind::WorkingTree)
            .unwrap();
        assert_eq!(working.files.len(), 1);

        let mb = range.merge_base.as_deref();
        let c = file_contents(&r.0, SourceKind::BranchRange, mb, "b.txt", None).unwrap();
        assert_eq!((c.old_text.as_str(), c.new_text.as_str()), ("", "b\n"));
    }

    #[test]
    fn an_embedded_repository_does_not_cost_the_other_untracked_patches() {
        let r = Repo::new("nested");
        r.write("a.txt", "a\n");
        r.commit("init");
        // `ls-files --others` reports this as `aaa-nested/`, sorted first.
        let nested = Repo(r.0.join("aaa-nested"));
        std::fs::create_dir_all(&nested.0).unwrap();
        nested.git(&["init", "-q"]);
        nested.write("inner.txt", "inner\n");
        r.write("zz-new.txt", "z\n");
        let w = r.working();
        assert!(w.files.iter().all(|f| !f.path.starts_with("aaa-nested")));
        assert!(!w.truncated, "{w:?}");
        assert!(w.diff.contains("+++ b/zz-new.txt\n@@ -0,0 +1 @@\n+z\n"));
    }

    #[test]
    fn a_huge_untracked_file_is_listed_with_unknown_counts() {
        let r = Repo::new("huge");
        r.write("a.txt", "a\n");
        r.commit("init");
        let line = "x".repeat(99) + "\n";
        r.write("big.log", &line.repeat((COUNT_CAP as usize / 100) + 10));
        r.write("small.txt", "s\n");
        let w = r.working();
        let big = w.files.iter().find(|f| f.path == "big.log").unwrap();
        assert_eq!((big.additions, big.deletions), (None, None));
        assert!(w.truncated);
        // A gap, not a stop: the file after it still has its patch.
        assert!(w.diff.contains("+++ b/small.txt"));
    }

    #[test]
    fn unmerged_paths_are_conflicted() {
        let r = Repo::new("conflict");
        r.write("c.txt", "base\n");
        r.commit("init");
        r.git(&["checkout", "-q", "-b", "other"]);
        r.write("c.txt", "theirs\n");
        r.commit("theirs");
        r.git(&["checkout", "-q", "main"]);
        r.write("c.txt", "ours\n");
        r.commit("ours");
        let o = atlas_process::command("git")
            .args(["merge", "-q", "other"])
            .current_dir(&r.0)
            .output()
            .unwrap();
        assert!(!o.status.success(), "the merge should conflict");
        let w = r.working();
        let c: Vec<_> = w.files.iter().filter(|f| f.path == "c.txt").collect();
        assert_eq!(c.len(), 1, "{:?}", w.files);
        assert_eq!(c[0].status, "conflicted");
    }

    #[test]
    fn header_paths_are_quoted_like_git() {
        assert_eq!(quote_path("b/", "plain name.ts"), "b/plain name.ts");
        assert_eq!(quote_path("b/", "naïve.ts"), "b/naïve.ts");
        assert_eq!(quote_path("b/", "a\"b\\c\td"), "\"b/a\\\"b\\\\c\\td\"");
    }

    #[tokio::test]
    async fn a_call_made_mid_run_gets_a_fresh_result() {
        let r = Repo::new("coalesce");
        r.write("a.txt", "a\n");
        r.commit("init");
        let path = r.0.to_string_lossy().into_owned();
        let first = tokio::spawn(git_diff_preview(path.clone(), None, None));
        // Let the first run start, then write and ask again.
        tokio::task::yield_now().await;
        r.write("a.txt", "changed\n");
        let second = git_diff_preview(path.clone(), None, None).await.unwrap();
        let _ = first.await.unwrap();
        let w = &second.sources[0];
        assert_eq!(w.files.len(), 1, "the write is in the second answer");
        assert!(slots().lock().unwrap().is_empty(), "the slot is gone");
    }

    #[test]
    fn outside_a_repository_there_are_no_sources() {
        let p =
            std::env::temp_dir().join(format!("atlas-diff-preview-norepo-{}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        assert!(compute_preview(&p, None, false).unwrap().sources.is_empty());
        let _ = std::fs::remove_dir_all(&p);
    }

    #[test]
    fn file_contents_flags_binary_and_refuses_escapes() {
        let r = Repo::new("contents");
        std::fs::write(r.0.join("bin.dat"), [0u8, 1, 2, 3]).unwrap();
        r.commit("init");
        let c = file_contents(&r.0, SourceKind::WorkingTree, None, "bin.dat", None).unwrap();
        assert!(c.binary);
        assert!(file_contents(&r.0, SourceKind::WorkingTree, None, "../x", None).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn file_contents_diffs_a_symlink_as_its_target_path() {
        let r = Repo::new("symlink");
        r.write("real.txt", "body\n");
        std::os::unix::fs::symlink("real.txt", r.0.join("link")).unwrap();
        r.commit("init");
        std::fs::remove_file(r.0.join("link")).unwrap();
        // Retargeted, and dangling: the link text is what changed.
        std::os::unix::fs::symlink("gone.txt", r.0.join("link")).unwrap();
        let c = file_contents(&r.0, SourceKind::WorkingTree, None, "link", None).unwrap();
        assert_eq!(c.old_text, "real.txt");
        assert_eq!(c.new_text, "gone.txt");
    }

    #[test]
    fn file_patch_covers_tracked_untracked_whitespace_and_clean_files() {
        let r = Repo::new("file-patch");
        r.write("a.ts", "const a = 1;\nconst b = 2;\n");
        r.write("clean.ts", "x\n");
        r.commit("init");
        r.write("a.ts", "const a = 1;\nconst  b = 2;\nconst c = 3;\n");
        r.write("new.ts", "fresh\n");

        let tracked = file_patch(&r.0, SourceKind::WorkingTree, None, "a.ts", None, false).unwrap();
        assert!(tracked.patch.contains("+const  b = 2;"));
        assert!(tracked.patch.contains("+++ b/a.ts"));
        assert!(!tracked.truncated && !tracked.binary);

        let ws = file_patch(&r.0, SourceKind::WorkingTree, None, "a.ts", None, true).unwrap();
        assert!(
            !ws.patch.contains("+const  b"),
            "whitespace-only lines drop out"
        );
        assert!(ws.patch.contains("+const c = 3;"));

        let added = file_patch(&r.0, SourceKind::WorkingTree, None, "new.ts", None, false).unwrap();
        assert!(added.patch.contains("new file mode"));
        assert!(added.patch.contains("+fresh"));

        let clean =
            file_patch(&r.0, SourceKind::WorkingTree, None, "clean.ts", None, false).unwrap();
        assert_eq!(
            clean,
            DiffFilePatch::default(),
            "a clean file is not all-added"
        );

        assert!(file_patch(&r.0, SourceKind::WorkingTree, None, "../x", None, false).is_err());
    }

    #[test]
    fn an_oversized_file_patch_is_cut_at_a_hunk_boundary() {
        let hunk = |n: usize| {
            format!(
                "@@ -{n},1 +{n},1 @@\n-{}\n+{}\n",
                "o".repeat(40),
                "n".repeat(40)
            )
        };
        let mut patch = b"diff --git a/f b/f\n--- a/f\n+++ b/f\n".to_vec();
        for i in 0..10 {
            patch.extend_from_slice(hunk(i * 10 + 1).as_bytes());
        }
        let cut = cut_at_hunk_boundary(patch.clone(), 300).unwrap();
        let text = String::from_utf8(cut).unwrap();
        assert!(text.ends_with('\n'));
        assert!(text.matches("@@ -").count() >= 1);
        assert!(text.len() <= 300);
        assert!(
            cut_at_hunk_boundary(patch, 60).is_none(),
            "not even one whole hunk"
        );
    }

    #[test]
    fn texts_patch_diffs_two_strings_under_the_file_name() {
        let p = texts_patch("a\nb\n", "a\nc\n", "src/x.ts", false).unwrap();
        assert!(p.patch.contains("--- a/x.ts"), "{}", p.patch);
        assert!(p.patch.contains("+++ b/x.ts"));
        assert!(p.patch.contains("-b\n+c\n"));
        let same = texts_patch("a  b\n", "a b\n", "x.ts", true).unwrap();
        assert!(same.patch.is_empty(), "whitespace-only change is no change");
    }

    #[test]
    fn a_file_patch_git_refuses_is_an_error_not_an_empty_diff() {
        // No commit yet: the branch range falls back to HEAD, which does
        // not resolve, so git exits non-zero with nothing on stdout.
        let r = Repo::new("file-patch-err");
        r.write("a.ts", "a\n");
        let err = file_patch(&r.0, SourceKind::BranchRange, None, "a.ts", None, false)
            .expect_err("a failed diff is not a clean file");
        assert!(err.starts_with("git diff"), "{err}");
    }

    #[test]
    fn preview_rows_carry_a_worktree_signature() {
        let r = Repo::new("sig");
        r.write("a.txt", "a\n");
        r.commit("init");
        r.write("a.txt", "b\n");
        let w = r.working();
        assert!(w.files[0].sig.is_some());
    }
}
