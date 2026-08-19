//! `Read` — line-numbered file reads with 1-indexed offset/limit, pagination,
//! binary detection, and "Did you mean?" suggestions (after opencode, MIT).
//!
//! Reads are **streamed** (tool spec D5). The previous version loaded the whole
//! file with `tokio::fs::read` and then split it into a `Vec<&str>` of every
//! line, so asking for ten lines of a large file allocated the file twice —
//! pagination that was not pagination.
//!
//! Decoding is **strict** (D11). Invalid UTF-8 is reported rather than turned
//! into replacement characters, because the model may copy what it reads back
//! into an `Edit`, and a lossy read is how U+FFFD gets written into a user's
//! source file.

use async_trait::async_trait;
use cersei::tools::{PermissionLevel, Tool, ToolCategory, ToolContext, ToolResult};
use serde::Deserialize;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt};

use super::{abs_path, coerce, errors};

const DEFAULT_LIMIT: usize = 2000;
const MAX_BYTES: usize = 50 * 1024;
const MAX_LINE_LEN: usize = 2000;
const SAMPLE_BYTES: usize = 4096;

const DESCRIPTION: &str = "Reads a file, line-numbered and paginated. Prefer this over \
cat/head/tail.\n\
- Each line is prefixed `N: `. That prefix is NOT part of the file — never copy it into an Edit.\n\
- Returns up to 2000 lines; use offset/limit to page through more.\n\
- Ask for several files in ONE message: they run in parallel. To find something inside a large \
file use Grep instead of reading the whole thing.";

#[derive(Deserialize)]
struct Input {
    file_path: String,
    offset: Option<usize>,
    limit: Option<usize>,
}

fn is_binary(path: &std::path::Path, sample: &[u8]) -> bool {
    const BINARY_EXT: &[&str] = &[
        "zip", "tar", "gz", "exe", "dll", "so", "class", "jar", "war", "7z", "doc", "docx", "xls",
        "xlsx", "ppt", "pptx", "bin", "dat", "obj", "o", "a", "lib", "wasm", "pyc", "pyo", "png",
        "jpg", "jpeg", "gif", "webp", "pdf", "ico", "mp3", "mp4", "mov", "woff", "woff2", "ttf",
    ];
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        if BINARY_EXT.contains(&ext.to_ascii_lowercase().as_str()) {
            return true;
        }
    }
    if sample.is_empty() {
        return false;
    }
    let mut non_printable = 0usize;
    for &b in sample {
        if b == 0 {
            return true;
        }
        if b < 9 || (b > 13 && b < 32) {
            non_printable += 1;
        }
    }
    non_printable as f64 / sample.len() as f64 > 0.3
}

async fn siblings(path: &std::path::Path) -> Vec<String> {
    let (Some(dir), Some(base)) = (path.parent(), path.file_name().and_then(|s| s.to_str())) else {
        return Vec::new();
    };
    let base_lower = base.to_ascii_lowercase();
    let mut out = Vec::new();
    if let Ok(mut rd) = tokio::fs::read_dir(dir).await {
        while let Ok(Some(entry)) = rd.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
            let nl = name.to_ascii_lowercase();
            if nl.contains(&base_lower) || base_lower.contains(&nl) {
                out.push(dir.join(&name).to_string_lossy().into_owned());
                if out.len() >= 3 {
                    break;
                }
            }
        }
    }
    out
}

pub struct ReadTool;

