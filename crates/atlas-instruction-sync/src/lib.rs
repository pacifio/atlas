//! Mirror a project's convention files into its `AGENTS.md`.
//!
//! # The problem
//!
//! Some agents read a project's instructions from `CLAUDE.md` and
//! `.claude/rules/*.md`; many others follow the `AGENTS.md` convention and read
//! only that file. A project that keeps its rules in the first pair silently
//! has none for an agent that reads the second, so switching agents mid-task
//! drops every "ask before you spend money" rule on the floor.
//!
//! # The shape
//!
//! One block in `AGENTS.md`, between [`BLOCK_START`] and [`BLOCK_END`], holds
//! `CLAUDE.md`, `.claude/CLAUDE.md` and each rule file, every one followed by
//! the project files it imports (`@path`), rewritten from those sources on
//! every sync, for any agent that reads `AGENTS.md`. Nothing here is keyed on
//! an agent. The sources stay the single place a rule is edited; the block
//! says so.
//!
//! An import is resolved the way Claude Code resolves it: relative to the
//! importing file, never inside a code span or fence, at most
//! [`MAX_IMPORT_DEPTH`] hops deep. A file outside the project (`~/…`, or a
//! path that leaves the root) is never copied in, since `AGENTS.md` is
//! usually committed and that file usually is not; its import line is kept
//! as written. Each file appears once, at its first import.
//!
//! Four things are deliberately left out of the block:
//! - an `@AGENTS.md` import line in `CLAUDE.md`, which inside `AGENTS.md`
//!   would only point the file at itself;
//! - a rule a pack projected into `.claude/rules/` when `AGENTS.md` already
//!   carries that rule as the pack's own `atlas-pack` block;
//! - a rule's `paths:` frontmatter is not a filter here (`AGENTS.md` has no
//!   path scoping), so it is shown as an "applies when working on" line;
//! - hooks and permission lists (`.claude/settings.json`) are not
//!   instructions and cannot be mirrored.
//!
//! # Never losing the user's text
//!
//! `AGENTS.md` is the user's file. Everything outside the block is kept byte
//! for byte, line endings included, and a sync that cannot be sure of that
//! leaves the file alone and says why ([`Outcome::Skipped`]):
//! - the markers must form exactly one pair, END after START, each on a line
//!   of its own, with no near-miss marker line anywhere ([`SkipReason::Markers`]);
//! - a source that itself holds a marker line is not mirrored, since the block
//!   would then contain its own end ([`SkipReason::SourceHasMarker`]);
//! - a linked `AGENTS.md` or `CLAUDE.md`, two names for one file, or a
//!   `CLAUDE.md` that only imports `AGENTS.md` is left alone, since writing
//!   would replace the link or feed the block back into its own source;
//! - a read-only `AGENTS.md` is not written;
//! - a write lands through a uniquely named temp file carrying the original
//!   permissions, renamed over the target only if the target still holds what
//!   was read ([`SkipReason::ChangedDuringSync`]), and one sync per project
//!   runs at a time. The re-read and the rename are two calls, so a save that
//!   lands in the instant between them is still replaced; no portable
//!   primitive closes that gap;
//! - `AGENTS.md` is never deleted, except by [`remove`] when the caller says
//!   Atlas created it ([`Outcome::Created`]) and nothing else was added.
//!
//! Pure string functions do the splicing ([`render`], [`upsert_block`],
//! [`remove_block`]); [`sync`] and [`remove`] are the only ones that touch the
//! disk, and they write only when the result differs, so a watcher on the
//! sources never loops on its own output.

use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// Opens the managed block. Readers that index `AGENTS.md` strip the block
/// with [`remove_block`] so its content is not counted twice.
///
/// Settled before release on purpose: renaming it later would strand every
/// block already written under the old name.
pub const BLOCK_START: &str = "<!-- atlas:mirrored-instructions START -->";
/// Closes the managed block.
pub const BLOCK_END: &str = "<!-- atlas:mirrored-instructions END -->";

/// The part both markers share. A comment line holding it that is not exactly
/// a marker is a near miss: an edited, re-spaced or re-indented marker.
const MARKER_TAG: &str = "atlas:mirrored-instructions";

const NOTICE: &str = "<!-- Mirrored by Atlas from CLAUDE.md, .claude/ and the files they import, \
for agents that read AGENTS.md. Edit those files; this block is rewritten whenever they change. -->";

const AGENTS_MD: &str = "AGENTS.md";
const CLAUDE_MD: &str = "CLAUDE.md";
/// `CLAUDE.md` inside `.claude/`, which Claude Code also reads.
const DOT_CLAUDE_MD: &str = ".claude/CLAUDE.md";

/// How many hops of `@path` imports are followed, as in Claude Code.
pub const MAX_IMPORT_DEPTH: usize = 5;
const BOM: &str = "\u{feff}";

/// One mirrored file after `CLAUDE.md`: `.claude/CLAUDE.md`, a `.claude/rules`
/// file (frontmatter parsed off), or a file one of those imports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    /// Path relative to the project root, with `/` separators.
    pub rel_path: String,
    /// The `paths:` globs from the frontmatter; empty means always applies.
    pub paths: Vec<String>,
    /// The file without its frontmatter.
    pub body: String,
    /// For a file mirrored because a source imports it (`@path`): that
    /// source's path, relative to the root.
    pub imported_by: Option<String>,
}

