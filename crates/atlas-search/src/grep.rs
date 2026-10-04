//! `grep`: the ripgrep engine over the session root (spec 05 §5.2–5.8).

use std::fs::Metadata;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::Relaxed};
use std::sync::{Mutex, PoisonError};
use std::time::UNIX_EPOCH;

use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{
    BinaryDetection, MmapChoice, Searcher, SearcherBuilder, Sink, SinkContext, SinkContextKind,
    SinkMatch,
};
use ignore::WalkState;

use crate::walk::{self, DenyList, WalkSpec, DEFAULT_DENY_GLOBS, MAX_FILE_BYTES};
use crate::{CancelToken, SearchError};

/// Matching lines kept per file in content mode; the rest are only counted.
pub const PER_FILE_LINE_CAP: usize = 20;
/// Longest line text returned, in chars, centred on the first match.
pub const LINE_CLIP_CHARS: usize = 300;
/// Past this many matching lines (and a full page), the walk stops.
pub const HARD_MATCH_CAP: usize = 10_000;
/// Largest page a request may ask for.
pub const MAX_LIMIT: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputMode {
    /// Matching file paths (the default; the cheapest answer).
    FilesWithMatches,
    /// Matching lines, with optional context.
    Content,
    /// Matching-line counts per file.
    Count,
}

#[derive(Debug, Clone)]
pub struct GrepRequest {
    /// Session root (canonical); nothing outside it is read.
    pub root: PathBuf,
    /// File or dir under root.
    pub path: Option<PathBuf>,
    pub pattern: String,
    /// Include globs; "!x" excludes.
    pub globs: Vec<String>,
    /// ripgrep type name.
    pub file_type: Option<String>,
    pub mode: OutputMode,
    /// None = smart case.
    pub case_insensitive: Option<bool>,
    pub literal: bool,
    pub word: bool,
    pub multiline: bool,
    pub before: usize,
    pub after: usize,
    /// None = 100 files / 50 matching lines.
    pub limit: Option<usize>,
    pub offset: usize,
    pub include_ignored: bool,
    /// Secrets; applied unless the path targets the file explicitly.
    pub deny_globs: Vec<String>,
}

impl GrepRequest {
    /// A files-mode, smart-case request over `root` with the default deny list.
    pub fn new(root: impl Into<PathBuf>, pattern: impl Into<String>) -> Self {
        Self {
            root: root.into(),
            path: None,
            pattern: pattern.into(),
            globs: Vec::new(),
            file_type: None,
            mode: OutputMode::FilesWithMatches,
            case_insensitive: None,
            literal: false,
            word: false,
            multiline: false,
            before: 0,
            after: 0,
            limit: None,
            offset: 0,
            include_ignored: false,
            deny_globs: DEFAULT_DENY_GLOBS.iter().map(ToString::to_string).collect(),
        }
    }