#[async_trait]
impl Tool for ReadTool {
    fn name(&self) -> &str {
        "Read"
    }
    fn description(&self) -> &str {
        DESCRIPTION
    }
    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }
    fn category(&self) -> ToolCategory {
        ToolCategory::FileSystem
    }
    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "file_path": { "type": "string", "description": "Path to the file (absolute, or relative to the project root)" },
                "offset": { "type": "integer", "description": "1-indexed line to start from" },
                "limit": { "type": "integer", "description": "Max lines to read (default 2000)" }
            },
            "required": ["file_path"]
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let input = coerce::for_schema(input, &self.input_schema());
        let input: Input = match serde_json::from_value(input) {
            Ok(i) => i,
            Err(e) => {
                return ToolResult::error(errors::decode_failure(
                    "Read",
                    &e.to_string(),
                    r#"{"file_path": "src/main.rs"}"#,
                ))
            }
        };

        let path = abs_path(&ctx.working_dir, &input.file_path);
        let display = path.to_string_lossy().into_owned();

        let meta = match tokio::fs::metadata(&path).await {
            Ok(m) => m,
            Err(_) => {
                let sibs = siblings(&path).await;
                return ToolResult::error(errors::read_did_you_mean(&display, &sibs));
            }
        };

        if meta.is_dir() {
            return read_dir(&path, &display, input.offset, input.limit).await;
        }

        // Binary detection reads a bounded prefix, never the whole file.
        let mut file = match tokio::fs::File::open(&path).await {
            Ok(f) => f,
            Err(e) => return ToolResult::error(format!("Failed to read {display}: {e}")),
        };
        let mut sample = vec![0u8; SAMPLE_BYTES.min(meta.len() as usize)];
        if let Err(e) = file.read_exact(&mut sample).await {
            if e.kind() != std::io::ErrorKind::UnexpectedEof {
                return ToolResult::error(format!("Failed to read {display}: {e}"));
            }
        }
        if is_binary(&path, &sample) {
            return ToolResult::success(format!(
                "[Binary file {display} ({} bytes) — not shown as text.]",
                meta.len()
            ));
        }

        let offset = input.offset.unwrap_or(1).max(1);
        let limit = input.limit.unwrap_or(DEFAULT_LIMIT);
        match paginate(&path, offset, limit).await {
            Ok(page) => ToolResult::success(format!("{display}\n{}{}", page.body, page.footer(offset))),
            Err(PageError::Io(e)) => ToolResult::error(format!("Failed to read {display}: {e}")),
            Err(PageError::Encoding { line }) => ToolResult::error(format!(
                "{display} is not valid UTF-8 (first bad byte is on line {line}), so it cannot be \
                 shown as text. Reading it lossily would put replacement characters in front of \
                 you that must never be written back into the file."
            )),
            Err(PageError::OutOfRange { total }) => ToolResult::error(format!(
                "Offset {offset} is out of range for {display} ({total} lines)."
            )),
        }
    }
}

/// One page of a file, plus what is known about the rest of it.
struct Page {
    body: String,
    /// 1-indexed number of the last line included.
    last: usize,
    /// Total lines, known only when the read reached end of file.
    total: Option<usize>,
    /// The byte budget stopped the page before the line limit did.
    capped: bool,
}

impl Page {
    fn footer(&self, offset: usize) -> String {
        let next = self.last + 1;
        match (self.capped, self.total) {
            (true, _) => format!(
                "\n(Output capped at {} KB. Showing lines {offset}-{}. Use offset={next} to continue.)",
                MAX_BYTES / 1024,
                self.last
            ),
            (false, Some(total)) => format!("\n(End of file — {total} lines.)"),
            // The line limit stopped us, so the true total is unknown and is
            // not guessed at: saying "of N" when N was never counted is the
            // kind of confident wrongness this layer exists to remove.
            (false, None) => format!(
                "\n(Showing lines {offset}-{}. More lines follow. Use offset={next} to continue.)",
                self.last
            ),
        }
    }
}

enum PageError {
    Io(std::io::Error),
    Encoding { line: usize },
    OutOfRange { total: usize },
}

