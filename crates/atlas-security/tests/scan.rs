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
fn sink_findings_in_test_code_do_not_block_but_live_keys_do() {
    // A sink in a test file: kept at its level, never blocking.
    let r = repo(file_diff(
        "tests/client.rs",
        &["        .danger_accept_invalid_certs(true)"],
    ));
    let res = run(&r, None, soon());
    assert_eq!(res.findings.len(), 1, "{:?}", res.findings);
    assert!(!res.findings[0].blocking && res.findings[0].test_code);
    assert_eq!(res.findings[0].level, Level::High);

    // A live provider key in a test file is still a committed credential.
    let r = repo(file_diff(
        "tests/fixtures/env.ts",
        &[&format!("const k = \"{LIVE_KEY}\";")],
    ));
    let res = run(&r, None, soon());
    assert!(res.findings[0].blocking, "{:?}", res.findings);
    assert!(res.findings[0].test_code);
}

#[test]
fn only_lines_inside_a_cfg_test_block_count_as_test_code() {
    let tls =
        "        let c = reqwest::Client::builder().danger_accept_invalid_certs(true).build()?;";
    // Inside `#[cfg(test)] mod tests { … }`: test code.
    let source = format!(
        "pub fn real() {{}}\n\n#[cfg(test)]\nmod tests {{\n    fn t() {{\n{tls}\n    }}\n}}\n"
    );
    let diff = format!("diff --git a/src/a.rs b/src/a.rs\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -5,0 +6,1 @@ fn t() {{\n+{tls}\n");
    let mut r = repo(diff);
    r.files.insert(
        (SHA.to_string(), "src/a.rs".to_string()),
        source.into_bytes(),
    );
    let res = run(&r, None, soon());
    assert!(
        res.findings[0].test_code && !res.findings[0].blocking,
        "{:?}",
        res.findings
    );

    // `#[cfg(test)] mod tests;` declares a file; the lines after it are production.
    let source = format!("#[cfg(test)]\nmod tests;\n\npub fn connect() {{\n{tls}\n}}\n");
    let diff = format!("diff --git a/src/b.rs b/src/b.rs\n--- a/src/b.rs\n+++ b/src/b.rs\n@@ -4,0 +5,1 @@ pub fn connect() {{\n+{tls}\n");
    let mut r = repo(diff);
    r.files.insert(
        (SHA.to_string(), "src/b.rs".to_string()),
        source.into_bytes(),
    );
    let res = run(&r, None, soon());
    assert!(
        !res.findings[0].test_code && res.findings[0].blocking,
        "{:?}",
        res.findings
    );

    // A production fn after the test module closes is production again.
    let source = format!("#[cfg(test)]\nmod tests {{\n    #[test]\n    fn t() {{}}\n}}\n\npub fn connect() {{\n{tls}\n}}\n");
    let diff = format!("diff --git a/src/c.rs b/src/c.rs\n--- a/src/c.rs\n+++ b/src/c.rs\n@@ -7,0 +8,1 @@ pub fn connect() {{\n+{tls}\n");
    let mut r = repo(diff);
    r.files.insert(
        (SHA.to_string(), "src/c.rs".to_string()),
        source.into_bytes(),
    );
    let res = run(&r, None, soon());
    assert!(
        !res.findings[0].test_code && res.findings[0].blocking,
        "{:?}",
        res.findings
    );
}

#[test]
fn an_added_do_not_edit_line_does_not_switch_off_the_scan() {
    let r = repo(file_diff(
        "src/config.ts",
        &[
            "// DO NOT EDIT without asking the platform team",
            &format!("export const k = \"{LIVE_KEY}\";"),
            "eval(input);",
        ],
    ));
    let res = run(&r, None, soon());
    assert!(res.blocking, "{res:?}");
    assert!(
        res.findings.iter().any(|f| f.rule_id == "ts.eval"),
        "{:?}",
        res.findings
    );
    assert!(res.not_scanned.is_empty());
}