    /// The page size: `limit`, or 100 files / 50 matching lines, within 1..=500.
    pub fn page_limit(&self) -> usize {
        let default = match self.mode {
            OutputMode::Content => 50,
            OutputMode::FilesWithMatches | OutputMode::Count => 100,
        };
        self.limit.unwrap_or(default).clamp(1, MAX_LIMIT)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineHit {
    pub line: u64,
    pub text: String,
    pub is_match: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileHit {
    /// Path relative to the session root, `/`-separated.
    pub rel: String,
    pub mtime_ms: i64,
    /// Matching lines in the file (files mode stops at the first: 1).
    pub matches: u32,
    /// Content mode only: at most [`PER_FILE_LINE_CAP`] matching lines plus
    /// their context, in line order.
    pub lines: Vec<LineHit>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GrepResult {
    /// Every file with a hit, sorted mtime desc, then rel asc. Unpaged: the
    /// formatter applies `offset`/`limit`.
    pub files: Vec<FileHit>,
    pub total_files: usize,
    pub total_matches: usize,
    pub searched_files: usize,
    /// Files over 10 MiB, skipped unread.
    pub skipped_large: usize,
    /// Cancelled or deadline hit.
    pub partial: bool,
    /// The walk stopped at [`HARD_MATCH_CAP`]; totals are lower bounds.
    pub match_cap_hit: bool,
}

/// Search file contents under `req.root`. Never panics on file content;
/// a pattern the engine cannot compile is a [`SearchError::Regex`] that says
/// what to change.
pub fn grep(req: &GrepRequest, cancel: &CancelToken) -> Result<GrepResult, SearchError> {
    let matcher = build_matcher(req)?;
    let (root, start) = walk::resolve(&req.root, req.path.as_deref())?;
    let deny = DenyList::new(&req.deny_globs)?;
    let shared = Shared {
        req,
        root: &root,
        matcher: &matcher,
        cancel,
        deny: &deny,
        hits: Mutex::new(Vec::new()),
        matches: AtomicUsize::new(0),
        entries: AtomicUsize::new(0),
        wanted: req.offset.saturating_add(req.page_limit()),
        searched: AtomicUsize::new(0),
        skipped_large: AtomicUsize::new(0),
        stopped: AtomicBool::new(false),
        cap_hit: AtomicBool::new(false),
    };

    if start.is_file() {
        // Named explicitly: no ignore rules, no deny list, and a binary file
        // is searched with NULs read as line ends (ripgrep's semantics).
        let mut searcher = build_searcher(req, true);
        if let Ok(meta) = std::fs::metadata(&start) {
            shared.search_file(&mut searcher, &start, &meta, true);
        }
    } else {
        let spec = WalkSpec {
            root: &root,
            start: &start,
            include_ignored: req.include_ignored,
            globs: &req.globs,
            file_type: req.file_type.as_deref(),
        };
        walk::parallel_walker(&spec)?.run(|| {
            let mut searcher = build_searcher(req, false);
            let shared = &shared;
            Box::new(move |entry| {
                if shared.should_stop() {
                    return WalkState::Quit;
                }
                let Ok(entry) = entry else {
                    return WalkState::Continue;
                };
                if !entry.file_type().is_some_and(|t| t.is_file()) {
                    return WalkState::Continue;
                }
                if let Ok(meta) = entry.metadata() {
                    shared.search_file(&mut searcher, entry.path(), &meta, false);
                }
                WalkState::Continue
            })
        });
    }

    let mut files = shared
        .hits
        .into_inner()
        .unwrap_or_else(PoisonError::into_inner);
    files.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms).then_with(|| a.rel.cmp(&b.rel)));
    Ok(GrepResult {
        total_files: files.len(),
        total_matches: files.iter().map(|f| f.matches as usize).sum(),
        files,
        searched_files: shared.searched.into_inner(),
        skipped_large: shared.skipped_large.into_inner(),
        partial: shared.stopped.into_inner(),
        match_cap_hit: shared.cap_hit.into_inner(),
    })
}

fn build_matcher(req: &GrepRequest) -> Result<RegexMatcher, SearchError> {
    let mut builder = RegexMatcherBuilder::new();
    match req.case_insensitive {
        None => builder.case_smart(true),
        Some(yes) => builder.case_insensitive(yes),
    };
    builder
        .fixed_strings(req.literal)
        .word(req.word)
        // `^`/`$` match at line boundaries, as in ripgrep.
        .multi_line(true)
        .dot_matches_new_line(req.multiline)
        // A pattern can never match NUL: walked binaries stop at the first one.
        .ban_byte(Some(b'\0'))
        // Reject pathological model-supplied patterns at compile time.
        .size_limit(32 << 20)
        .dfa_size_limit(64 << 20);
    if !req.multiline {
        // The inner-literal fast path (spec 05 §1 #4) needs this.
        builder.line_terminator(Some(b'\n'));
    }
    builder.build(&req.pattern).map_err(|e| regex_error(&e))
}

/// The engine's message cut to its one useful line, plus what to do instead.
fn regex_error(err: &grep_regex::Error) -> SearchError {
    let text = err.to_string();
    let detail = text
        .lines()
        .map(str::trim)
        .find_map(|line| line.strip_prefix("error:"))
        .map(str::trim)
        .or_else(|| text.lines().map(str::trim).find(|l| !l.is_empty()))
        .unwrap_or("invalid pattern");
    SearchError::Regex(format!(
        "{detail}. Rust regex syntax: no look-around or backreferences; escape literal ( ) [ ] {{ }} with \\, or set literal=true."
    ))
}

fn build_searcher(req: &GrepRequest, explicit_file: bool) -> Searcher {
    let (before, after) = match req.mode {
        OutputMode::Content => (req.before.min(10), req.after.min(10)),
        OutputMode::FilesWithMatches | OutputMode::Count => (0, 0),
    };
    SearcherBuilder::new()
        .line_number(true)
        .multi_line(req.multiline)
        .before_context(before)
        .after_context(after)
        .binary_detection(if explicit_file {
            BinaryDetection::convert(b'\0')
        } else {
            BinaryDetection::quit(b'\0')
        })
        // Never mmap: an agent truncating a mapped file would SIGBUS the app.
        .memory_map(MmapChoice::never())
        .heap_limit(Some(64 << 20))
        .build()
}

/// What every walker thread shares.
struct Shared<'a> {
    req: &'a GrepRequest,
    root: &'a Path,
    matcher: &'a RegexMatcher,
    cancel: &'a CancelToken,
    deny: &'a DenyList,
    hits: Mutex<Vec<FileHit>>,
    /// Matching lines seen so far, every file.
    matches: AtomicUsize,
    /// Entries collected toward a page: files (files/count) or kept lines (content).
    entries: AtomicUsize,
    wanted: usize,
    searched: AtomicUsize,
    skipped_large: AtomicUsize,
    stopped: AtomicBool,
    cap_hit: AtomicBool,
}

impl Shared<'_> {
    fn should_stop(&self) -> bool {
        if self.cancel.is_cancelled() {
            self.stopped.store(true, Relaxed);
            return true;
        }
        if self.matches.load(Relaxed) >= HARD_MATCH_CAP && self.entries.load(Relaxed) >= self.wanted
        {
            self.cap_hit.store(true, Relaxed);
            return true;
        }
        false
    }

