//! `git diff -U0` hunks for `impact_of_diff`, via the atlas-git spawn chokepoint.

use std::path::Path;

use atlas_git::GitCommand;

use crate::IndexError;

/// git's empty tree: the diff base for a repository with no commits yet.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// One changed range. Lines are 1-based in the NEW file (the working tree the index reflects).
/// `new_lines == 0` is a pure deletion after line `new_start`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffHunk {
    pub rel: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    /// The file no longer exists (`+++ /dev/null`).
    pub deleted_file: bool,
}

impl DiffHunk {
    /// Inclusive new-file line range this hunk touches.
    pub fn line_range(&self) -> (u32, u32) {
        if self.new_lines == 0 {
            (self.new_start.max(1), self.new_start.saturating_add(1))
        } else {
            (
                self.new_start,
                self.new_start.saturating_add(self.new_lines - 1),
            )
        }
    }
}

/// Parse `git diff -U0` output (any number of files).
pub fn parse_unified_zero(diff: &str) -> Vec<DiffHunk> {
    let mut out = Vec::new();
    let mut old_path: Option<String> = None;
    let mut new_path: Option<String> = None;
    // Body lines the current hunk still owes. A removed `-- x` reads `--- x`,
    // so `---`/`+++` are file headers only outside a hunk (exact with -U0).
    let (mut old_left, mut new_left) = (0u32, 0u32);
    for line in diff.lines() {
        if old_left > 0 || new_left > 0 {
            if line.starts_with('-') {
                old_left = old_left.saturating_sub(1);
                continue;
            }
            if line.starts_with('+') {
                new_left = new_left.saturating_sub(1);
                continue;
            }
            if line.starts_with('\\') {
                continue; // "\ No newline at end of file"
            }
            (old_left, new_left) = (0, 0);
        }
        if line.starts_with("diff --git ") {
            old_path = None;
            new_path = None;
        } else if let Some(p) = line.strip_prefix("--- ") {
            old_path = diff_path(p, "a/");
        } else if let Some(p) = line.strip_prefix("+++ ") {
            new_path = diff_path(p, "b/");
        } else if let Some(h) = line.strip_prefix("@@ ") {
            let Some((old, new)) = parse_header(h) else {
                continue;
            };
            (old_left, new_left) = (old.1, new.1);
            let Some(rel) = new_path.clone().or_else(|| old_path.clone()) else {
                continue;
            };
            out.push(DiffHunk {
                rel,
                old_start: old.0,
                old_lines: old.1,
                new_start: new.0,
                new_lines: new.1,
                deleted_file: new_path.is_none(),
            });
        }
    }
    out
}

/// `-a,b +c,d @@ …` → ((a, b), (c, d)); a missing count is 1.
fn parse_header(h: &str) -> Option<((u32, u32), (u32, u32))> {
    let mut parts = h.split_whitespace();
    let old = parse_range(parts.next()?.strip_prefix('-')?)?;
    let new = parse_range(parts.next()?.strip_prefix('+')?)?;
    Some((old, new))
}

fn parse_range(r: &str) -> Option<(u32, u32)> {
    match r.split_once(',') {
        Some((s, n)) => Some((s.parse().ok()?, n.parse().ok()?)),
        None => Some((r.parse().ok()?, 1)),
    }
}

/// `a/x/y.rs` → `x/y.rs`; `/dev/null` → None; C-quoted paths are unquoted.
fn diff_path(raw: &str, prefix: &str) -> Option<String> {
    let raw = raw.trim_end_matches('\t');
    if raw == "/dev/null" {
        return None;
    }
    let p = if raw.starts_with('"') {
        unquote_c(raw)
    } else {
        raw.to_string()
    };
    Some(p.strip_prefix(prefix).map(str::to_string).unwrap_or(p))
}