/// Why a sync left `AGENTS.md` alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    /// `AGENTS.md`'s markers are not exactly one well-formed pair: a missing,
    /// duplicated, reordered, indented or otherwise edited marker line.
    Markers,
    /// `CLAUDE.md` or a rule has a marker on a line of its own (documenting
    /// this feature in a code fence, say); mirroring it would nest a block.
    SourceHasMarker,
    /// `AGENTS.md` or `CLAUDE.md` is a symlink (or `AGENTS.md` a hard link);
    /// writing would replace the link with a plain file.
    Linked,
    /// `AGENTS.md` and `CLAUDE.md` are the same file, or byte-identical.
    SameFile,
    /// `CLAUDE.md` only imports `AGENTS.md`: the project already keeps one
    /// file for every agent.
    ImportsAgentsMd,
    /// `AGENTS.md` is read-only.
    ReadOnly,
    /// `AGENTS.md` is not UTF-8 text.
    NotText,
    /// `AGENTS.md` changed between the read and the write. The newer content
    /// was kept, and the next sync starts from it.
    ChangedDuringSync,
}

impl fmt::Display for SkipReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Markers => {
                "its mirrored-instructions markers are not exactly one START line followed by \
                 one END line (a marker was edited, indented, duplicated or deleted)"
            }
            Self::SourceHasMarker => {
                "CLAUDE.md or a .claude/rules file has a mirrored-instructions marker on a line \
                 of its own"
            }
            Self::Linked => "AGENTS.md or CLAUDE.md is a link",
            Self::SameFile => "AGENTS.md and CLAUDE.md are the same file, or identical",
            Self::ImportsAgentsMd => "CLAUDE.md only imports AGENTS.md",
            Self::ReadOnly => "AGENTS.md is read-only",
            Self::NotText => "AGENTS.md is not UTF-8 text",
            Self::ChangedDuringSync => "AGENTS.md changed while it was being updated",
        })
    }
}

/// What [`sync`] or [`remove`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// The block was written into an existing `AGENTS.md`.
    Written,
    /// `AGENTS.md` did not exist and was created holding the block. A caller
    /// that remembers this can let [`remove`] delete the file again.
    Created,
    /// The block was removed (nothing left to mirror, or [`remove`]).
    Removed,
    /// `AGENTS.md` already said exactly this; nothing was written.
    Unchanged,
    /// No sources and no block: nothing to do, and no `AGENTS.md` is created.
    NothingToMirror,
    /// `AGENTS.md` was left exactly as it was, for this reason.
    Skipped(SkipReason),
}

/// Parse a rule file: strip a BOM and a leading `---` frontmatter, reading its
/// `paths:` list (block `- "a"` or inline `["a", "b"]` form).
pub fn parse_rule(rel_path: &str, raw: &str) -> Rule {
    let text = normalize(raw);
    let text = text.strip_prefix(BOM).unwrap_or(&text);
    let mut paths = Vec::new();
    let mut body = text;
    if let Some(rest) = text.strip_prefix("---\n") {
        // (end of the frontmatter, start of the body) around the closing `---`.
        let close = if rest.starts_with("---\n") || rest == "---" {
            Some((0, (rest.len()).min(4)))
        } else {
            rest.find("\n---\n")
                .map(|i| (i, i + 5))
                .or_else(|| rest.strip_suffix("\n---").map(|fm| (fm.len(), rest.len())))
        };
        if let Some((fm_end, body_start)) = close {
            paths = frontmatter_paths(&rest[..fm_end]);
            body = &rest[body_start..];
        }
    }
    Rule {
        rel_path: rel_path.to_string(),
        paths,
        body: body.trim_matches('\n').to_string(),
        imported_by: None,
    }
}

fn frontmatter_paths(fm: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_list = false;
    for line in fm.lines() {
        let trimmed = line.trim();
        if let Some(value) = trimmed.strip_prefix("paths:") {
            let value = value.trim();
            if let Some(inline) = value.strip_prefix('[').and_then(|v| v.strip_suffix(']')) {
                out.extend(inline.split(',').map(unquote).filter(|s| !s.is_empty()));
                in_list = false;
            } else {
                in_list = value.is_empty();
            }
            continue;
        }
        if in_list {
            if let Some(item) = trimmed.strip_prefix("- ") {
                let item = unquote(item);
                if !item.is_empty() {
                    out.push(item);
                }
            } else if !trimmed.is_empty() && !line.starts_with(' ') {
                in_list = false;
            }
        }
    }
    out
}

fn unquote(s: &str) -> String {
    s.trim().trim_matches(|c| c == '"' || c == '\'').to_string()
}

