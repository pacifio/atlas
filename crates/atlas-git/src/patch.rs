//! Unified-diff parsing + patch synthesis for hunk/line-level staging.
//!
//! Ported from GitHub Desktop's `patch-formatter.ts` / `diff-parser.ts`:
//! given a file's fresh `git diff` output and a selection (whole hunk, or a
//! subset of its changed lines), synthesize a minimal patch that `git apply
//! --cached` (stage), `--cached --reverse` (unstage) or `--reverse`
//! (discard) accepts.
//!
//! Selection is matched by CONTENT, not position: the UI's diff may be
//! seconds old (or diffed against HEAD while we re-diff against the index),
//! so the caller sends the hunk it displayed and we find the identical hunk
//! in the fresh diff. Line numbers come from the fresh side.

/// One line inside a hunk, tagged with its unified-diff marker.
#[derive(Debug, Clone, PartialEq)]
pub enum PatchLine {
    Context(String),
    Add(String),
    Del(String),
    /// `\ No newline at end of file` — belongs to the preceding line.
    NoNewline,
}

#[derive(Debug, Clone)]
pub struct Hunk {
    pub old_start: u32,
    pub old_count: u32,
    pub new_start: u32,
    pub new_count: u32,
    /// Text after the closing `@@` (function heading), if any.
    pub heading: String,
    pub lines: Vec<PatchLine>,
}

#[derive(Debug, Clone)]
pub struct FilePatch {
    /// Everything before the first `@@` (diff --git, index, ---/+++ …).
    pub header: Vec<String>,
    pub hunks: Vec<Hunk>,
    /// True when the header marks a binary diff (no hunks to select).
    pub binary: bool,
}

/// Parse ONE file's unified diff (`git diff -- <file>` output).
pub fn parse_file_diff(text: &str) -> Option<FilePatch> {
    let mut header = Vec::new();
    let mut hunks: Vec<Hunk> = Vec::new();
    let mut binary = false;

    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("@@ ") {
            let hunk = parse_hunk_header(rest)?;
            hunks.push(hunk);
            continue;
        }
        match hunks.last_mut() {
            None => {
                if line.starts_with("Binary files ") || line.starts_with("GIT binary patch") {
                    binary = true;
                }
                header.push(line.to_string());
            }
            Some(h) => {
                if let Some(c) = line.strip_prefix('+') {
                    h.lines.push(PatchLine::Add(c.to_string()));
                } else if let Some(c) = line.strip_prefix('-') {
                    h.lines.push(PatchLine::Del(c.to_string()));
                } else if let Some(c) = line.strip_prefix(' ') {
                    h.lines.push(PatchLine::Context(c.to_string()));
                } else if line.starts_with('\\') {
                    h.lines.push(PatchLine::NoNewline);
                }
                // Anything else (empty trailing line) is ignored.
            }
        }
    }
    if header.is_empty() && hunks.is_empty() {
        return None;
    }
    Some(FilePatch { header, hunks, binary })
}

/// `-l[,s] +l[,s] @@[ heading]`
fn parse_hunk_header(rest: &str) -> Option<Hunk> {
    let (ranges, heading) = rest.split_once("@@")?;
    let mut old = (0u32, 1u32);
    let mut new = (0u32, 1u32);
    for part in ranges.split_whitespace() {
        if let Some(r) = part.strip_prefix('-') {
            old = parse_range(r)?;
        } else if let Some(r) = part.strip_prefix('+') {
            new = parse_range(r)?;
        }
    }
    Some(Hunk {
        old_start: old.0,
        old_count: old.1,
        new_start: new.0,
        new_count: new.1,
        heading: heading.trim_start().to_string(),
        lines: Vec::new(),
    })
}

fn parse_range(r: &str) -> Option<(u32, u32)> {
    match r.split_once(',') {
        Some((s, c)) => Some((s.parse().ok()?, c.parse().ok()?)),
        None => Some((r.parse().ok()?, 1)),
    }
}

