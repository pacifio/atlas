use std::collections::HashMap;
use std::io::Write;
use std::time::{Duration, Instant};

use atlas_security::deps::lockfiles::Ecosystem;
use atlas_security::deps::osv::{build_index, write_index, AdvisoryDb};
use atlas_security::finding::{Class, Level};
use atlas_security::map::{Limits, SkipReason};
use atlas_security::provenance::Provenance;
use atlas_security::repo::StaticRepo;
use atlas_security::scan::{
    scan_checkpoint, LayerState, ScanInput, ScanResult, ScanStatus, SCANNER_VERSION,
};

const SHA: &str = "abcdef1234567890abcdef1234567890abcdef12";
const PARENT: &str = "1111111111111111111111111111111111111111";
const LIVE_KEY: &str = "sk_live_51NzQ8vKj2mXyR4tPq9WbE7cL0dF3gH6";

fn file_diff(path: &str, added: &[&str]) -> String {
    let mut s = format!(
        "diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n@@ -1,0 +1,{} @@\n",
        added.len()
    );
    for l in added {
        s.push_str(&format!("+{l}\n"));
    }
    s
}

fn repo(diff: String) -> StaticRepo {
    StaticRepo {
        diff: diff.into_bytes(),
        files: HashMap::new(),
        parent: Some(PARENT.to_string()),
    }
}

fn run(repo: &StaticRepo, advisories: Option<&AdvisoryDb>, deadline: Instant) -> ScanResult {
    scan_checkpoint(ScanInput {
        sha: SHA,
        repo,
        provenance: &Provenance::default(),
        advisories,
        limits: Limits::default(),
        deadline,
    })
}

fn soon() -> Instant {
    Instant::now() + Duration::from_secs(30)
}

fn cargo_lock(foo_version: &str) -> String {
    format!(
        "version = 4\n\n[[package]]\nname = \"foo\"\nversion = \"{foo_version}\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\n"
    )
}

fn foo_db() -> (tempfile::TempDir, AdvisoryDb) {
    let adv = serde_json::json!({
        "id": "RUSTSEC-2099-0002", "summary": "foo is broken",
        "affected": [{ "package": { "ecosystem": "crates.io", "name": "foo" },
                       "ranges": [{ "type": "SEMVER", "events": [{ "introduced": "1.0.0" }, { "fixed": "1.4.2" }] }] }],
        "database_specific": { "severity": "HIGH" }
    });
    let mut zip_bytes = Vec::new();
    {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut zip_bytes));
        w.start_file("a.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        w.write_all(adv.to_string().as_bytes()).unwrap();
        w.finish().unwrap();
    }
    let dir = tempfile::tempdir().unwrap();
    write_index(
        dir.path(),
        Ecosystem::CratesIo,
        &build_index(Ecosystem::CratesIo, &zip_bytes).unwrap(),
    )
    .unwrap();
    let db = AdvisoryDb::open(dir.path()).unwrap();
    (dir, db)
}

fn lock_bump_repo(from: &str, to: &str) -> StaticRepo {
    let diff = format!(
        "diff --git a/Cargo.lock b/Cargo.lock\n--- a/Cargo.lock\n+++ b/Cargo.lock\n@@ -4,2 +4,2 @@\n name = \"foo\"\n-version = \"{from}\"\n+version = \"{to}\"\n"
    );
    let mut r = repo(diff);
    r.files.insert(
        (PARENT.to_string(), "Cargo.lock".to_string()),
        cargo_lock(from).into_bytes(),
    );
    r.files.insert(
        (SHA.to_string(), "Cargo.lock".to_string()),
        cargo_lock(to).into_bytes(),
    );
    r
}

#[test]
fn clean_commit_is_done_level_none() {
    let r = repo(file_diff("src/a.rs", &["let total = items.len();"]));
    let res = run(&r, None, soon());
    assert_eq!(res.status, ScanStatus::Done);
    assert_eq!(res.level, Level::None);
    assert!(!res.blocking);
    assert!(res.findings.is_empty());
    assert_eq!(res.scanner_version, SCANNER_VERSION);
    assert_eq!(res.layers.secrets, LayerState::Ran);
    assert_eq!(
        res.layers.clef,
        LayerState::NotRun("not enabled".to_string())
    );
}