/// The block's inner text for these sources, or `None` when there is nothing
/// to mirror. Line endings are `\n`; [`upsert_block`] adapts them to the file.
pub fn render(claude_md: Option<&str>, rules: &[Rule]) -> Option<String> {
    let claude_md = claude_md
        .map(claude_md_body)
        .filter(|s| !s.trim().is_empty());
    let rules: Vec<&Rule> = rules.iter().filter(|r| !r.body.trim().is_empty()).collect();
    if claude_md.is_none() && rules.is_empty() {
        return None;
    }
    let mut out = String::from(NOTICE);
    out.push('\n');
    if let Some(text) = claude_md {
        out.push_str("\n## Mirrored from `CLAUDE.md`\n\n");
        out.push_str(&text);
        out.push('\n');
    }
    for rule in rules {
        match &rule.imported_by {
            Some(by) => out.push_str(&format!(
                "\n## Mirrored from `{}` (imported by `{by}`)\n\n",
                rule.rel_path
            )),
            None => out.push_str(&format!("\n## Mirrored from `{}`\n\n", rule.rel_path)),
        }
        if !rule.paths.is_empty() {
            let globs: Vec<String> = rule.paths.iter().map(|p| format!("`{p}`")).collect();
            out.push_str(&format!(
                "_Applies when working on: {}_\n\n",
                globs.join(", ")
            ));
        }
        out.push_str(&rule.body);
        out.push('\n');
    }
    Some(out)
}

/// A `CLAUDE.md` as mirrored: `\n` line endings, no BOM, and no
/// `@AGENTS.md` import line, which inside `AGENTS.md` would point the file at
/// itself.
fn claude_md_body(text: &str) -> String {
    let text = normalize(text);
    let kept: Vec<&str> = text
        .trim_start_matches(BOM)
        .split('\n')
        .filter(|l| !is_agents_md_import(l))
        .collect();
    kept.join("\n").trim_matches('\n').to_string()
}

// ── Imports ─────────────────────────────────────────────────────────────────

/// The `@path` tokens in `text` that Claude Code would treat as imports: a
/// whitespace-separated word starting with `@`, outside code spans and fenced
/// code blocks.
pub fn import_tokens(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut fence: Option<&str> = None;
    for line in text.lines() {
        let trimmed = line.trim_start();
        let opener = ["```", "~~~"].into_iter().find(|f| trimmed.starts_with(f));
        match (fence, opener) {
            (None, Some(f)) => {
                fence = Some(f);
                continue;
            }
            (Some(open), Some(f)) if open == f => {
                fence = None;
                continue;
            }
            (Some(_), _) => continue,
            (None, None) => {}
        }
        // Blank out inline code spans.
        let mut plain = String::with_capacity(line.len());
        let mut in_code = false;
        for ch in line.chars() {
            if ch == '`' {
                in_code = !in_code;
                plain.push(' ');
            } else {
                plain.push(if in_code { ' ' } else { ch });
            }
        }
        for word in plain.split_whitespace() {
            if let Some(path) = word.strip_prefix('@').filter(|p| !p.is_empty()) {
                out.push(path.to_string());
            }
        }
    }
    out
}

/// The file `token` imports from a file in `from_dir`, canonical, when it is
/// a file inside `root` (canonical). A token that names nothing is not an
/// import (an `@mention`, say); one ending in punctuation is retried without
/// it, for "see @docs/x.md.".
fn resolve_import(root: &Path, from_dir: &Path, token: &str) -> Option<PathBuf> {
    if token.starts_with('~') {
        return None;
    }
    let candidates = [
        token,
        token.trim_end_matches(['.', ',', ';', ':', '!', '?', ')']),
    ];
    candidates.into_iter().find_map(|t| {
        let path = from_dir.join(t);
        let canon = fs::canonicalize(path).ok()?;
        (canon.starts_with(root) && canon.is_file()).then_some(canon)
    })
}

/// One mirrored source, before its imports are followed.
struct Source {
    rule: Rule,
    /// Canonical path of the file, when it is on disk.
    path: Option<PathBuf>,
}

/// `sources` in order, each followed by the files it imports, depth first,
/// [`MAX_IMPORT_DEPTH`] hops at most. A file is mirrored once, at its first
/// import, and never when it is itself a source or in `exclude` (`AGENTS.md`).
fn with_imports(root: &Path, sources: Vec<Source>, exclude: &[PathBuf]) -> Vec<Rule> {
    let Ok(root) = fs::canonicalize(root) else {
        return sources.into_iter().map(|s| s.rule).collect();
    };
    let mut seen: Vec<PathBuf> = exclude.to_vec();
    seen.extend(sources.iter().filter_map(|s| s.path.clone()));
    let mut out = Vec::new();
    for source in sources {
        let from = source.path.clone();
        let text = source.rule.body.clone();
        let by = source.rule.rel_path.clone();
        out.push(source.rule);
        if let Some(from) = from {
            follow_imports(&root, &from, &text, &by, 1, &mut seen, &mut out);
        }
    }
    out
}

