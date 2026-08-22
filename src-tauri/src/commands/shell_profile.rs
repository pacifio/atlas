//! Reading and surgically editing `export VAR=...` lines in a user's shell
//! profile.
//!
//! Atlas no longer stores API keys. Settings ▸ API Keys is a view onto the
//! user's shell environment, and this module is the only thing that writes to
//! it. That makes these files the one place Atlas modifies **outside its own
//! data dirs and the user's project**, so the rules here are deliberately
//! conservative:
//!
//! - **Surgical.** An existing assignment is rewritten in place, preserving
//!   every other line, its own comments, and file order. New variables are
//!   appended under a single marked block so they are obvious and removable
//!   by hand.
//! - **Never guess a commented-out line.** `# export FOO=bar` is documentation,
//!   not configuration; it is neither read nor rewritten.
//! - **Quote on write, unquote on read.** Values are always emitted
//!   single-quoted with embedded quotes escaped, so a key containing `$`,
//!   spaces or `"` can never be re-interpreted by the shell.
//!
//! Everything here is pure string/path logic — no Tauri, no I/O beyond the
//! caller's — so the parsing and rewriting rules are unit-tested below.

use std::path::{Path, PathBuf};

/// The shell family a profile belongs to. Only affects assignment syntax.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellKind {
    /// `export VAR='value'` — sh, bash, zsh, and anything else POSIX-ish.
    Posix,
    /// `set -gx VAR 'value'` — fish is not POSIX and needs its own form.
    Fish,
}

impl ShellKind {
    /// Classify from a `$SHELL` path. Unknown shells are treated as POSIX,
    /// which is right far more often than not.
    pub fn from_shell_path(shell: &str) -> Self {
        let name = Path::new(shell)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        if name.contains("fish") {
            Self::Fish
        } else {
            Self::Posix
        }
    }
}

/// Marker for the block Atlas appends new variables under.
const BLOCK_HEADER: &str = "# Added by Atlas — AI provider keys";

/// One `VAR=value` assignment found in a profile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assignment {
    pub var: String,
    pub value: String,
    /// 1-based line number, for showing the user exactly what would change.
    pub line: usize,
}

/// Profile files to SCAN, most-specific first. All of them are read because a
/// user's key may live in any one, and we want to report where it actually is
/// rather than where we would have put it.
///
/// Order matters: the first file containing a variable is treated as its home,
/// which is also the file an edit rewrites.
pub fn scan_candidates(home: &Path, shell: &str) -> Vec<PathBuf> {
    match ShellKind::from_shell_path(shell) {
        ShellKind::Fish => vec![home.join(".config/fish/config.fish")],
        ShellKind::Posix => {
            let name = Path::new(shell)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("");
            let mut out = if name.contains("bash") {
                // macOS login shells read .bash_profile; Linux interactive
                // shells read .bashrc. Both are common homes for exports.
                vec![home.join(".bashrc"), home.join(".bash_profile")]
            } else {
                vec![home.join(".zshrc"), home.join(".zprofile"), home.join(".zshenv")]
            };
            // Read by every POSIX login shell — checked last so a shell-specific
            // file wins as the edit target.
            out.push(home.join(".profile"));
            out
        }
    }
}

/// The file NEW variables are written to when they exist nowhere yet.
pub fn primary_target(home: &Path, shell: &str) -> PathBuf {
    scan_candidates(home, shell)
        .into_iter()
        .next()
        .unwrap_or_else(|| home.join(".profile"))
}

/// Parse every uncommented assignment in `content`.
///
/// Recognises `export VAR=value`, a bare `VAR=value`, and fish's
/// `set -gx VAR value`. Leading whitespace is allowed; a line whose first
/// non-space character is `#` is skipped entirely.
pub fn parse_assignments(content: &str) -> Vec<Assignment> {
    let mut out = Vec::new();
    for (i, raw) in content.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(a) = parse_line(line, i + 1) {
            out.push(a);
        }
    }
    out
}

fn parse_line(line: &str, line_no: usize) -> Option<Assignment> {
    // fish: `set -gx VAR value` / `set -x VAR value`
    if let Some(rest) = line.strip_prefix("set ") {
        let mut parts = rest.split_whitespace();
        let flags = parts.next()?;
        if !flags.starts_with('-') || !flags.contains('x') {
            return None;
        }
        let var = parts.next()?;
        let value = rest
            .split_once(var)
            .map(|(_, v)| v.trim())
            .unwrap_or_default();
        if !is_var_name(var) {
            return None;
        }
        return Some(Assignment {
            var: var.to_string(),
            value: unquote(strip_trailing_comment(value)),
            line: line_no,
        });
    }

    // POSIX: `export VAR=value` or `VAR=value`
    let body = line.strip_prefix("export ").unwrap_or(line).trim_start();
    let (var, value) = body.split_once('=')?;
    let var = var.trim();
    if !is_var_name(var) {
        return None;
    }
    Some(Assignment {
        var: var.to_string(),
        value: unquote(strip_trailing_comment(value.trim())),
        line: line_no,
    })
}

