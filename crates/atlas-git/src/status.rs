//! `git status --porcelain=2 -z` parser.
//!
//! Porcelain v2 gives us — in one spawn — everything the old v1 path needed
//! three for: the branch name, upstream, ahead/behind, rename detection,
//! submodule state and conflict codes. Ported from GitHub Desktop's
//! `status-parser.ts`.

/// One changed path. `index`/`worktree` are the raw XY chars ('.', 'M', 'A',
/// 'D', 'R', 'C', 'T', 'U', '?').
#[derive(Debug, Clone, PartialEq)]
pub struct StatusEntry {
    pub path: String,
    /// The pre-rename path for renamed/copied entries.
    pub orig_path: Option<String>,
    pub index: char,
    pub worktree: char,
    pub is_submodule: bool,
    /// Both-sides XY for unmerged entries (e.g. "UU", "AA", "DU").
    pub unmerged: Option<String>,
    pub untracked: bool,
}

#[derive(Debug, Clone, Default)]
pub struct StatusV2 {
    /// `None` when HEAD is detached (git reports `(detached)`).
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub detached: bool,
    pub entries: Vec<StatusEntry>,
}

/// Parse the NUL-delimited output of
/// `git status --porcelain=2 -z --branch [--untracked-files=all]`.
pub fn parse(bytes: &[u8]) -> StatusV2 {
    let mut out = StatusV2::default();
    let text = String::from_utf8_lossy(bytes);
    let mut tokens = text.split('\0').filter(|t| !t.is_empty());

    while let Some(tok) = tokens.next() {
        if let Some(header) = tok.strip_prefix("# ") {
            parse_header(header, &mut out);
            continue;
        }
        let mut chars = tok.chars();
        match chars.next() {
            // `1 XY sub mH mI mW hH hI path` — ordinary change
            Some('1') => {
                if let Some((xy, sub, path)) = split_fields(tok, 8) {
                    out.entries.push(entry(path, None, xy, sub, None, false));
                }
            }
            // `2 XY sub mH mI mW hH hI Xscore path` NUL origPath
            Some('2') => {
                if let Some((xy, sub, path)) = split_fields(tok, 9) {
                    let orig = tokens.next().map(|s| s.to_string());
                    out.entries.push(entry(path, orig, xy, sub, None, false));
                }
            }
            // `u XY sub m1 m2 m3 mW h1 h2 h3 path` — unmerged
            Some('u') => {
                if let Some((xy, sub, path)) = split_fields(tok, 10) {
                    let unmerged = Some(xy.clone());
                    out.entries.push(entry(path, None, xy, sub, unmerged, false));
                }
            }
            Some('?') => {
                if let Some(path) = tok.get(2..) {
                    out.entries.push(StatusEntry {
                        path: path.to_string(),
                        orig_path: None,
                        index: '.',
                        worktree: '?',
                        is_submodule: false,
                        unmerged: None,
                        untracked: true,
                    });
                }
            }
            // `!` ignored entries — dropped.
            _ => {}
        }
    }
    out
}

fn parse_header(header: &str, out: &mut StatusV2) {
    if let Some(head) = header.strip_prefix("branch.head ") {
        if head == "(detached)" {
            out.detached = true;
        } else {
            out.branch = Some(head.to_string());
        }
    } else if let Some(up) = header.strip_prefix("branch.upstream ") {
        out.upstream = Some(up.to_string());
    } else if let Some(ab) = header.strip_prefix("branch.ab ") {
        for part in ab.split_whitespace() {
            if let Some(a) = part.strip_prefix('+') {
                out.ahead = a.parse().unwrap_or(0);
            } else if let Some(b) = part.strip_prefix('-') {
                out.behind = b.parse().unwrap_or(0);
            }
        }
    }
}

/// Split an entry token into (XY, submodule-field, path) where `path` is
/// everything after `nfields` space-separated fields (paths may contain
/// spaces; `-z` guarantees no NULs inside them).
fn split_fields(tok: &str, nfields: usize) -> Option<(String, String, String)> {
    let mut rest = tok;
    let mut fields: Vec<&str> = Vec::with_capacity(nfields);
    for _ in 0..nfields {
        let (field, tail) = rest.split_once(' ')?;
        fields.push(field);
        rest = tail;
    }
    Some((fields[1].to_string(), fields[2].to_string(), rest.to_string()))
}

fn entry(
    path: String,
    orig_path: Option<String>,
    xy: String,
    sub: String,
    unmerged: Option<String>,
    untracked: bool,
) -> StatusEntry {
    let mut c = xy.chars();
    StatusEntry {
        path,
        orig_path,
        index: c.next().unwrap_or('.'),
        worktree: c.next().unwrap_or('.'),
        is_submodule: sub.starts_with('S'),
        unmerged,
        untracked,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn z(parts: &[&str]) -> Vec<u8> {
        let mut v = Vec::new();
        for p in parts {
            v.extend_from_slice(p.as_bytes());
            v.push(0);
        }
        v
    }

    #[test]
    fn parses_branch_header_and_ahead_behind() {
        let input = z(&[
            "# branch.oid 1234567890abcdef1234567890abcdef12345678",
            "# branch.head main",
            "# branch.upstream origin/main",
            "# branch.ab +2 -1",
        ]);
        let s = parse(&input);
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.upstream.as_deref(), Some("origin/main"));
        assert_eq!((s.ahead, s.behind), (2, 1));
        assert!(!s.detached);
    }

    #[test]
    fn parses_ordinary_untracked_and_paths_with_spaces() {
        let input = z(&[
            "# branch.head main",
            "1 .M N... 100644 100644 100644 aaaa bbbb src/my file.rs",
            "1 A. N... 000000 100644 100644 0000 cccc new.rs",
            "? notes/tod o.md",
        ]);
        let s = parse(&input);
        assert_eq!(s.entries.len(), 3);
        assert_eq!(s.entries[0].path, "src/my file.rs");
        assert_eq!((s.entries[0].index, s.entries[0].worktree), ('.', 'M'));
        assert_eq!((s.entries[1].index, s.entries[1].worktree), ('A', '.'));
        assert!(s.entries[2].untracked);
        assert_eq!(s.entries[2].path, "notes/tod o.md");
    }

    #[test]
    fn parses_rename_with_orig_path() {
        let input = z(&[
            "# branch.head main",
            "2 R. N... 100644 100644 100644 aaaa aaaa R100 new-name.rs",
            "old-name.rs",
        ]);
        let s = parse(&input);
        assert_eq!(s.entries.len(), 1);
        let e = &s.entries[0];
        assert_eq!(e.path, "new-name.rs");
        assert_eq!(e.orig_path.as_deref(), Some("old-name.rs"));
        assert_eq!(e.index, 'R');
    }

    #[test]
    fn parses_unmerged_and_submodule() {
        let input = z(&[
            "# branch.head main",
            "u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflicted.rs",
            "1 .M S.M. 160000 160000 160000 aaaa aaaa vendor/sub",
        ]);
        let s = parse(&input);
        assert_eq!(s.entries[0].unmerged.as_deref(), Some("UU"));
        assert!(s.entries[1].is_submodule);
    }

    #[test]
    fn detached_head() {
        let input = z(&["# branch.oid abc", "# branch.head (detached)"]);
        let s = parse(&input);
        assert!(s.detached);
        assert!(s.branch.is_none());
    }
}