fn follow_imports(
    root: &Path,
    from: &Path,
    text: &str,
    by: &str,
    depth: usize,
    seen: &mut Vec<PathBuf>,
    out: &mut Vec<Rule>,
) {
    if depth > MAX_IMPORT_DEPTH {
        return;
    }
    let dir = from.parent().unwrap_or(root);
    for token in import_tokens(text) {
        let Some(path) = resolve_import(root, dir, &token) else {
            continue;
        };
        if seen.contains(&path) {
            continue;
        }
        seen.push(path.clone());
        let (Some(rel), Ok(raw)) = (rel_path(root, &path), fs::read_to_string(&path)) else {
            continue;
        };
        let body = normalize(&raw)
            .trim_start_matches(BOM)
            .trim_matches('\n')
            .to_string();
        out.push(Rule {
            rel_path: rel.clone(),
            paths: Vec::new(),
            body: body.clone(),
            imported_by: Some(by.to_string()),
        });
        follow_imports(root, &path, &body, &rel, depth + 1, seen, out);
    }
}

/// Every file a sync of `root` would mirror because a source imports it,
/// canonical. A watcher watches these too, so editing an imported file
/// updates the block.
pub fn imported_files(root: &Path) -> Vec<PathBuf> {
    let Ok(canon) = fs::canonicalize(root) else {
        return Vec::new();
    };
    collect_sources(root, &[])
        .into_iter()
        .filter(|r| r.imported_by.is_some())
        .map(|r| canon.join(&r.rel_path))
        .collect()
}

/// `CLAUDE.md`'s text, `.claude/CLAUDE.md` and the rules (minus `skip`), each
/// followed by what it imports. `CLAUDE.md` comes back separately, since
/// [`render`] heads the block with it.
fn read_sources(root: &Path, skip: &[String]) -> io::Result<(Option<String>, Vec<Rule>)> {
    let claude_md = match fs::read_to_string(root.join(CLAUDE_MD)) {
        Ok(text) => Some(text),
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => return Err(e),
    };
    let mut rules = collect_sources(root, skip);
    // `CLAUDE.md` is rendered from its own text; the list keeps only what it
    // imports.
    rules.retain(|r| r.rel_path != CLAUDE_MD || r.imported_by.is_some());
    Ok((claude_md, rules))
}

fn collect_sources(root: &Path, skip: &[String]) -> Vec<Rule> {
    let canonical = |rel: &str| fs::canonicalize(root.join(rel)).ok();
    let mut sources = Vec::new();
    for rel in [CLAUDE_MD, DOT_CLAUDE_MD] {
        if let Ok(text) = fs::read_to_string(root.join(rel)) {
            sources.push(Source {
                rule: Rule {
                    rel_path: rel.to_string(),
                    paths: Vec::new(),
                    body: claude_md_body(&text),
                    imported_by: None,
                },
                path: canonical(rel),
            });
        }
    }
    for rule in read_rules(root, skip) {
        let path = canonical(&rule.rel_path);
        sources.push(Source { rule, path });
    }
    let exclude: Vec<PathBuf> = canonical(AGENTS_MD).into_iter().collect();
    with_imports(root, sources, &exclude)
}

// ── Markers ─────────────────────────────────────────────────────────────────

/// What a single line is, as far as the markers go.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MarkerLine {
    Start,
    End,
    /// Looks like a marker but is not exactly one: indented, trailing
    /// whitespace, re-spaced, re-cased.
    NearMiss,
}

/// Classify one line's content (no line ending, no BOM). A marker quoted inside
/// a sentence is not a marker line; only a line that is a marker once trimmed,
/// or a comment carrying the marker tag, counts.
fn classify(line: &str) -> Option<MarkerLine> {
    if line == BLOCK_START {
        return Some(MarkerLine::Start);
    }
    if line == BLOCK_END {
        return Some(MarkerLine::End);
    }
    let trimmed = line.trim();
    let near = trimmed == BLOCK_START
        || trimmed == BLOCK_END
        || (trimmed.starts_with("<!--") && trimmed.to_ascii_lowercase().contains(MARKER_TAG));
    near.then_some(MarkerLine::NearMiss)
}

/// One line of a text: `start..content_end` is its content, without the line
/// ending.
#[derive(Debug, Clone, Copy)]
struct Line {
    start: usize,
    content_end: usize,
}

/// The lines of `text`, a leading BOM excluded from the first one.
fn lines(text: &str) -> Vec<Line> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut at = bom_len(text);
    while at < bytes.len() {
        let (content_end, end) = match text[at..].find('\n') {
            Some(i) => {
                let nl = at + i;
                let content_end = if nl > at && bytes[nl - 1] == b'\r' {
                    nl - 1
                } else {
                    nl
                };
                (content_end, nl + 1)
            }
            None => (bytes.len(), bytes.len()),
        };
        out.push(Line {
            start: at,
            content_end,
        });
        at = end;
    }
    out
}

fn bom_len(text: &str) -> usize {
    if text.starts_with(BOM) {
        BOM.len()
    } else {
        0
    }
}

/// The block in `text`: (start of the START line, end of the END marker before
/// its line ending). `Ok(None)` when there is no marker line at all;
/// `Err(Markers)` for anything but exactly one clean pair.
fn find_block(text: &str) -> Result<Option<(usize, usize)>, SkipReason> {
    let mut start = None;
    let mut end = None;
    for line in lines(text) {
        match classify(&text[line.start..line.content_end]) {
            None => {}
            Some(MarkerLine::Start) if start.is_none() && end.is_none() => start = Some(line.start),
            Some(MarkerLine::End) if start.is_some() && end.is_none() => {
                end = Some(line.content_end)
            }
            Some(_) => return Err(SkipReason::Markers),
        }
    }
    match (start, end) {
        (None, None) => Ok(None),
        (Some(s), Some(e)) => Ok(Some((s, e))),
        _ => Err(SkipReason::Markers),
    }
}