/// A trailing `# comment` is only a comment when the value is unquoted —
/// inside quotes `#` is an ordinary character.
fn strip_trailing_comment(value: &str) -> &str {
    let v = value.trim();
    if v.starts_with('\'') || v.starts_with('"') {
        return v;
    }
    match v.split_once(" #") {
        Some((before, _)) => before.trim_end(),
        None => v,
    }
}

fn is_var_name(s: &str) -> bool {
    !s.is_empty()
        && s.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Strip one matching pair of surrounding quotes and unescape what the shell
/// would have.
fn unquote(v: &str) -> String {
    let v = v.trim();
    if v.len() >= 2 {
        let bytes = v.as_bytes();
        if bytes[0] == b'\'' && bytes[v.len() - 1] == b'\'' {
            // Single quotes are literal; the only escape is the '\'' dance.
            return v[1..v.len() - 1].replace("'\\''", "'");
        }
        if bytes[0] == b'"' && bytes[v.len() - 1] == b'"' {
            return v[1..v.len() - 1].replace("\\\"", "\"").replace("\\$", "$");
        }
    }
    v.to_string()
}

/// Render an assignment. Always single-quoted: a key can contain `$`, spaces or
/// `"` and must reach the shell byte-for-byte.
pub fn render_assignment(var: &str, value: &str, kind: ShellKind) -> String {
    let quoted = format!("'{}'", value.replace('\'', r"'\''"));
    match kind {
        ShellKind::Posix => format!("export {var}={quoted}"),
        ShellKind::Fish => format!("set -gx {var} {quoted}"),
    }
}

/// Insert or replace `var` in `content`, returning the new content.
///
/// An existing uncommented assignment is rewritten **in place**, so the
/// variable keeps its position and any surrounding comments. Otherwise the
/// assignment is appended under [`BLOCK_HEADER`], creating that block once.
pub fn upsert(content: &str, var: &str, value: &str, kind: ShellKind) -> String {
    let rendered = render_assignment(var, value, kind);

    let existing: Vec<usize> = parse_assignments(content)
        .into_iter()
        .filter(|a| a.var == var)
        .map(|a| a.line)
        .collect();

    if !existing.is_empty() {
        // Rewrite the LAST occurrence — that is the one the shell ends up with —
        // and drop any earlier duplicates so the file can't disagree with itself.
        let last = *existing.last().unwrap();
        let mut out: Vec<String> = Vec::new();
        for (i, line) in content.lines().enumerate() {
            let n = i + 1;
            if n == last {
                // Preserve the original indentation.
                let indent: String = line.chars().take_while(|c| c.is_whitespace()).collect();
                out.push(format!("{indent}{rendered}"));
            } else if existing.contains(&n) {
                continue; // shadowed duplicate
            } else {
                out.push(line.to_string());
            }
        }
        return join_preserving_trailing_newline(out, content);
    }

    let mut out: Vec<String> = content.lines().map(str::to_string).collect();
    if let Some(pos) = out.iter().position(|l| l.trim() == BLOCK_HEADER) {
        // Append at the end of the existing Atlas block (the run of non-blank
        // lines after the header), so our vars stay together.
        let mut insert_at = pos + 1;
        while insert_at < out.len() && !out[insert_at].trim().is_empty() {
            insert_at += 1;
        }
        out.insert(insert_at, rendered);
    } else {
        if !out.is_empty() && !out.last().is_some_and(|l| l.trim().is_empty()) {
            out.push(String::new());
        }
        out.push(BLOCK_HEADER.to_string());
        out.push(rendered);
    }
    join_preserving_trailing_newline(out, content)
}

/// Remove every uncommented assignment of `var`. If that empties the Atlas
/// block, the header goes too rather than being left dangling.
pub fn remove(content: &str, var: &str) -> String {
    let targets: Vec<usize> = parse_assignments(content)
        .into_iter()
        .filter(|a| a.var == var)
        .map(|a| a.line)
        .collect();
    if targets.is_empty() {
        return content.to_string();
    }
    let mut out: Vec<String> = content
        .lines()
        .enumerate()
        .filter(|(i, _)| !targets.contains(&(i + 1)))
        .map(|(_, l)| l.to_string())
        .collect();

    if let Some(pos) = out.iter().position(|l| l.trim() == BLOCK_HEADER) {
        let empty = out
            .get(pos + 1)
            .map(|l| l.trim().is_empty())
            .unwrap_or(true);
        if empty {
            out.remove(pos);
            // Collapse the blank line we added ahead of the block.
            if pos > 0 && out.get(pos.wrapping_sub(1)).is_some_and(|l| l.trim().is_empty()) {
                out.remove(pos - 1);
            }
        }
    }
    join_preserving_trailing_newline(out, content)
}

/// Rejoin lines, keeping the file's original trailing-newline convention. A
/// profile that ended with a newline must keep doing so — some shells warn
/// otherwise, and a spurious diff on an untouched line is exactly what a
/// surgical editor must not produce.
fn join_preserving_trailing_newline(lines: Vec<String>, original: &str) -> String {
    let mut s = lines.join("\n");
    if original.is_empty() || original.ends_with('\n') {
        s.push('\n');
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_kind_from_path() {
        assert_eq!(ShellKind::from_shell_path("/bin/zsh"), ShellKind::Posix);
        assert_eq!(ShellKind::from_shell_path("/bin/bash"), ShellKind::Posix);
        assert_eq!(
            ShellKind::from_shell_path("/opt/homebrew/bin/fish"),
            ShellKind::Fish
        );
        // Unknown shells fall back to POSIX rather than refusing to work.
        assert_eq!(ShellKind::from_shell_path(""), ShellKind::Posix);
        assert_eq!(ShellKind::from_shell_path("/usr/bin/nu"), ShellKind::Posix);
    }

    #[test]
    fn scan_order_puts_the_edit_target_first() {
        let home = Path::new("/home/u");
        assert_eq!(primary_target(home, "/bin/zsh"), home.join(".zshrc"));
        assert_eq!(primary_target(home, "/bin/bash"), home.join(".bashrc"));
        assert_eq!(
            primary_target(home, "/usr/local/bin/fish"),
            home.join(".config/fish/config.fish")
        );
        // .profile is scanned for every POSIX shell, but never the first choice.
        let zsh = scan_candidates(home, "/bin/zsh");
        assert!(zsh.contains(&home.join(".profile")));
        assert_ne!(zsh[0], home.join(".profile"));
    }

    #[test]
    fn parses_the_shapes_a_profile_actually_contains() {
        let content = r#"
# my keys
export OPENAI_API_KEY=sk-plain
export ANTHROPIC_API_KEY="sk-double"
  export GEMINI_API_KEY='sk-single'
GROQ_API_KEY=bare-assignment
export XAI_API_KEY=sk-x  # trailing comment
"#;
        let a = parse_assignments(content);
        let get = |v: &str| a.iter().find(|x| x.var == v).map(|x| x.value.clone());
        assert_eq!(get("OPENAI_API_KEY").as_deref(), Some("sk-plain"));
        assert_eq!(get("ANTHROPIC_API_KEY").as_deref(), Some("sk-double"));
        assert_eq!(get("GEMINI_API_KEY").as_deref(), Some("sk-single"));
        assert_eq!(get("GROQ_API_KEY").as_deref(), Some("bare-assignment"));
        assert_eq!(get("XAI_API_KEY").as_deref(), Some("sk-x"));
    }

    #[test]
    fn ignores_commented_out_assignments() {
        // A commented line is documentation. Reading it would show the user a
        // key that is not actually set; rewriting it would silently activate it.
        let content = "# export OPENAI_API_KEY=sk-old\n#export FOO=bar\n";
        assert!(parse_assignments(content).is_empty());
    }

    #[test]
    fn ignores_lines_that_are_not_assignments() {
        let content = "echo hello\nif [ -f x ]; then\nfi\nexport PATH\nsource ~/.other\n";
        assert!(parse_assignments(content).is_empty(), "{:?}", parse_assignments(content));
    }

    #[test]
    fn rejects_invalid_variable_names() {
        let content = "export 1BAD=x\nexport has-dash=x\nexport ok_NAME=y\n";
        let a = parse_assignments(content);
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].var, "ok_NAME");
    }

    #[test]
    fn parses_fish_assignments() {
        let content = "set -gx OPENAI_API_KEY 'sk-fish'\nset -x GROQ_API_KEY plain\nset foo bar\n";
        let a = parse_assignments(content);
        assert_eq!(a.len(), 2, "{a:?}");
        assert_eq!(a[0].value, "sk-fish");
        assert_eq!(a[1].value, "plain");
    }

    #[test]
    fn hash_inside_quotes_is_part_of_the_value() {
        let a = parse_assignments(r#"export K="abc#def""#);
        assert_eq!(a[0].value, "abc#def");
    }

    #[test]
    fn upsert_rewrites_in_place_and_preserves_everything_else() {
        let content = "# header\nexport PATH=/usr/bin\nexport OPENAI_API_KEY=old\nalias ll='ls -l'\n";
        let out = upsert(content, "OPENAI_API_KEY", "new", ShellKind::Posix);
        assert_eq!(
            out,
            "# header\nexport PATH=/usr/bin\nexport OPENAI_API_KEY='new'\nalias ll='ls -l'\n"
        );
    }

    #[test]
    fn upsert_keeps_indentation_of_the_line_it_replaces() {
        let out = upsert("  export K=old\n", "K", "new", ShellKind::Posix);
        assert_eq!(out, "  export K='new'\n");
    }

    #[test]
    fn upsert_appends_under_a_marked_block_when_new() {
        let out = upsert("export PATH=/usr/bin\n", "GROQ_API_KEY", "gsk", ShellKind::Posix);
        assert_eq!(
            out,
            format!("export PATH=/usr/bin\n\n{BLOCK_HEADER}\nexport GROQ_API_KEY='gsk'\n")
        );
    }

    #[test]
    fn upsert_reuses_an_existing_atlas_block() {
        let start = upsert("x=1\n", "A_API_KEY", "1", ShellKind::Posix);
        let both = upsert(&start, "B_API_KEY", "2", ShellKind::Posix);
        assert_eq!(both.matches(BLOCK_HEADER).count(), 1, "{both}");
        assert!(both.contains("export A_API_KEY='1'"), "{both}");
        assert!(both.contains("export B_API_KEY='2'"), "{both}");
    }

    #[test]
    fn upsert_collapses_shadowed_duplicates() {
        // The shell keeps the LAST assignment; leaving an earlier one behind
        // means the file disagrees with what the user sees in Atlas.
        let content = "export K=first\necho between\nexport K=second\n";
        let out = upsert(content, "K", "final", ShellKind::Posix);
        assert_eq!(out, "echo between\nexport K='final'\n");
        assert_eq!(parse_assignments(&out).len(), 1);
    }

    #[test]
    fn upsert_does_not_touch_a_commented_assignment() {
        let content = "# export K=documented\n";
        let out = upsert(content, "K", "real", ShellKind::Posix);
        assert!(out.contains("# export K=documented"), "{out}");
        assert!(out.contains("export K='real'"), "{out}");
    }

    #[test]
    fn values_are_quoted_so_the_shell_cannot_reinterpret_them() {
        let out = upsert("", "K", "a b$c\"d", ShellKind::Posix);
        assert!(out.contains(r#"export K='a b$c"d'"#), "{out}");
        // Round-trips: what we wrote is what we read back.
        assert_eq!(parse_assignments(&out)[0].value, "a b$c\"d");
    }

    #[test]
    fn single_quotes_in_a_value_round_trip() {
        let out = upsert("", "K", "it's", ShellKind::Posix);
        assert_eq!(parse_assignments(&out)[0].value, "it's");
    }

    #[test]
    fn fish_uses_its_own_assignment_syntax() {
        let out = upsert("", "K", "v", ShellKind::Fish);
        assert!(out.contains("set -gx K 'v'"), "{out}");
        assert_eq!(parse_assignments(&out)[0].value, "v");
    }

    #[test]
    fn remove_deletes_every_occurrence_and_nothing_else() {
        let content = "export A=1\nexport K=x\necho hi\nexport K=y\nexport B=2\n";
        let out = remove(content, "K");
        assert_eq!(out, "export A=1\necho hi\nexport B=2\n");
    }

    #[test]
    fn remove_cleans_up_an_emptied_atlas_block() {
        let content = upsert("export PATH=/usr/bin\n", "K", "v", ShellKind::Posix);
        let out = remove(&content, "K");
        assert!(!out.contains(BLOCK_HEADER), "{out}");
        assert_eq!(out, "export PATH=/usr/bin\n");
    }

    #[test]
    fn remove_keeps_the_block_when_other_vars_remain() {
        let a = upsert("", "A_API_KEY", "1", ShellKind::Posix);
        let b = upsert(&a, "B_API_KEY", "2", ShellKind::Posix);
        let out = remove(&b, "A_API_KEY");
        assert!(out.contains(BLOCK_HEADER), "{out}");
        assert!(out.contains("export B_API_KEY='2'"), "{out}");
    }

    #[test]
    fn remove_of_an_absent_var_is_byte_identical() {
        let content = "export A=1\n# comment\n";
        assert_eq!(remove(content, "NOPE"), content);
    }

    #[test]
    fn trailing_newline_convention_is_preserved() {
        assert!(upsert("export A=1\n", "B", "2", ShellKind::Posix).ends_with('\n'));
        assert!(!upsert("export A=1", "B", "2", ShellKind::Posix).ends_with('\n'));
        assert!(remove("export A=1\nexport B=2\n", "B").ends_with('\n'));
    }
}
