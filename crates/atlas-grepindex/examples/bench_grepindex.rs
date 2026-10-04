//! Indexed grep vs plain scan vs ripgrep on a real repository.
//!
//! ```text
//! git clone --depth 1 https://github.com/torvalds/linux /tmp/linux
//! cargo run -p atlas-grepindex --example bench_grepindex --release -- /tmp/linux [queries.txt]
//! ```
//!
//! `queries.txt` holds one regex per line; without it a built-in list aimed at C/Rust trees is
//! used. Each row is the median of 3 warm runs. Exits non-zero if the indexed and scan results
//! ever differ.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

use atlas_grepindex::{GrepIndex, IndexOptions};
use atlas_search::{grep, CancelToken, CandidateSource, GrepRequest, GrepResult, OutputMode};

const DEFAULT_QUERIES: &[&str] = &[
    "EXPORT_SYMBOL_GPL\\(kmalloc",
    "spin_lock_irqsave\\(&\\w+->lock",
    "kthread_should_stop",
    "struct\\s+task_struct\\s*\\{",
    "(?i)rcu_read_lock_bh",
    "ZSTD_decompressStream",
    "MODULE_AUTHOR\\(\"Linus",
    "this_string_does_not_exist_anywhere_42",
    "copy_from_user|copy_to_user",
    "\\bTODO\\b",
    "[A-Z_]{25,}",
    "\\w+\\s*=\\s*\\w+",
];

fn request(
    root: &Path,
    pattern: &str,
    candidates: Option<Arc<dyn CandidateSource>>,
) -> GrepRequest {
    GrepRequest {
        root: root.to_path_buf(),
        path: None,
        pattern: pattern.to_string(),
        globs: Vec::new(),
        file_type: None,
        mode: OutputMode::FilesWithMatches,
        case_insensitive: None,
        literal: false,
        word: false,
        multiline: false,
        before: 0,
        after: 0,
        limit: Some(usize::MAX),
        offset: 0,
        include_ignored: false,
        deny_globs: Vec::new(),
        candidates,
    }
}

fn median(mut v: Vec<Duration>) -> Duration {
    v.sort();
    v[v.len() / 2]
}

fn timed<T>(f: impl Fn() -> T) -> (Duration, T) {
    let mut times = Vec::new();
    let mut last = None;
    for _ in 0..3 {
        let start = Instant::now();
        last = Some(f());
        times.push(start.elapsed());
    }
    (median(times), last.expect("ran three times"))
}

fn files(res: &GrepResult) -> Vec<String> {
    let mut v: Vec<String> = res.files.iter().map(|f| f.rel.clone()).collect();
    v.sort();
    v
}

fn dir_size(dir: &Path) -> u64 {
    std::fs::read_dir(dir)
        .map(|it| {
            it.flatten()
                .filter_map(|e| e.metadata().ok())
                .map(|m| m.len())
                .sum()
        })
        .unwrap_or(0)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let root = PathBuf::from(
        args.first()
            .expect("usage: bench_grepindex <repo> [queries.txt]"),
    )
    .canonicalize()
    .expect("repo path");
    let queries: Vec<String> = match args.get(1) {
        Some(file) => std::fs::read_to_string(file)
            .expect("queries file")
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(str::to_string)
            .collect(),
        None => DEFAULT_QUERIES.iter().map(|q| (*q).to_string()).collect(),
    };
    let idx = GrepIndex::open(&root, IndexOptions::always()).expect("open index");
    let start = Instant::now();
    let outcome = idx.ensure_built(&CancelToken::new()).expect("build");
    let status = idx.status();
    let snapshot = idx
        .grep_dir()
        .join(status.base_tree.clone().unwrap_or_default());
    println!(
        "{outcome:?} in {:.1?}: {} docs, overlay {}, snapshot {:.1} MiB",
        start.elapsed(),
        status.base_docs,
        status.overlay_docs,
        dir_size(&snapshot) as f64 / (1024.0 * 1024.0)
    );
    let idx: Arc<dyn CandidateSource> = Arc::new(idx);
    let rg = Command::new("rg").arg("--version").output().is_ok();
    println!(
        "{:<40} {:>7} {:>10} {:>10} {:>10} {:>9}",
        "query", "files", "scan ms", "index ms", "rg ms", "skipped"
    );
    let mut mismatch = false;
    for q in &queries {
        let cancel = CancelToken::new();
        let (scan_t, scan) = timed(|| grep(&request(&root, q, None), &cancel).expect("scan"));
        let (idx_t, indexed) =
            timed(|| grep(&request(&root, q, Some(Arc::clone(&idx))), &cancel).expect("indexed"));
        let rg_ms = if rg {
            let (t, _) = timed(|| {
                Command::new("rg")
                    .args(["-l", "--no-messages", "-e", q])
                    .current_dir(&root)
                    .output()
            });
            format!("{:.1}", t.as_secs_f64() * 1000.0)
        } else {
            "-".to_string()
        };
        if files(&scan) != files(&indexed) {
            mismatch = true;
            eprintln!("MISMATCH for {q:?}");
        }
        println!(
            "{:<40} {:>7} {:>10.1} {:>10.1} {:>10} {:>9}",
            q.chars().take(40).collect::<String>(),
            scan.files.len(),
            scan_t.as_secs_f64() * 1000.0,
            idx_t.as_secs_f64() * 1000.0,
            rg_ms,
            indexed.skipped_by_index
        );
    }
    if mismatch {
        std::process::exit(1);
    }
}