/// Whether `text` has a marker, or a near miss, on a line of its own.
pub fn has_marker_line(text: &str) -> bool {
    lines(text)
        .iter()
        .any(|l| classify(&text[l.start..l.content_end]).is_some())
}

// ── Line endings ────────────────────────────────────────────────────────────

/// The line ending of the last line that ends before `pos`, or the file's
/// dominant one when none does (`\n` for a file without line endings).
fn eol_before(text: &str, pos: usize) -> &'static str {
    match text[..pos].rfind('\n') {
        Some(i) if i > 0 && text.as_bytes()[i - 1] == b'\r' => "\r\n",
        Some(_) => "\n",
        None => dominant_eol(text),
    }
}

fn dominant_eol(text: &str) -> &'static str {
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count() - crlf;
    if crlf > lf {
        "\r\n"
    } else {
        "\n"
    }
}

/// Length of the line ending at `pos`: 2 for `\r\n`, 1 for `\n`, else 0.
fn eol_len_at(text: &str, pos: usize) -> usize {
    let rest = &text.as_bytes()[pos..];
    if rest.starts_with(b"\r\n") {
        2
    } else if rest.starts_with(b"\n") {
        1
    } else {
        0
    }
}

/// `text` minus its last line ending when that ends a blank line; `text`
/// itself otherwise.
fn strip_trailing_blank_line(text: &str) -> &str {
    let eol = if text.ends_with("\r\n") {
        2
    } else if text.ends_with('\n') {
        1
    } else {
        return text;
    };
    let rest = &text[..text.len() - eol];
    if rest.ends_with('\n') {
        rest
    } else {
        text
    }
}

fn starts_with_eol(text: &str) -> bool {
    eol_len_at(text, 0) > 0
}

fn block_text(inner: &str, eol: &str) -> String {
    let inner = inner.trim_end_matches('\n').replace('\n', eol);
    format!("{BLOCK_START}{eol}{inner}{eol}{BLOCK_END}")
}

fn normalize(s: &str) -> String {
    s.replace("\r\n", "\n")
}

// ── Splicing ────────────────────────────────────────────────────────────────

/// `existing` with the managed block set to `inner`: replaced in place when
/// present, appended after a blank line otherwise. Only the block's bytes
/// change. The block takes the line ending of the line just before it (the
/// file's dominant one when nothing precedes it), and every byte outside it
/// (BOM, mixed line endings, trailing whitespace) is kept as it was.
///
/// `Err` when the markers are not one clean pair, or `inner` would put a
/// marker line inside the block: the caller must leave the file alone.
pub fn upsert_block(existing: &str, inner: &str) -> Result<String, SkipReason> {
    if has_marker_line(inner) {
        return Err(SkipReason::SourceHasMarker);
    }
    let out = match find_block(existing)? {
        Some((start, end)) => {
            let block = block_text(inner, eol_before(existing, start));
            format!("{}{block}{}", &existing[..start], &existing[end..])
        }
        None => {
            let eol = eol_before(existing, existing.len());
            let mut out = existing.to_string();
            if existing.len() > bom_len(existing) {
                if !existing.ends_with('\n') {
                    out.push_str(eol);
                }
                // The separating blank line; `remove_block` takes it back out.
                out.push_str(eol);
            }
            out.push_str(&block_text(inner, eol));
            out.push_str(eol);
            out
        }
    };
    // Defense in depth: whatever happened above, the result holds one block.
    match find_block(&out) {
        Ok(Some(_)) => Ok(out),
        _ => Err(SkipReason::SourceHasMarker),
    }
}

/// `existing` without the managed block (and the blank line [`upsert_block`]
/// put before it). Text without a clean block (none, or markers that are not
/// one well-formed pair) comes back unchanged.
pub fn remove_block(existing: &str) -> String {
    match find_block(existing) {
        Ok(Some(span)) => cut_block(existing, span),
        _ => existing.to_string(),
    }
}

fn cut_block(text: &str, (start, end): (usize, usize)) -> String {
    let before = &text[..start];
    let mut after = &text[end + eol_len_at(text, end)..];
    let before = if before.len() == bom_len(text) {
        // The block opened the file: a blank line after it was the separator.
        if starts_with_eol(after) {
            after = &after[eol_len_at(after, 0)..];
        }
        before
    } else if after.is_empty() || starts_with_eol(after) {
        strip_trailing_blank_line(before)
    } else {
        before
    };
    format!("{before}{after}")
}

// ── Sources ─────────────────────────────────────────────────────────────────

/// Rule files under `<root>/.claude/rules`, sorted by path, minus `skip`
/// (paths relative to `root`, `/`-separated).
pub fn read_rules(root: &Path, skip: &[String]) -> Vec<Rule> {
    let mut files = Vec::new();
    collect_md(&root.join(".claude").join("rules"), &mut files);
    let mut rules: Vec<Rule> = files
        .into_iter()
        .filter_map(|path| {
            let rel = rel_path(root, &path)?;
            if skip.iter().any(|s| s == &rel) {
                return None;
            }
            let raw = fs::read_to_string(&path).ok()?;
            Some(parse_rule(&rel, &raw))
        })
        .collect();
    rules.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    rules
}