    fn search_file(&self, searcher: &mut Searcher, path: &Path, meta: &Metadata, explicit: bool) {
        let rel = walk::rel_path(self.root, path);
        if !explicit && self.deny.denies(&rel) {
            return;
        }
        if meta.len() > MAX_FILE_BYTES {
            self.skipped_large.fetch_add(1, Relaxed);
            return;
        }
        self.searched.fetch_add(1, Relaxed);
        let mut sink = HitSink {
            shared: self,
            explicit,
            lines: Vec::new(),
            matches: 0,
            kept: 0,
            last_kept: false,
            binary: false,
        };
        // An unreadable file is skipped, as ripgrep skips it.
        if searcher.search_path(self.matcher, path, &mut sink).is_err() {
            return;
        }
        if sink.binary || sink.matches == 0 {
            return;
        }
        if self.req.mode != OutputMode::Content {
            self.entries.fetch_add(1, Relaxed);
        }
        let hit = FileHit {
            rel,
            mtime_ms: mtime_ms(meta),
            matches: sink.matches,
            lines: sink.lines,
        };
        self.hits
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(hit);
    }
}

fn mtime_ms(meta: &Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

struct HitSink<'s, 'a> {
    shared: &'s Shared<'a>,
    explicit: bool,
    lines: Vec<LineHit>,
    matches: u32,
    kept: usize,
    last_kept: bool,
    binary: bool,
}

impl Sink for HitSink<'_, '_> {
    type Error = io::Error;

    fn matched(&mut self, _: &Searcher, m: &SinkMatch<'_>) -> Result<bool, io::Error> {
        let first = m.line_number().unwrap_or(0);
        let mut n = 0u32;
        self.last_kept = false;
        for (i, line) in m.bytes().split_inclusive(|b| *b == b'\n').enumerate() {
            n += 1;
            if self.shared.req.mode == OutputMode::Content && self.kept < PER_FILE_LINE_CAP {
                let focus = if i == 0 {
                    focus_char(self.shared.matcher, line)
                } else {
                    0
                };
                self.lines.push(LineHit {
                    line: first + i as u64,
                    text: clip(&line_text(line), focus, LINE_CLIP_CHARS),
                    is_match: true,
                });
                self.kept += 1;
                self.last_kept = true;
                self.shared.entries.fetch_add(1, Relaxed);
            }
        }
        self.matches += n;
        self.shared.matches.fetch_add(n as usize, Relaxed);
        if self.shared.req.mode == OutputMode::FilesWithMatches {
            return Ok(false); // the first hit is enough
        }
        Ok(!self.shared.should_stop())
    }

    fn context(&mut self, _: &Searcher, c: &SinkContext<'_>) -> Result<bool, io::Error> {
        let keep = match c.kind() {
            SinkContextKind::Before => self.kept < PER_FILE_LINE_CAP,
            SinkContextKind::After => self.last_kept,
            SinkContextKind::Other => false,
        };
        if keep {
            let first = c.line_number().unwrap_or(0);
            for (i, line) in c.bytes().split_inclusive(|b| *b == b'\n').enumerate() {
                self.lines.push(LineHit {
                    line: first + i as u64,
                    text: clip(&line_text(line), 0, LINE_CLIP_CHARS),
                    is_match: false,
                });
            }
        }
        Ok(!self.shared.should_stop())
    }

    fn binary_data(&mut self, _: &Searcher, _offset: u64) -> Result<bool, io::Error> {
        if self.explicit {
            return Ok(true);
        }
        self.binary = true;
        Ok(false)
    }
}

/// One line's text: lossy UTF-8, line ending (LF or CRLF) removed.
fn line_text(line: &[u8]) -> String {
    let line = line.strip_suffix(b"\n").unwrap_or(line);
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    String::from_utf8_lossy(line).into_owned()
}

/// The char index of the first match on `line`, for centring a clipped line.
fn focus_char(matcher: &RegexMatcher, line: &[u8]) -> usize {
    match matcher.find(line) {
        Ok(Some(m)) => String::from_utf8_lossy(&line[..m.start()]).chars().count(),
        _ => 0,
    }
}

/// At most `max_chars` chars of `text` around char `focus`, with `…` on each
/// cut side. Cuts only at char boundaries.
pub(crate) fn clip(text: &str, focus: usize, max_chars: usize) -> String {
    let total = text.chars().count();
    if total <= max_chars {
        return text.to_string();
    }
    let start = focus.saturating_sub(max_chars / 2).min(total - max_chars);
    let end = start + max_chars;
    let byte_at = |n: usize| text.char_indices().nth(n).map_or(text.len(), |(i, _)| i);
    let mut out = String::with_capacity(max_chars + 8);
    if start > 0 {
        out.push('…');
    }
    out.push_str(&text[byte_at(start)..byte_at(end)]);
    if end < total {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_keeps_short_lines_whole() {
        assert_eq!(clip("short", 0, 300), "short");
    }

    #[test]
    fn clip_centres_on_the_focus_and_marks_both_cuts() {
        let line = format!("{}needle{}", "a".repeat(1000), "b".repeat(1000));
        let clipped = clip(&line, 1000, 300);
        assert!(clipped.contains("needle"));
        assert!(clipped.starts_with('…') && clipped.ends_with('…'));
        assert_eq!(clipped.chars().count(), 302);
    }

    #[test]
    fn clip_never_splits_a_multibyte_char() {
        let line = "é".repeat(5000);
        let clipped = clip(&line, 2500, 300);
        assert_eq!(clipped.chars().filter(|c| *c == 'é').count(), 300);
    }

    #[test]
    fn line_text_drops_lf_and_crlf() {
        assert_eq!(line_text(b"a\r\n"), "a");
        assert_eq!(line_text(b"a\n"), "a");
        assert_eq!(line_text(b"a"), "a");
    }
}