/// Content signature of a hunk: the (marker, text) sequence excluding
/// no-newline markers. Two hunks with equal signatures are "the same
/// change" regardless of line-number drift.
pub fn hunk_signature(h: &Hunk) -> Vec<(u8, &str)> {
    h.lines
        .iter()
        .filter_map(|l| match l {
            PatchLine::Context(c) => Some((b' ', c.as_str())),
            PatchLine::Add(c) => Some((b'+', c.as_str())),
            PatchLine::Del(c) => Some((b'-', c.as_str())),
            PatchLine::NoNewline => None,
        })
        .collect()
}

/// Find the hunk in `fresh` whose content matches `displayed_body` — the
/// body the UI showed, one `(marker, content)` per line in order, markers
/// being `' '`, `'+'`, `'-'` (no-newline markers omitted).
pub fn find_matching_hunk<'a>(
    fresh: &'a FilePatch,
    displayed_body: &[(u8, String)],
) -> Option<usize> {
    let want: Vec<(u8, &str)> = displayed_body.iter().map(|(m, c)| (*m, c.as_str())).collect();
    fresh.hunks.iter().position(|h| hunk_signature(h) == want)
}

fn format_hunk_header(old_start: u32, old_count: u32, new_start: u32, new_count: u32, heading: &str) -> String {
    let old = if old_count == 1 { format!("{old_start}") } else { format!("{old_start},{old_count}") };
    let new = if new_count == 1 { format!("{new_start}") } else { format!("{new_start},{new_count}") };
    if heading.is_empty() {
        format!("@@ -{old} +{new} @@")
    } else {
        format!("@@ -{old} +{new} @@ {heading}")
    }
}

fn push_line(out: &mut String, marker: char, content: &str) {
    out.push(marker);
    out.push_str(content);
    out.push('\n');
}

/// Build a patch containing exactly one whole hunk of `diff`.
pub fn whole_hunk_patch(diff: &FilePatch, hunk_index: usize) -> Option<String> {
    line_selection_patch(diff, hunk_index, None)
}