fn collect_md(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(t) if t.is_dir() => collect_md(&path, out),
            Ok(_)
                if path
                    .extension()
                    .is_some_and(|e| e.eq_ignore_ascii_case("md")) =>
            {
                out.push(path)
            }
            _ => {}
        }
    }
}

fn rel_path(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let parts: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    Some(parts.join("/"))
}

/// The marker a pack writes around a rule it appends to `AGENTS.md`. Must
/// match `rule_marker_start` in `src-tauri/src/commands/skills.rs`, which
/// asserts that it does.
pub fn pack_rule_marker(pack: &str, rule: &str) -> String {
    format!("<!-- atlas-pack:{pack}:{rule} START -->")
}

/// A rule's marker name derived from its file stem, the way the pack
/// installer's `sanitize_name` derives it from the component name, which
/// `skills.rs` asserts.
pub fn pack_rule_name(stem: &str) -> String {
    let mut out = String::with_capacity(stem.len());
    let mut prev_dash = false;
    for ch in stem.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' {
            out.push(ch);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches(['.', '-']).to_string()
}

/// A ledger entry's string field. The ledger is written camelCase; the
/// snake_case spelling is accepted too.
fn ledger_str<'a>(entry: &'a serde_json::Value, camel: &str, snake: &str) -> Option<&'a str> {
    entry
        .get(camel)
        .or_else(|| entry.get(snake))
        .and_then(|v| v.as_str())
}

/// Rule files a pack projected into `.claude/rules` that `agents_md` already
/// carries as that pack's own `atlas-pack` block, so mirroring them would say
/// the same rule twice. A rule a pack delivered only to `.claude/rules` is
/// mirrored like any other. Reads the ledger at
/// `.atlas/packs/.pack-projections.json`; a missing or unreadable ledger means
/// none.
pub fn pack_rules_in_agents_md(root: &Path, agents_md: &str) -> Vec<String> {
    let path = atlas_profile::dir_in(root)
        .join("packs")
        .join(".pack-projections.json");
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(ledger) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Vec::new();
    };
    let Some(packs) = ledger.get("projections").and_then(|p| p.as_object()) else {
        return Vec::new();
    };
    let pack_markers: Vec<&str> = lines(agents_md)
        .iter()
        .map(|l| agents_md[l.start..l.content_end].trim())
        .filter(|l| l.starts_with("<!-- atlas-pack:"))
        .collect();
    let mut out = Vec::new();
    for (pack, tools) in packs {
        let entries: Vec<&serde_json::Value> = tools
            .as_object()
            .into_iter()
            .flat_map(|t| t.values())
            .filter_map(|e| e.as_array())
            .flatten()
            .collect();
        for entry in &entries {
            let Some(target) = ledger_str(entry, "targetRel", "target_rel") else {
                continue;
            };
            let target = target.replace('\\', "/");
            if !target.starts_with(".claude/rules/") {
                continue;
            }
            // The rule's name in an `AGENTS.md` block: what the same pack
            // recorded when it appended this component there, else what it
            // would derive from the file name.
            let rel = ledger_str(entry, "relPath", "rel_path");
            let mut names: Vec<String> = entries
                .iter()
                .filter(|e| ledger_str(e, "mode", "mode") == Some("append"))
                .filter(|e| rel.is_some() && ledger_str(e, "relPath", "rel_path") == rel)
                .filter_map(|e| ledger_str(e, "leaf", "leaf").map(str::to_string))
                .collect();
            if let Some(stem) = Path::new(&target).file_stem().and_then(|s| s.to_str()) {
                names.push(pack_rule_name(stem));
            }
            if names
                .iter()
                .any(|name| pack_markers.contains(&pack_rule_marker(pack, name).as_str()))
            {
                out.push(target);
            }
        }
    }
    out
}

/// Whether `CLAUDE.md` says nothing but "read `AGENTS.md`" (an `@AGENTS.md`
/// import, the usual way to keep one file for every agent).
fn only_imports_agents_md(claude_md: &str) -> bool {
    is_agents_md_import(claude_md.trim_start_matches(BOM))
}

/// Whether one line (or a whole trimmed text) is an `@AGENTS.md` import.
fn is_agents_md_import(line: &str) -> bool {
    matches!(line.trim(), "@AGENTS.md" | "@./AGENTS.md")
}

// ── Disk ────────────────────────────────────────────────────────────────────

fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink())
}

