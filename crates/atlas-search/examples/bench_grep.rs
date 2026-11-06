//! A process-per-search harness for comparing `atlas_search::grep` with
//! ripgrep under `hyperfine` (plan 02, Task 8). Prints a one-line summary to
//! stderr and nothing to stdout, so the comparison measures search, not a
//! terminal.
//!
//! ```text
//! cargo build -p atlas-search --release --example bench_grep
//! target/release/examples/bench_grep <root> <pattern> [files|content|count]
//! ```

use std::time::Instant;

use atlas_search::format::grep_text;
use atlas_search::{grep, CancelToken, GrepRequest, OutputMode, DEFAULT_BUDGET_BYTES};

fn main() {
    let mut args = std::env::args().skip(1);
    let root = args.next().unwrap_or_else(|| ".".to_string());
    let pattern = args.next().unwrap_or_else(|| "fn grep".to_string());
    let mode = match args.next().as_deref() {
        Some("content") => OutputMode::Content,
        Some("count") => OutputMode::Count,
        _ => OutputMode::FilesWithMatches,
    };
    let req = GrepRequest {
        mode,
        limit: Some(500),
        ..GrepRequest::new(&root, &pattern)
    };
    let started = Instant::now();
    let res = match grep(&req, &CancelToken::new()) {
        Ok(res) => res,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };
    let searched = started.elapsed();
    let text = grep_text(&res, &req, None, DEFAULT_BUDGET_BYTES);
    eprintln!(
        "{} files, {} matching lines, {} searched, {} skipped >10MiB, search {searched:?}, total {:?}, {} output bytes",
        res.total_files,
        res.total_matches,
        res.searched_files,
        res.skipped_large,
        started.elapsed(),
        text.len()
    );
}