#[test]
fn a_generated_file_skips_sinks_but_not_confirmed_secrets() {
    // Generated per the file's header as it was before this commit.
    let diff = format!(
        "diff --git a/src/gen/api.ts b/src/gen/api.ts\n--- a/src/gen/api.ts\n+++ b/src/gen/api.ts\n@@ -1,1 +1,3 @@\n // @generated by openapi\n+eval(x);\n+export const k = \"{LIVE_KEY}\";\n"
    );
    let mut r = repo(diff);
    r.files.insert(
        (PARENT.to_string(), "src/gen/api.ts".to_string()),
        b"// @generated by openapi\n".to_vec(),
    );
    let res = run(&r, None, soon());
    assert!(
        res.findings.iter().all(|f| f.rule_id != "ts.eval"),
        "{:?}",
        res.findings
    );
    assert!(
        res.findings.iter().any(|f| f.blocking),
        "{:?}",
        res.findings
    );
    assert_eq!(res.not_scanned[0].reason, SkipReason::Generated);
}

#[test]
fn a_nested_build_folder_is_not_generated() {
    let res = run(
        &repo(file_diff("src/build/client.ts", &["  return eval(input);"])),
        None,
        soon(),
    );
    assert!(
        res.findings.iter().any(|f| f.rule_id == "ts.eval"),
        "{res:?}"
    );
    let res = run(
        &repo(file_diff("dist/bundle.js", &["eval(x)"])),
        None,
        soon(),
    );
    assert_eq!(res.not_scanned[0].reason, SkipReason::Generated);
}

fn npm_db(
    entries: &[(&str, serde_json::Value)],
    eco: Ecosystem,
) -> (tempfile::TempDir, AdvisoryDb) {
    let mut zip_bytes = Vec::new();
    {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut zip_bytes));
        for (name, v) in entries {
            w.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            w.write_all(v.to_string().as_bytes()).unwrap();
        }
        w.finish().unwrap();
    }
    let dir = tempfile::tempdir().unwrap();
    write_index(dir.path(), eco, &build_index(eco, &zip_bytes).unwrap()).unwrap();
    let db = AdvisoryDb::open(dir.path()).unwrap();
    (dir, db)
}

#[test]
fn a_huge_lockfile_is_still_dependency_checked() {
    let adv = serde_json::json!({"id": "GHSA-big", "affected": [{"package": {"ecosystem": "npm", "name": "evil"}, "versions": ["1.0.0"]}], "database_specific": {"severity": "CRITICAL"}});
    let (_d, db) = npm_db(&[("a.json", adv)], Ecosystem::Npm);
    let mut packages =
        String::from("{\"lockfileVersion\": 3, \"packages\": {\"\": {\"name\": \"app\"},\n");
    for i in 0..4500 {
        packages.push_str(&format!(
            "\"node_modules/p{i}\": {{\"version\": \"1.0.{i}\"}},\n"
        ));
    }
    packages.push_str("\"node_modules/evil\": {\"version\": \"1.0.0\"}\n}}\n");
    let added: Vec<&str> = packages.lines().collect();
    let mut r = repo(file_diff("package-lock.json", &added));
    r.files.insert(
        (SHA.to_string(), "package-lock.json".to_string()),
        packages.clone().into_bytes(),
    );
    let res = run(&r, Some(&db), soon());
    assert!(
        res.findings
            .iter()
            .any(|f| f.rule_id == "dep.GHSA-big" && f.blocking),
        "{:?} {:?}",
        res.findings,
        res.layers.deps
    );
}