/// Whether `a` and `b` name one existing file: the same canonical path (a
/// symlink, or a differently spelled path), or the same file identity (a hard
/// link): the inode on Unix, the volume and file index on Windows.
pub fn same_file(a: &Path, b: &Path) -> bool {
    if let (Ok(ca), Ok(cb)) = (fs::canonicalize(a), fs::canonicalize(b)) {
        if ca == cb {
            return true;
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let (Ok(ma), Ok(mb)) = (fs::metadata(a), fs::metadata(b)) {
            return ma.dev() == mb.dev() && ma.ino() == mb.ino();
        }
    }
    #[cfg(windows)]
    {
        if let (Some(ia), Some(ib)) = (windows::file_info(a), windows::file_info(b)) {
            return ia.id == ib.id;
        }
    }
    false
}

/// Whether renaming over `path` would cut a hard link to it.
fn is_hard_linked(path: &Path) -> bool {
    if !fs::symlink_metadata(path).is_ok_and(|m| m.is_file()) {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        fs::symlink_metadata(path).is_ok_and(|m| m.nlink() > 1)
    }
    #[cfg(windows)]
    {
        windows::file_info(path).is_some_and(|info| info.links > 1)
    }
    #[cfg(not(any(unix, windows)))]
    {
        false
    }
}

/// The link count and file identity are not on stable Rust for Windows
/// (`windows_by_handle`), so they come from `GetFileInformationByHandle`.
#[cfg(windows)]
mod windows {
    use std::fs::File;
    use std::os::windows::io::AsRawHandle;
    use std::path::Path;

    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    pub(super) struct FileInfo {
        /// Volume serial number and 64-bit file index: one per file, shared by
        /// its hard links.
        pub id: (u32, u64),
        pub links: u32,
    }

    pub(super) fn file_info(path: &Path) -> Option<FileInfo> {
        let file = File::open(path).ok()?;
        // SAFETY: an all-zero BY_HANDLE_FILE_INFORMATION is a valid value of
        // a plain C struct; the call fills it in.
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: the handle is open for the duration of the call (`file` is
        // alive) and `info` is a valid, writable out-pointer.
        let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) };
        (ok != 0).then(|| FileInfo {
            id: (
                info.dwVolumeSerialNumber,
                (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
            ),
            links: info.nNumberOfLinks,
        })
    }
}

fn read_opt(path: &Path) -> io::Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// One lock per project root, so two syncs of one `AGENTS.md` (a watcher event
/// and a settings toggle, say) never interleave.
fn root_lock(root: &Path) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let key = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let mut map = LOCKS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    map.entry(key).or_default().clone()
}

/// A temp file next to `path`, unique per process and per call.
fn temp_path(path: &Path) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    path.with_file_name(format!(".{name}.{}.{n}.atlas-tmp", std::process::id()))
}

/// Replace `path` with `next`, but only if it still holds `original` (`None`:
/// is still absent). With `delete`, the file is deleted instead (it is empty
/// and Atlas created it). `before_commit` runs between the temp write and the
/// re-check; tests use it to stand in for an editor saving at the worst moment.
fn commit(
    path: &Path,
    original: Option<&[u8]>,
    next: &str,
    delete: bool,
    before_commit: &mut dyn FnMut(),
) -> io::Result<Option<SkipReason>> {
    let perms = match fs::metadata(path) {
        Ok(m) if m.permissions().readonly() => return Ok(Some(SkipReason::ReadOnly)),
        Ok(m) => Some(m.permissions()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => return Err(e),
    };
    let still_as_read =
        || -> io::Result<bool> { Ok(read_opt(path)?.as_deref() == original && !is_symlink(path)) };
    if delete {
        before_commit();
        if !still_as_read()? {
            return Ok(Some(SkipReason::ChangedDuringSync));
        }
        return fs::remove_file(path).map(|()| None);
    }

    let tmp = temp_path(path);
    let written = (|| -> io::Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        file.write_all(next.as_bytes())?;
        file.sync_all()?;
        drop(file);
        if let Some(perms) = perms {
            fs::set_permissions(&tmp, perms)?;
        }
        Ok(())
    })();
    let result = written.and_then(|()| {
        before_commit();
        if !still_as_read()? {
            return Ok(Some(SkipReason::ChangedDuringSync));
        }
        fs::rename(&tmp, path).map(|()| None)
    });
    if !matches!(result, Ok(None)) {
        let _ = fs::remove_file(&tmp);
    }
    result
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Mirror,
    /// Take the block out; `true`: delete the file if that leaves it empty.
    Remove(bool),
}

/// Bring `<root>/AGENTS.md`'s managed block in line with `CLAUDE.md`,
/// `.claude/CLAUDE.md`, `.claude/rules/` and what they import. Writes only
/// when the content changes, never creates an `AGENTS.md` just to hold
/// nothing, never deletes one, and leaves the file alone (saying why) whenever
/// it cannot keep every byte outside the block as it was.
pub fn sync(root: &Path) -> io::Result<Outcome> {
    run(root, Mode::Mirror, &mut || {})
}

/// Take the managed block back out of `<root>/AGENTS.md` (the setting was
/// switched off), under the same checks as [`sync`]. The file is kept, even
/// when that leaves it empty, unless `delete_if_emptied`: pass that only for a
/// file a sync reported as [`Outcome::Created`], so an empty `AGENTS.md` the
/// user made is never deleted.
pub fn remove(root: &Path, delete_if_emptied: bool) -> io::Result<Outcome> {
    run(root, Mode::Remove(delete_if_emptied), &mut || {})
}