#[test]
fn secret_and_sink_in_one_commit_level_is_max_and_blocking() {
    let diff = file_diff("server/pay.ts", &[&format!("const k = \"{LIVE_KEY}\";")])
        + &file_diff("src/calc.ts", &["  return eval(input);"]);
    let res = run(&repo(diff), None, soon());
    assert_eq!(res.level, Level::Critical);
    assert!(res.blocking);
    let classes: Vec<Class> = res.findings.iter().map(|f| f.class).collect();
    assert!(
        classes.contains(&Class::Secret) && classes.contains(&Class::Injection),
        "{classes:?}"
    );
}

#[test]
fn missing_commit_fails_with_reason() {
    struct Gone;
    impl atlas_security::repo::Repo for Gone {
        fn commit_diff(&self, sha: &str) -> Result<Vec<u8>, atlas_security::repo::RepoError> {
            Err(atlas_security::repo::RepoError::MissingCommit(
                sha.to_string(),
            ))
        }
        fn file_at(
            &self,
            _: &str,
            _: &str,
        ) -> Result<Option<Vec<u8>>, atlas_security::repo::RepoError> {
            Ok(None)
        }
        fn parent(&self, _: &str) -> Result<Option<String>, atlas_security::repo::RepoError> {
            Ok(None)
        }
    }
    let res = scan_checkpoint(ScanInput {
        sha: SHA,
        repo: &Gone,
        provenance: &Provenance::default(),
        advisories: None,
        limits: Limits::default(),
        deadline: soon(),
    });
    assert_eq!(
        res.status,
        ScanStatus::Failed("commit not found".to_string())
    );
    assert!(res.findings.is_empty());
}

#[test]
fn deadline_in_past_gives_partial_with_time_budget() {
    let diff = file_diff("src/a.rs", &["let a = 1;"]) + &file_diff("src/b.rs", &["let b = 2;"]);
    let res = run(&repo(diff), None, Instant::now() - Duration::from_secs(1));
    assert_eq!(res.status, ScanStatus::Partial);
    assert_eq!(res.not_scanned.len(), 2);
    assert!(res
        .not_scanned
        .iter()
        .all(|n| n.reason == SkipReason::TimeBudget));
}

#[test]
fn lockfile_bump_to_vulnerable_version_blocks() {
    let (_d, db) = foo_db();
    let res = run(&lock_bump_repo("1.0.0", "1.3.0"), Some(&db), soon());
    let dep: Vec<_> = res
        .findings
        .iter()
        .filter(|f| f.class == Class::VulnerableDependency)
        .collect();
    assert_eq!(dep.len(), 1, "{:?}", res.findings);
    assert!(dep[0].blocking);
    assert_eq!(dep[0].level, Level::High);
    assert_eq!(dep[0].refs[0].path, "Cargo.lock");
    assert_eq!(dep[0].refs[0].start, 5);
    assert!(res.blocking);
    assert_eq!(res.layers.deps, LayerState::Ran);
}

#[test]
fn lockfile_bump_to_safe_version_has_no_findings_and_lists_floor() {
    let (_d, db) = foo_db();
    let res = run(&lock_bump_repo("1.3.0", "1.4.2"), Some(&db), soon());
    assert_eq!(res.level, Level::None, "{:?}", res.findings);
    assert!(res.findings.is_empty());
    assert_eq!(res.floors, vec!["Cargo.lock".to_string()]);
}

#[test]
fn lockfile_bump_without_db_reports_deps_not_run() {
    let res = run(&lock_bump_repo("1.0.0", "1.3.0"), None, soon());
    assert!(
        matches!(res.layers.deps, LayerState::NotRun(_)),
        "{:?}",
        res.layers.deps
    );
    assert_eq!(res.status, ScanStatus::Done);
}