/// Build a patch for `hunk_index` with only `selected` changed lines kept
/// (`None` = all). `selected` holds indices into the hunk's VISIBLE lines
/// (the same filtered sequence as [`hunk_signature`] — no-newline markers
/// excluded), and only add/del entries matter; context indices are ignored.
///
/// Unselected additions are dropped; unselected deletions become context
/// (Desktop's `formatPatch` rules). Returns `None` when the selection
/// contains no changes.
pub fn line_selection_patch(
    diff: &FilePatch,
    hunk_index: usize,
    selected: Option<&[usize]>,
) -> Option<String> {
    let hunk = diff.hunks.get(hunk_index)?;
    let is_selected = |visible_idx: usize| -> bool {
        match selected {
            None => true,
            Some(s) => s.contains(&visible_idx),
        }
    };

    let mut body = String::new();
    let mut old_count: u32 = 0;
    let mut new_count: u32 = 0;
    let mut any_change = false;
    let mut visible_idx = 0usize;
    // Whether the previous emitted line was kept (for no-newline markers:
    // they only make sense right after their line survived).
    let mut prev_kept = false;

    for line in &hunk.lines {
        match line {
            PatchLine::Context(c) => {
                push_line(&mut body, ' ', c);
                old_count += 1;
                new_count += 1;
                prev_kept = true;
                visible_idx += 1;
            }
            PatchLine::Del(c) => {
                if is_selected(visible_idx) {
                    push_line(&mut body, '-', c);
                    old_count += 1;
                    any_change = true;
                } else {
                    // Not chosen: the old line stays — context.
                    push_line(&mut body, ' ', c);
                    old_count += 1;
                    new_count += 1;
                }
                prev_kept = true;
                visible_idx += 1;
            }
            PatchLine::Add(c) => {
                if is_selected(visible_idx) {
                    push_line(&mut body, '+', c);
                    new_count += 1;
                    any_change = true;
                    prev_kept = true;
                } else {
                    prev_kept = false;
                }
                visible_idx += 1;
            }
            PatchLine::NoNewline => {
                if prev_kept {
                    body.push_str("\\ No newline at end of file\n");
                }
            }
        }
    }

    if !any_change {
        return None;
    }

    let mut out = String::new();
    for h in &diff.header {
        out.push_str(h);
        out.push('\n');
    }
    out.push_str(&format_hunk_header(
        hunk.old_start,
        old_count,
        hunk.new_start,
        new_count,
        &hunk.heading,
    ));
    out.push('\n');
    out.push_str(&body);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
diff --git a/f.txt b/f.txt
index 111..222 100644
--- a/f.txt
+++ b/f.txt
@@ -1,4 +1,4 @@ fn main
 one
-two
+TWO
 three
 four
@@ -10,3 +10,4 @@
 ten
 eleven
+twelve
 thirteen
";

    #[test]
    fn parses_and_rebuilds_whole_hunk() {
        let d = parse_file_diff(SAMPLE).unwrap();
        assert_eq!(d.hunks.len(), 2);
        assert_eq!(d.header.len(), 4);
        assert!(!d.binary);

        let patch = whole_hunk_patch(&d, 0).unwrap();
        assert!(patch.contains("--- a/f.txt"));
        assert!(patch.contains("@@ -1,4 +1,4 @@ fn main"));
        assert!(patch.contains("-two\n+TWO\n"));
        assert!(!patch.contains("twelve"), "second hunk must be excluded");

        let patch2 = whole_hunk_patch(&d, 1).unwrap();
        assert!(patch2.contains("@@ -10,3 +10,4 @@"));
        assert!(patch2.contains("+twelve"));
    }

    #[test]
    fn line_selection_drops_unselected_add_and_keeps_del_as_context() {
        let d = parse_file_diff(SAMPLE).unwrap();
        // Hunk 0 visible lines: 0=" one" 1="-two" 2="+TWO" 3=" three" 4=" four".
        // Select ONLY the deletion.
        let patch = line_selection_patch(&d, 0, Some(&[1])).unwrap();
        assert!(patch.contains("@@ -1,4 +1,3 @@ fn main"), "patch: {patch}");
        assert!(patch.contains("-two\n"));
        assert!(!patch.contains("+TWO"));

        // Select ONLY the addition: the deletion becomes context.
        let patch = line_selection_patch(&d, 0, Some(&[2])).unwrap();
        assert!(patch.contains("@@ -1,4 +1,5 @@ fn main"), "patch: {patch}");
        assert!(patch.contains(" two\n"));
        assert!(patch.contains("+TWO\n"));
    }

    #[test]
    fn empty_selection_yields_none() {
        let d = parse_file_diff(SAMPLE).unwrap();
        assert!(line_selection_patch(&d, 0, Some(&[0, 3])).is_none());
    }

    #[test]
    fn signature_matching_survives_number_drift() {
        let d1 = parse_file_diff(SAMPLE).unwrap();
        // Same content, shifted numbers (as after staging an earlier hunk).
        let shifted = SAMPLE.replace("@@ -10,3 +10,4 @@", "@@ -9,3 +9,4 @@");
        let d2 = parse_file_diff(&shifted).unwrap();
        let displayed: Vec<(u8, String)> = hunk_signature(&d1.hunks[1])
            .into_iter()
            .map(|(m, c)| (m, c.to_string()))
            .collect();
        assert_eq!(find_matching_hunk(&d2, &displayed), Some(1));
    }

    #[test]
    fn no_newline_marker_preserved_only_after_kept_line() {
        let diff = "\
diff --git a/g.txt b/g.txt
--- a/g.txt
+++ b/g.txt
@@ -1,2 +1,2 @@
 keep
-old tail
+new tail
\\ No newline at end of file
";
        let d = parse_file_diff(diff).unwrap();
        let full = whole_hunk_patch(&d, 0).unwrap();
        assert!(full.contains("\\ No newline at end of file"));

        // Visible: 0=" keep" 1="-old tail" 2="+new tail". Selecting just the
        // deletion drops "+new tail" — and its no-newline marker with it.
        let del_only = line_selection_patch(&d, 0, Some(&[1])).unwrap();
        assert!(!del_only.contains("No newline"), "patch: {del_only}");
    }

    #[test]
    fn binary_flag() {
        let d = parse_file_diff("diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n").unwrap();
        assert!(d.binary);
        assert!(d.hunks.is_empty());
    }
}