fn run(root: &Path, mode: Mode, before_commit: &mut dyn FnMut()) -> io::Result<Outcome> {
    let lock = root_lock(root);
    let _guard = lock
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let skipped = |reason: SkipReason| -> io::Result<Outcome> { Ok(Outcome::Skipped(reason)) };

    let agents_path = root.join(AGENTS_MD);
    let claude_path = root.join(CLAUDE_MD);
    if is_symlink(&agents_path) || is_hard_linked(&agents_path) {
        return skipped(SkipReason::Linked);
    }
    let original = read_opt(&agents_path)?;
    let existing = match original.as_deref().map(std::str::from_utf8) {
        None => None,
        Some(Ok(text)) => Some(text),
        Some(Err(_)) => return skipped(SkipReason::NotText),
    };

    let inner = match mode {
        Mode::Remove(_) => None,
        Mode::Mirror => {
            if is_symlink(&claude_path) {
                return skipped(SkipReason::Linked);
            }
            if existing.is_some() && same_file(&agents_path, &claude_path) {
                return skipped(SkipReason::SameFile);
            }
            if existing.is_some() && same_file(&agents_path, &root.join(DOT_CLAUDE_MD)) {
                return skipped(SkipReason::SameFile);
            }
            let skip = pack_rules_in_agents_md(root, existing.unwrap_or(""));
            let (claude_md, rules) = read_sources(root, &skip)?;
            // A byte-identical copy needs no mirror either, and catches a hard
            // link whose identity could not be read.
            if existing.is_some_and(|text| !text.trim().is_empty())
                && existing == claude_md.as_deref()
            {
                return skipped(SkipReason::SameFile);
            }
            if claude_md.as_deref().is_some_and(only_imports_agents_md) {
                return skipped(SkipReason::ImportsAgentsMd);
            }
            if claude_md.as_deref().is_some_and(has_marker_line)
                || rules.iter().any(|r| has_marker_line(&r.body))
            {
                return skipped(SkipReason::SourceHasMarker);
            }
            render(claude_md.as_deref(), &rules)
        }
    };

    let (next, outcome) = match (inner, existing) {
        (Some(inner), text) => match upsert_block(text.unwrap_or(""), &inner) {
            Ok(next) if text.is_none() => (next, Outcome::Created),
            Ok(next) => (next, Outcome::Written),
            Err(reason) => return skipped(reason),
        },
        (None, Some(text)) => match find_block(text) {
            Ok(Some(span)) => (cut_block(text, span), Outcome::Removed),
            Ok(None) => return Ok(Outcome::NothingToMirror),
            Err(reason) => return skipped(reason),
        },
        (None, None) => return Ok(Outcome::NothingToMirror),
    };
    if existing == Some(next.as_str()) {
        return Ok(Outcome::Unchanged);
    }
    let delete = next.is_empty() && matches!(mode, Mode::Remove(true));
    match commit(
        &agents_path,
        original.as_deref(),
        &next,
        delete,
        before_commit,
    )? {
        Some(reason) => skipped(reason),
        None => Ok(outcome),
    }
}

/// Whether a changed path is one [`sync`] reads, relative to `root`. Lets a
/// watcher ignore everything else, `AGENTS.md` and the temp files included, so
/// its own write never triggers another sync.
pub fn is_source_path(root: &Path, path: &Path) -> bool {
    let Some(rel) = rel_path(root, path) else {
        return false;
    };
    // Any case: on a case-insensitive disk `claude.md` is what `sync` reads
    // as `CLAUDE.md`, and the watcher reports the name as it is on disk.
    rel.eq_ignore_ascii_case(CLAUDE_MD)
        || rel.eq_ignore_ascii_case(DOT_CLAUDE_MD)
        || rel == format!("{}/packs/.pack-projections.json", atlas_profile::dir_name())
        || (rel.starts_with(".claude/rules/") && rel.to_ascii_lowercase().ends_with(".md"))
}

/// One directory a watcher on a project's sources should watch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchTarget {
    pub path: PathBuf,
    pub recursive: bool,
}

/// What to watch so every source change is seen, and nothing more: the root
/// and `.claude` non-recursively (enough to see `CLAUDE.md` change and
/// `.claude`/`rules` appear), `.claude/rules` recursively, and the pack
/// ledger's directory non-recursively. Never all of `.claude/`, which can hold
/// whole checkouts (`.claude/worktrees/`). In this order, so a parent is
/// watched before the child it reveals.
pub fn watch_targets(root: &Path) -> Vec<WatchTarget> {
    let target = |path: PathBuf, recursive| WatchTarget { path, recursive };
    vec![
        target(root.to_path_buf(), false),
        target(root.join(".claude"), false),
        target(root.join(".claude").join("rules"), true),
        target(atlas_profile::dir_in(root).join("packs"), false),
    ]
}

/// Whether a changed path is one of the [`watch_targets`] directories (or the
/// `.atlas` directory that holds the ledger's), so a watcher armed before it
/// existed should arm it now.
pub fn is_watch_dir_path(root: &Path, path: &Path) -> bool {
    let Some(rel) = rel_path(root, path) else {
        return false;
    };
    let atlas = atlas_profile::dir_name();
    rel == ".claude" || rel == ".claude/rules" || rel == atlas || rel == format!("{atlas}/packs")
}

#[cfg(test)]
mod tests;