/// git's C-style quoting: `"a\tb\303\251"` → bytes → UTF-8 (lossy).
fn unquote_c(s: &str) -> String {
    let inner = s.trim_matches('"').as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(inner.len());
    let mut i = 0;
    while i < inner.len() {
        if inner[i] != b'\\' || i + 1 >= inner.len() {
            out.push(inner[i]);
            i += 1;
            continue;
        }
        let c = inner[i + 1];
        match c {
            b'0'..=b'7' if i + 4 <= inner.len() => {
                let oct = std::str::from_utf8(&inner[i + 1..i + 4])
                    .ok()
                    .and_then(|o| u8::from_str_radix(o, 8).ok());
                match oct {
                    Some(b) => {
                        out.push(b);
                        i += 4;
                    }
                    None => {
                        out.push(c);
                        i += 2;
                    }
                }
            }
            b'n' => {
                out.push(b'\n');
                i += 2;
            }
            b't' => {
                out.push(b'\t');
                i += 2;
            }
            _ => {
                out.push(c);
                i += 2;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Hunks of the working tree against `base` (merge-base with HEAD) or HEAD, plus untracked
/// files as whole-file additions. Paths are relative to `root` (`--relative`).
pub fn git_diff_hunks(root: &Path, base: Option<&str>) -> Result<Vec<DiffHunk>, IndexError> {
    let git = |args: &[&str]| {
        GitCommand::new(root, args)
            .read_only()
            .run()
            .map_err(|e| IndexError::Graph(e.to_string()))
    };
    let base_rev = match base {
        Some(b) => git(&["merge-base", b, "HEAD"])?.stdout.trim().to_string(),
        None if git(&["rev-parse", "--verify", "-q", "HEAD"]).is_ok() => "HEAD".to_string(),
        None => EMPTY_TREE.to_string(),
    };
    let diff = git(&[
        "-c",
        "core.quotePath=false",
        "diff",
        "-U0",
        "--no-color",
        "--no-ext-diff",
        "--no-renames",
        "--relative",
        &base_rev,
        "--",
    ])?;
    let mut hunks = parse_unified_zero(&diff.stdout);
    let untracked = git(&["ls-files", "--others", "--exclude-standard", "-z"])?;
    for rel in untracked.stdout.split('\0').filter(|p| !p.is_empty()) {
        hunks.push(DiffHunk {
            rel: rel.to_string(),
            old_start: 0,
            old_lines: 0,
            new_start: 1,
            new_lines: u32::MAX,
            deleted_file: false,
        });
    }
    hunks.sort_by(|a, b| (&a.rel, a.new_start).cmp(&(&b.rel, b.new_start)));
    Ok(hunks)
}

/// Distinct changed paths, sorted.
pub fn changed_paths(hunks: &[DiffHunk]) -> Vec<String> {
    let mut v: Vec<String> = hunks.iter().map(|h| h.rel.clone()).collect();
    v.sort();
    v.dedup();
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_unified_zero_handles_add_delete_and_quoted_paths() {
        let diff = "diff --git a/src/a.rs b/src/a.rs\nindex 1..2 100644\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -3 +3 @@ fn x\n-a\n+b\n@@ -10,2 +9,0 @@\n-c\n-d\n\
diff --git a/new.py b/new.py\nnew file mode 100644\n--- /dev/null\n+++ b/new.py\n@@ -0,0 +1,4 @@\n+x\n\
diff --git a/gone.go b/gone.go\ndeleted file mode 100644\n--- a/gone.go\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-y\n\
diff --git \"a/sp ace\\303\\251.ts\" \"b/sp ace\\303\\251.ts\"\n--- \"a/sp ace\\303\\251.ts\"\n+++ \"b/sp ace\\303\\251.ts\"\n@@ -1 +1 @@\n-z\n+w\n";
        let h = parse_unified_zero(diff);
        let got: Vec<(&str, u32, u32, bool)> = h
            .iter()
            .map(|x| (x.rel.as_str(), x.new_start, x.new_lines, x.deleted_file))
            .collect();
        assert_eq!(
            got,
            vec![
                ("src/a.rs", 3, 1, false),
                ("src/a.rs", 9, 0, false),
                ("new.py", 1, 4, false),
                ("gone.go", 0, 0, true),
                ("sp aceé.ts", 1, 1, false),
            ]
        );
        assert_eq!(h[1].line_range(), (9, 10));
        assert_eq!(h[2].line_range(), (1, 4));
    }

    #[test]
    fn hunk_lines_that_look_like_file_headers_stay_body_lines() {
        // A removed SQL comment `-- x` and an added `++ y` read `--- x` / `+++ y`.
        let diff = "diff --git a/gone.sql b/gone.sql\ndeleted file mode 100644\n--- a/gone.sql\n+++ /dev/null\n@@ -1,2 +0,0 @@\n--- note\n-select 1;\n\\ No newline at end of file\n\
diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+++ y\n@@ -5 +5,0 @@\n-z\n";
        let got: Vec<(String, u32, bool)> = parse_unified_zero(diff)
            .into_iter()
            .map(|x| (x.rel, x.new_start, x.deleted_file))
            .collect();
        assert_eq!(
            got,
            vec![
                ("gone.sql".to_string(), 0, true),
                ("a.ts".to_string(), 1, false),
                ("a.ts".to_string(), 5, false),
            ]
        );
    }

    #[test]
    fn git_diff_hunks_reads_worktree_and_untracked() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let run = |args: &[&str]| {
            let ok = std::process::Command::new("git")
                .args(args)
                .current_dir(root)
                .output()
                .unwrap()
                .status
                .success();
            assert!(ok, "git {args:?}");
        };
        run(&["init", "-q"]);
        run(&[
            "-c",
            "user.email=t@t",
            "-c",
            "user.name=t",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "root",
        ]);
        std::fs::write(root.join("a.rs"), "fn a() {}\nfn b() {}\n").unwrap();
        run(&["add", "a.rs"]);
        run(&[
            "-c",
            "user.email=t@t",
            "-c",
            "user.name=t",
            "commit",
            "-q",
            "-m",
            "a",
        ]);
        std::fs::write(root.join("a.rs"), "fn a() {}\nfn b() { x(); }\n").unwrap();
        std::fs::write(root.join("new.rs"), "fn n() {}\n").unwrap();
        let hunks = git_diff_hunks(root, None).unwrap();
        assert_eq!(
            changed_paths(&hunks),
            vec!["a.rs".to_string(), "new.rs".to_string()]
        );
        assert_eq!(hunks[0].line_range(), (2, 2));
        assert!(git_diff_hunks(root, Some("no-such-branch")).is_err());
    }
}