/// Stream `path`, skipping to `offset` and emitting at most `limit` lines.
///
/// Memory is bounded by the byte budget regardless of file size: lines before
/// the offset are counted and dropped, and the loop stops as soon as either cap
/// is reached.
async fn paginate(path: &std::path::Path, offset: usize, limit: usize) -> Result<Page, PageError> {
    let file = tokio::fs::File::open(path).await.map_err(PageError::Io)?;
    let mut reader = tokio::io::BufReader::new(file);

    let mut raw: Vec<u8> = Vec::with_capacity(256);
    let mut number = 0usize;
    let mut body = String::new();
    let mut bytes_used = 0usize;
    let mut last = offset.saturating_sub(1);
    let mut capped = false;
    let mut reached_eof = false;

    loop {
        raw.clear();
        let read = reader.read_until(b'\n', &mut raw).await.map_err(PageError::Io)?;
        if read == 0 {
            reached_eof = true;
            break;
        }
        number += 1;
        if number < offset {
            continue; // counted and dropped — never materialised as a String
        }
        if number >= offset + limit {
            // Put the line back conceptually: we stopped because of the limit,
            // not because the file ended.
            break;
        }

        let trimmed = raw.strip_suffix(b"\n").unwrap_or(&raw);
        let trimmed = trimmed.strip_suffix(b"\r").unwrap_or(trimmed);
        let line = std::str::from_utf8(trimmed)
            .map_err(|_| PageError::Encoding { line: number })?;

        let shown: String = if line.chars().count() > MAX_LINE_LEN {
            let cut: String = line.chars().take(MAX_LINE_LEN).collect();
            format!("{cut}... (line truncated)")
        } else {
            line.to_string()
        };
        let entry = format!("{number}: {shown}\n");
        if bytes_used + entry.len() > MAX_BYTES && !body.is_empty() {
            capped = true;
            break;
        }
        bytes_used += entry.len();
        body.push_str(&entry);
        last = number;
    }

    if body.is_empty() && reached_eof {
        // Either the file is empty (offset 1 is fine) or the offset is past the
        // end, in which case `number` is the true total.
        if offset > 1 || number > 0 {
            return Err(PageError::OutOfRange { total: number });
        }
    }

    Ok(Page {
        body,
        last,
        total: reached_eof.then_some(number),
        capped,
    })
}

