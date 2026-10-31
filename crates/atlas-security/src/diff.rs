//! Unified diff parsing: `git diff` output in, files and hunks out.
//!
//! The parser never fails. Bytes are decoded lossily, so a non-UTF-8 file can
//! still be scanned for what it adds, and anything it does not recognise is
//! skipped. Hunk bodies are read by the line counts in their `@@` header, so a
//! removed line that happens to start with `-- ` is never taken for a file
//! header.

/// One line inside a hunk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineKind {
    Added,
    Removed,
    Context,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffLine {
    pub kind: LineKind,
    /// Line number in the old file; `None` for an added line.
    pub old_no: Option<u32>,
    /// Line number in the new file; `None` for a removed line.
    pub new_no: Option<u32>,
    /// The line's text, without the leading marker or a trailing `\r`.
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hunk {
    pub old_start: u32,
    pub new_start: u32,
    /// What git printed after the second `@@`: the enclosing function, when
    /// git's function-context heuristics found one.
    pub context: Option<String>,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed { from: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileChange {
    /// The new path (the old one for a deletion), repository-relative.
    pub path: String,
    pub status: FileStatus,
    pub binary: bool,
    pub hunks: Vec<Hunk>,
}

impl FileChange {
    fn new(path: String) -> Self {
        Self {
            path,
            status: FileStatus::Modified,
            binary: false,
            hunks: Vec::new(),
        }
    }

    /// Every added line with its new-side line number.
    pub fn added_lines(&self) -> impl Iterator<Item = (u32, &str)> {
        self.hunks
            .iter()
            .flat_map(|h| &h.lines)
            .filter(|l| l.kind == LineKind::Added)
            .map(|l| (l.new_no.unwrap_or(0), l.text.as_str()))
    }
}

/// Parse `git diff` / `git diff-tree -p` output.
pub fn parse_unified(diff: &[u8]) -> Vec<FileChange> {
    let mut files: Vec<FileChange> = Vec::new();
    let mut current: Option<FileChange> = None;
    // Whether the current file has already had its `--- ` header.
    let mut saw_old_header = false;
    // Lines still owed to the open hunk, from its header counts.
    let mut old_left: u32 = 0;
    let mut new_left: u32 = 0;
    let mut old_no: u32 = 0;
    let mut new_no: u32 = 0;

    for raw in diff.split(|b| *b == b'\n') {
        let decoded = String::from_utf8_lossy(raw);
        let line = decoded.strip_suffix('\r').unwrap_or(&decoded);

        if old_left > 0 || new_left > 0 {
            if let Some(file) = current.as_mut() {
                if let Some(hunk) = file.hunks.last_mut() {
                    if line.starts_with('\\') {
                        continue;
                    }
                    let (kind, text) = match line.as_bytes().first() {
                        Some(b'+') => (LineKind::Added, &line[1..]),
                        Some(b'-') => (LineKind::Removed, &line[1..]),
                        Some(b' ') => (LineKind::Context, &line[1..]),
                        // Some tools strip the space off an empty context line.
                        None => (LineKind::Context, ""),
                        // Anything else ends the hunk early; parse it as a header.
                        Some(_) => {
                            old_left = 0;
                            new_left = 0;
                            (LineKind::Context, "")
                        }
                    };
                    if old_left > 0 || new_left > 0 {
                        let (o, n) = match kind {
                            LineKind::Added => {
                                new_no += 1;
                                new_left = new_left.saturating_sub(1);
                                (None, Some(new_no))
                            }
                            LineKind::Removed => {
                                old_no += 1;
                                old_left = old_left.saturating_sub(1);
                                (Some(old_no), None)
                            }
                            LineKind::Context => {
                                old_no += 1;
                                new_no += 1;
                                old_left = old_left.saturating_sub(1);
                                new_left = new_left.saturating_sub(1);
                                (Some(old_no), Some(new_no))
                            }
                        };
                        hunk.lines.push(DiffLine {
                            kind,
                            old_no: o,
                            new_no: n,
                            text: text.to_string(),
                        });
                        continue;
                    }
                }
            }
        }

        if let Some(rest) = line.strip_prefix("diff --git ") {
            if let Some(done) = current.take() {
                files.push(done);
            }
            current = Some(FileChange::new(new_path_from_git_header(rest)));
            saw_old_header = false;
        } else if let Some(rest) = line.strip_prefix("--- ") {
            // A plain unified diff (no `diff --git` line) starts a file here.
            let needs_new = match &current {
                None => true,
                Some(f) => saw_old_header || !f.hunks.is_empty(),
            };
            if needs_new {
                if let Some(done) = current.take() {
                    files.push(done);
                }
                let mut file = FileChange::new(strip_side(rest).unwrap_or_default());
                if rest.trim() == "/dev/null" {
                    file.status = FileStatus::Added;
                }
                current = Some(file);
            } else if rest.trim() == "/dev/null" {
                if let Some(f) = current.as_mut() {
                    f.status = FileStatus::Added;
                }
            }
            saw_old_header = true;
        } else if let Some(rest) = line.strip_prefix("+++ ") {
            if let Some(f) = current.as_mut() {
                if rest.trim() == "/dev/null" {
                    f.status = FileStatus::Deleted;
                } else if let Some(path) = strip_side(rest) {
                    if !matches!(f.status, FileStatus::Renamed { .. }) {
                        f.path = path;
                    }
                }
            }
        } else if line.starts_with("@@ ") {
            if let (Some(f), Some(h)) = (current.as_mut(), parse_hunk_header(line)) {
                old_no = h.0.saturating_sub(1);
                new_no = h.2.saturating_sub(1);
                old_left = h.1;
                new_left = h.3;
                f.hunks.push(Hunk {
                    old_start: h.0,
                    new_start: h.2,
                    context: h.4,
                    lines: Vec::new(),
                });
            }
        } else if let Some(f) = current.as_mut() {
            if line.starts_with("new file mode") {
                f.status = FileStatus::Added;
            } else if line.starts_with("deleted file mode") {
                f.status = FileStatus::Deleted;
            } else if let Some(from) = line.strip_prefix("rename from ") {
                f.status = FileStatus::Renamed {
                    from: unquote(from),
                };
            } else if let Some(to) = line.strip_prefix("rename to ") {
                f.path = unquote(to);
            } else if line.starts_with("Binary files ") || line == "GIT binary patch" {
                f.binary = true;
            }
        }
    }
    if let Some(done) = current.take() {
        files.push(done);
    }
    files
}

/// `a/x b/y` → `y`. Splits on the last ` b/`, which is right for every path
/// that does not itself contain ` b/`; the `+++` line corrects the rest.
fn new_path_from_git_header(rest: &str) -> String {
    if let Some(idx) = rest.rfind(" b/") {
        return unquote(&rest[idx + 3..]);
    }
    if let Some(idx) = rest.rfind(" \"b/") {
        return unquote(&format!("\"{}", &rest[idx + 4..]));
    }
    unquote(rest)
}

/// `a/path` or `b/path` (optionally quoted, optionally tab-terminated) →
/// `path`; `/dev/null` → `None`.
fn strip_side(rest: &str) -> Option<String> {
    let rest = rest.split('\t').next().unwrap_or(rest).trim_end();
    if rest == "/dev/null" {
        return None;
    }
    let path = unquote(rest);
    Some(
        path.strip_prefix("a/")
            .or_else(|| path.strip_prefix("b/"))
            .unwrap_or(&path)
            .to_string(),
    )
}

/// Undo git's C-style path quoting for the common escapes.
fn unquote(raw: &str) -> String {
    let raw = raw.trim();
    let Some(inner) = raw.strip_prefix('"').and_then(|r| r.strip_suffix('"')) else {
        return raw.to_string();
    };
    let mut out = String::new();
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

/// `@@ -a[,b] +c[,d] @@ ctx` → (a, b, c, d, ctx). Omitted counts are 1.
fn parse_hunk_header(line: &str) -> Option<(u32, u32, u32, u32, Option<String>)> {
    let body = line.strip_prefix("@@ -")?;
    let (ranges, rest) = body.split_once(" @@")?;
    let (old, new) = ranges.split_once(" +")?;
    let range = |r: &str| -> Option<(u32, u32)> {
        match r.split_once(',') {
            Some((s, c)) => Some((s.parse().ok()?, c.parse().ok()?)),
            None => Some((r.parse().ok()?, 1)),
        }
    };
    let (a, b) = range(old)?;
    let (c, d) = range(new)?;
    let ctx = rest.trim();
    Some((a, b, c, d, (!ctx.is_empty()).then(|| ctx.to_string())))
}
