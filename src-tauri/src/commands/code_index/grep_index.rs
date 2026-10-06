//! The grep prefilter for large git projects (Phase 5). Opened only at a git
//! work-tree root; built in the background; never required for correctness.

use std::path::Path;
use std::sync::Arc;

use atlas_grepindex::{GrepIndex, IndexOptions};

fn options() -> IndexOptions {
    match std::env::var("ATLAS_GREP_INDEX").as_deref() {
        Ok("force") => IndexOptions::always(),
        _ => IndexOptions::default(),
    }
}

/// `None` when `root` is not a git work-tree root, indexing is switched off,
/// or off Unix (`atlas_grepindex::Error::Unsupported`).
pub fn open_for(root: &Path) -> Option<Arc<GrepIndex>> {
    if std::env::var("ATLAS_GREP_INDEX").as_deref() == Ok("off") {
        return None;
    }
    GrepIndex::open(root, options()).ok().map(Arc::new)
}

#[cfg(test)]
mod tests {
    use std::process::Command;
    use std::sync::Arc;

    #[cfg(unix)]
    #[test]
    fn index_follows_watcher_and_git() {
        let dir = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            assert!(Command::new("git")
                .args(args)
                .current_dir(dir.path())
                .status()
                .unwrap()
                .success())
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "t@t"]);
        git(&["config", "user.name", "t"]);
        for i in 0..50 {
            std::fs::write(
                dir.path().join(format!("f{i}.rs")),
                format!("pub fn f{i}() {{}}\n"),
            )
            .unwrap();
        }
        git(&["add", "."]);
        git(&["-c", "commit.gpgsign=false", "commit", "-qm", "init"]);
        // Files modified in the last 2 s are never vouched for (racy window): age them.
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(60);
        for i in 0..50 {
            let f = std::fs::File::options()
                .write(true)
                .open(dir.path().join(format!("f{i}.rs")))
                .unwrap();
            f.set_modified(old).unwrap();
        }
        assert!(
            super::open_for(dir.path()).is_some(),
            "a git root gets an index"
        );
        // `IndexOptions::always()` as `ATLAS_GREP_INDEX=force` would give, without
        // touching the process environment other tests read.
        let ix = Arc::new(
            atlas_grepindex::GrepIndex::open(dir.path(), atlas_grepindex::IndexOptions::always())
                .expect("git root"),
        );
        ix.ensure_built(&atlas_search::CancelToken::new()).unwrap();
        // A write the watcher reports.
        std::fs::write(dir.path().join("f3.rs"), "pub fn brand_new_name() {}\n").unwrap();
        ix.note_paths(&[dir.path().join("f3.rs")]);
        let mut req = atlas_search::GrepRequest::new(dir.path(), "brand_new_name");
        req.candidates = Some(ix.clone() as Arc<dyn atlas_search::CandidateSource>);
        let res = atlas_search::grep(&req, &atlas_search::CancelToken::new()).unwrap();
        assert_eq!(
            res.files.iter().map(|f| f.rel.as_str()).collect::<Vec<_>>(),
            ["f3.rs"]
        );
        assert!(res.skipped_by_index > 40, "{}", res.skipped_by_index);
        // A watcher overflow: still correct (no candidates) until resync.
        ix.mark_untrusted();
        let res = atlas_search::grep(&req, &atlas_search::CancelToken::new()).unwrap();
        assert_eq!(res.skipped_by_index, 0);
        ix.resync().unwrap();
        assert!(
            atlas_search::grep(&req, &atlas_search::CancelToken::new())
                .unwrap()
                .skipped_by_index
                > 0
        );
    }
}