#[test]
fn pnpm_lock_listed_unsupported() {
    let res = run(
        &repo(file_diff("pnpm-lock.yaml", &["  foo: 1.0.0"])),
        None,
        soon(),
    );
    assert_eq!(res.not_scanned.len(), 1);
    assert_eq!(res.not_scanned[0].reason, SkipReason::UnsupportedLockfile);
}

#[test]
fn duplicate_findings_collapse_by_fingerprint() {
    let line = format!("const k = \"{LIVE_KEY}\";");
    let diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,0 +1,1 @@\n+".to_string()
        + &line
        + "\n@@ -10,0 +11,1 @@\n+"
        + &line
        + "\n";
    let res = run(&repo(diff), None, soon());
    assert_eq!(res.findings.len(), 1, "{:?}", res.findings);
    assert_eq!(res.findings[0].refs.len(), 2);
}

#[test]
fn result_round_trips_json() {
    let r = repo(file_diff("src/calc.ts", &["  return eval(input);"]));
    let res = run(&r, None, soon());
    let json = serde_json::to_string(&res).unwrap();
    let back: ScanResult = serde_json::from_str(&json).unwrap();
    assert_eq!(back, res);
    assert!(json.contains("\"level\":\"high\""), "{json}");
}

#[test]
fn skipped_files_are_reported_not_dropped() {
    let diff =
        "diff --git a/x.png b/x.png\nindex 1..2 100644\nBinary files a/x.png and b/x.png differ\n"
            .to_string()
            + &file_diff("app.min.js", &["var a=1"]);
    let res = run(&repo(diff), None, soon());
    let mut reasons: Vec<_> = res
        .not_scanned
        .iter()
        .map(|n| (n.path.as_str(), n.reason))
        .collect();
    reasons.sort_by_key(|(p, _)| *p);
    assert_eq!(
        reasons,
        vec![
            ("app.min.js", SkipReason::Generated),
            ("x.png", SkipReason::Binary)
        ]
    );
    assert_eq!(res.order.len(), 2);
}

#[test]
fn findings_in_test_code_are_never_blocking() {
    // A test file by path.
    let r = repo(file_diff(
        "src/pay.test.ts",
        &[&format!("const k = \"{LIVE_KEY}\";")],
    ));
    let res = run(&r, None, soon());
    assert_eq!(res.findings.len(), 1);
    assert!(!res.findings[0].blocking, "{:?}", res.findings);
    assert!(res.findings[0].test_code);
    assert_eq!(res.findings[0].level, Level::Critical, "the level is kept");
    assert!(!res.blocking);

    // A Rust file whose `#[cfg(test)]` module holds the line.
    let source = format!(
        "pub fn real() {{}}\n\n#[cfg(test)]\nmod tests {{\n    #[test]\n    fn t() {{\n        let secret = \"{LIVE_KEY}\";\n    }}\n}}\n"
    );
    let diff = format!(
        "diff --git a/src/redact.rs b/src/redact.rs\n--- a/src/redact.rs\n+++ b/src/redact.rs\n@@ -6,0 +7,1 @@ fn t() {{\n+        let secret = \"{LIVE_KEY}\";\n"
    );
    let mut r = repo(diff);
    r.files.insert(
        (SHA.to_string(), "src/redact.rs".to_string()),
        source.into_bytes(),
    );
    let res = run(&r, None, soon());
    assert_eq!(res.findings.len(), 1);
    assert!(
        !res.findings[0].blocking && res.findings[0].test_code,
        "{:?}",
        res.findings
    );

    // The same line above any test module still blocks.
    let source = format!("pub fn real() {{\n    let secret = \"{LIVE_KEY}\";\n}}\n");
    let diff = format!(
        "diff --git a/src/real.rs b/src/real.rs\n--- a/src/real.rs\n+++ b/src/real.rs\n@@ -1,0 +2,1 @@ pub fn real() {{\n+    let secret = \"{LIVE_KEY}\";\n"
    );
    let mut r = repo(diff);
    r.files.insert(
        (SHA.to_string(), "src/real.rs".to_string()),
        source.into_bytes(),
    );
    let res = run(&r, None, soon());
    assert!(res.findings[0].blocking && !res.findings[0].test_code);
}