#[test]
fn a_requirements_bump_is_dependency_checked() {
    let adv = serde_json::json!({"id": "GHSA-dj", "affected": [{"package": {"ecosystem": "PyPI", "name": "django"}, "ranges": [{"type": "ECOSYSTEM", "events": [{"introduced": "4.0"}, {"fixed": "4.2.2"}]}]}], "database_specific": {"severity": "HIGH"}});
    let (_d, db) = npm_db(&[("a.json", adv)], Ecosystem::PyPI);
    let diff = "diff --git a/requirements.txt b/requirements.txt\n--- a/requirements.txt\n+++ b/requirements.txt\n@@ -1 +1 @@\n-django==3.2.0\n+django==4.2.1\n".to_string();
    let mut r = repo(diff);
    r.files.insert(
        (PARENT.to_string(), "requirements.txt".to_string()),
        b"django==3.2.0\n".to_vec(),
    );
    r.files.insert(
        (SHA.to_string(), "requirements.txt".to_string()),
        b"django==4.2.1\n".to_vec(),
    );
    let res = run(&r, Some(&db), soon());
    assert!(
        res.findings.iter().any(|f| f.rule_id == "dep.GHSA-dj"),
        "{:?} {:?}",
        res.findings,
        res.layers.deps
    );
}

#[test]
fn twin_advisories_report_once_at_the_known_severity() {
    let ghsa = serde_json::json!({"id": "GHSA-twin", "aliases": ["RUSTSEC-2099-0009", "CVE-2099-1"], "affected": [{"package": {"ecosystem": "crates.io", "name": "foo"}, "versions": ["1.3.0"]}], "database_specific": {"severity": "MODERATE"}});
    let rustsec = serde_json::json!({"id": "RUSTSEC-2099-0009", "aliases": ["GHSA-twin", "CVE-2099-1"], "affected": [{"package": {"ecosystem": "crates.io", "name": "foo"}, "versions": ["1.3.0"]}]});
    let (_d, db) = npm_db(
        &[("g.json", ghsa), ("r.json", rustsec)],
        Ecosystem::CratesIo,
    );
    let res = run(&lock_bump_repo("1.0.0", "1.3.0"), Some(&db), soon());
    let deps: Vec<_> = res
        .findings
        .iter()
        .filter(|f| f.rule_id.starts_with("dep."))
        .collect();
    assert_eq!(deps.len(), 1, "{deps:?}");
    assert_eq!(deps[0].level, Level::Medium);
}

fn capability_diff(before: &str, after: &str) -> StaticRepo {
    let added: Vec<&str> = after.lines().collect();
    let mut r = repo(file_diff("src-tauri/capabilities/default.json", &added));
    r.files.insert(
        (
            PARENT.to_string(),
            "src-tauri/capabilities/default.json".to_string(),
        ),
        before.as_bytes().to_vec(),
    );
    r.files.insert(
        (
            SHA.to_string(),
            "src-tauri/capabilities/default.json".to_string(),
        ),
        after.as_bytes().to_vec(),
    );
    r
}

const CAP_BEFORE: &str =
    "{\n  \"identifier\": \"default\",\n  \"permissions\": [\n    \"core:default\"\n  ]\n}\n";
const CAP_AFTER: &str = "{\n  \"identifier\": \"default\",\n  \"permissions\": [\n    \"core:default\",\n    {\n      \"identifier\": \"shell:allow-execute\",\n      \"allow\": [\n        {\n          \"name\": \"any\",\n          \"cmd\": \"sh\",\n          \"args\": true\n        }\n      ]\n    }\n  ]\n}\n";

#[test]
fn a_pretty_printed_shell_capability_with_any_args_blocks() {
    let res = run(&capability_diff(CAP_BEFORE, CAP_AFTER), None, soon());
    let cap: Vec<_> = res
        .findings
        .iter()
        .filter(|f| f.rule_id == "cfg.capability.shell_any_args")
        .collect();
    assert_eq!(cap.len(), 1, "{:?}", res.findings);
    assert!(cap[0].blocking);
    assert_eq!(cap[0].level, Level::Critical);
    assert_eq!(cap[0].refs[0].start, 6, "points at the identifier line");
}

#[test]
fn a_shell_capability_already_granted_is_not_new() {
    let res = run(&capability_diff(CAP_AFTER, CAP_AFTER), None, soon());
    assert!(
        res.findings
            .iter()
            .all(|f| f.rule_id != "cfg.capability.shell_any_args"),
        "{:?}",
        res.findings
    );
}