async fn read_dir(
    path: &std::path::Path,
    display: &str,
    offset: Option<usize>,
    limit: Option<usize>,
) -> ToolResult {
    let mut entries: Vec<String> = Vec::new();
    let mut rd = match tokio::fs::read_dir(path).await {
        Ok(r) => r,
        Err(e) => return ToolResult::error(format!("Failed to list {display}: {e}")),
    };
    loop {
        match rd.next_entry().await {
            Ok(Some(entry)) => {
                let mut name = entry.file_name().to_string_lossy().into_owned();
                if entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false) {
                    name.push('/');
                }
                entries.push(name);
            }
            Ok(None) => break,
            // Previously a mid-walk failure ended the loop and reported a
            // partial listing as complete.
            Err(e) => return ToolResult::error(format!("Failed to list {display}: {e}")),
        }
    }
    entries.sort();
    let total = entries.len();
    let start = offset.unwrap_or(1).saturating_sub(1);
    let lim = limit.unwrap_or(DEFAULT_LIMIT);
    let slice: Vec<String> = entries.into_iter().skip(start).take(lim).collect();
    let shown = slice.len();
    let truncated = start + shown < total;
    let footer = if truncated {
        format!("\n(Showing {shown} of {total} entries. Use offset={} to continue.)", start + shown + 1)
    } else {
        format!("\n({total} entries.)")
    };
    ToolResult::success(format!("{display} (directory)\n{}{footer}", slice.join("\n")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::{test_ctx, TmpDir};

    async fn run(dir: &std::path::Path, args: Value) -> ToolResult {
        ReadTool.execute(args, &test_ctx(dir.to_path_buf())).await
    }

    #[tokio::test]
    async fn reads_with_line_numbers() {
        let tmp = TmpDir::new();
        std::fs::write(tmp.path().join("a.txt"), "one\ntwo\nthree\n").unwrap();
        let r = run(tmp.path(), serde_json::json!({"file_path": "a.txt"})).await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("1: one"));
        assert!(r.content.contains("3: three"));
        assert!(r.content.contains("End of file — 3 lines"));
    }

    #[tokio::test]
    async fn offset_and_limit() {
        let tmp = TmpDir::new();
        let body: String = (1..=10).map(|i| format!("L{i}\n")).collect();
        std::fs::write(tmp.path().join("a.txt"), body).unwrap();
        let r = run(tmp.path(), serde_json::json!({"file_path": "a.txt", "offset": 3, "limit": 2})).await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("3: L3"));
        assert!(r.content.contains("4: L4"));
        assert!(!r.content.contains("5: L5"));
        assert!(r.content.contains("Use offset=5 to continue"));
    }

    #[tokio::test]
    async fn missing_file_suggests_siblings() {
        let tmp = TmpDir::new();
        std::fs::write(tmp.path().join("main.rs"), "x").unwrap();
        // Model dropped the extension; "main" is a substring of "main.rs".
        let r = run(tmp.path(), serde_json::json!({"file_path": "main"})).await;
        assert!(r.is_error);
        assert!(r.content.contains("Did you mean"));
        assert!(r.content.contains("main.rs"));
    }

    #[tokio::test]
    async fn binary_notice() {
        let tmp = TmpDir::new();
        std::fs::write(tmp.path().join("b.bin"), [0u8, 1, 2, 3, 0, 255]).unwrap();
        let r = run(tmp.path(), serde_json::json!({"file_path": "b.bin"})).await;
        assert!(!r.is_error);
        assert!(r.content.contains("Binary file"));
    }

    #[tokio::test]
    async fn out_of_range_offset() {
        let tmp = TmpDir::new();
        std::fs::write(tmp.path().join("a.txt"), "one\ntwo\n").unwrap();
        let r = run(tmp.path(), serde_json::json!({"file_path": "a.txt", "offset": 50})).await;
        assert!(r.is_error);
        assert!(r.content.contains("out of range"));
    }

    // ── D5 / D11 regressions ────────────────────────────────────────────────

    #[tokio::test]
    async fn invalid_utf8_is_reported_not_substituted() {
        let tmp = TmpDir::new();
        // A lone 0x80 continuation byte: invalid UTF-8, but with too few
        // control bytes to trip the binary heuristic, so it takes the text path.
        let mut bytes = b"fn main() {\n".to_vec();
        bytes.extend_from_slice(&[b'l', b'e', b't', b' ', 0x80, b';', b'\n']);
        bytes.extend_from_slice(b"}\n");
        std::fs::write(tmp.path().join("a.rs"), &bytes).unwrap();
        let r = run(tmp.path(), serde_json::json!({"file_path": "a.rs"})).await;
        assert!(r.is_error, "{}", r.content);
        assert!(r.content.contains("not valid UTF-8"), "{}", r.content);
        assert!(
            !r.content.contains('\u{FFFD}'),
            "a replacement character must never be shown to the model"
        );
    }

    #[tokio::test]
    async fn a_page_of_a_large_file_is_cheap() {
        let tmp = TmpDir::new();
        let f = tmp.path().join("big.txt");
        // 200k lines, ~2.4 MB. The old implementation read all of it and
        // allocated a Vec of every line to return three of them.
        let mut body = String::with_capacity(2_400_000);
        for i in 1..=200_000 {
            body.push_str(&format!("line {i}\n"));
        }
        std::fs::write(&f, &body).unwrap();

        let r = run(
            tmp.path(),
            serde_json::json!({"file_path": "big.txt", "offset": 100_000, "limit": 3}),
        )
        .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("100000: line 100000"));
        assert!(r.content.contains("100002: line 100002"));
        assert!(!r.content.contains("100003: line 100003"));
        // The response is a page, not the file.
        assert!(r.content.len() < 1000, "returned {} bytes", r.content.len());
    }

    #[tokio::test]
    async fn stopping_at_the_limit_does_not_invent_a_total() {
        let tmp = TmpDir::new();
        let body: String = (1..=100).map(|i| format!("L{i}\n")).collect();
        std::fs::write(tmp.path().join("a.txt"), body).unwrap();
        let r = run(tmp.path(), serde_json::json!({"file_path": "a.txt", "limit": 5})).await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("More lines follow"), "{}", r.content);
        assert!(
            !r.content.contains("of 100"),
            "the total was never counted, so it must not be stated"
        );
    }

    #[tokio::test]
    async fn empty_file_reads_as_empty_not_as_an_error() {
        let tmp = TmpDir::new();
        std::fs::write(tmp.path().join("empty.txt"), "").unwrap();
        let r = run(tmp.path(), serde_json::json!({"file_path": "empty.txt"})).await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("End of file — 0 lines"));
    }

    #[tokio::test]
    async fn file_without_a_trailing_newline_keeps_its_last_line() {
        let tmp = TmpDir::new();
        std::fs::write(tmp.path().join("a.txt"), "one\ntwo").unwrap();
        let r = run(tmp.path(), serde_json::json!({"file_path": "a.txt"})).await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("2: two"));
        assert!(r.content.contains("End of file — 2 lines"));
    }

    #[tokio::test]
    async fn crlf_lines_are_shown_without_the_carriage_return() {
        let tmp = TmpDir::new();
        std::fs::write(tmp.path().join("a.txt"), "one\r\ntwo\r\n").unwrap();
        let r = run(tmp.path(), serde_json::json!({"file_path": "a.txt"})).await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("1: one\n"), "{:?}", r.content);
    }
}
