//! What the UI reads: a checkpoint's findings, a session's badge, and the
//! "Before you ship" roll-up of a branch.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use atlas_security::finding::Level;
use atlas_security::map::Limits;
use atlas_security::provenance::Provenance;
use atlas_security::repo::StaticRepo;
use atlas_security::scan::{scan_checkpoint, ScanInput, ScanResult};
use atlas_security::view::{checkpoint_view, session_summary, ship_overview, ShipScan};
use chrono::Utc;

const LIVE_KEY: &str = "sk_live_51NzQ8vKj2mXyR4tPq9WbE7cL0dF3gH6";

fn scan(sha: &str, diff: &str) -> ScanResult {
    let repo = StaticRepo {
        diff: diff.as_bytes().to_vec(),
        files: HashMap::new(),
        parent: None,
    };
    scan_checkpoint(ScanInput {
        sha,
        repo: &repo,
        provenance: &Provenance::default(),
        advisories: None,
        limits: Limits::default(),
        deadline: Instant::now() + Duration::from_secs(30),
    })
}

fn add(path: &str, start: u32, lines: &[&str]) -> String {
    let mut s = format!(
        "diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n@@ -{start},0 +{},{} @@\n",
        start + 1,
        lines.len()
    );
    for l in lines {
        s.push_str(&format!("+{l}\n"));
    }
    s
}

#[test]
fn a_checkpoint_view_lists_each_finding_with_where_it_is() {
    let result = scan(
        "aaaaaaa1",
        &add("src/calc.ts", 9, &["  return eval(input);"]),
    );
    let view = checkpoint_view("cp-1", "aaaaaaa1", Utc::now(), &result, &HashSet::new());
    assert_eq!(view.level, Level::High);
    assert!(!view.blocking);
    assert_eq!(view.findings.len(), 1);
    let f = &view.findings[0];
    assert_eq!(f.path, "src/calc.ts");
    assert_eq!(f.line, 10);
    assert_eq!(f.rule_id, "ts.eval");
    assert!(f.reason.starts_with("Outside input"));
    assert!(!f.not_useful);
}

#[test]
fn a_finding_marked_not_useful_stays_listed_but_stops_counting() {
    let result = scan(
        "aaaaaaa2",
        &add("pay.ts", 0, &[&format!("const k = \"{LIVE_KEY}\";")]),
    );
    let fp = result.findings[0].fingerprint.clone();
    let view = checkpoint_view(
        "cp-2",
        "aaaaaaa2",
        Utc::now(),
        &result,
        &HashSet::from([fp]),
    );
    assert_eq!(view.findings.len(), 1, "still shown, dimmed");
    assert!(view.findings[0].not_useful);
    assert_eq!(view.level, Level::None);
    assert!(!view.blocking);
}

#[test]
fn a_session_badge_is_the_highest_level_of_its_checkpoints() {
    let medium = scan(
        "b1",
        &add(
            "package.json",
            0,
            &["  \"postinstall\": \"node setup.js\","],
        ),
    );
    let critical = scan(
        "b2",
        &add("pay.ts", 0, &[&format!("const k = \"{LIVE_KEY}\";")]),
    );
    let views = vec![
        checkpoint_view("c1", "b1", Utc::now(), &medium, &HashSet::new()),
        checkpoint_view("c2", "b2", Utc::now(), &critical, &HashSet::new()),
    ];
    let s = session_summary("session-1", &views).expect("scanned");
    assert_eq!(s.level, Level::Critical);
    assert!(s.blocking);
    assert_eq!(s.findings, 2);
    assert_eq!(s.scanned, 2);
    assert!(session_summary("session-2", &[]).is_none());
}

#[test]
fn before_you_ship_separates_open_from_fixed_and_says_which_checkpoint_fixed_it() {
    let c1 = scan(
        "c1c1c1c",
        &add(
            "src/a.ts",
            0,
            &["export const run = (x: string) => eval(x);"],
        ),
    );
    let c2 = scan(
        "c2c2c2c",
        &add("server/pay.ts", 1, &[&format!("const k = \"{LIVE_KEY}\";")]),
    );
    // c3 rewrites src/a.ts without the eval.
    let c3 = scan(
        "c3c3c3c",
        "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-export const run = (x: string) => eval(x);\n+export const run = (x: string) => Number(x);\n",
    );
    let head: HashMap<&str, String> = HashMap::from([
        (
            "src/a.ts",
            "export const run = (x: string) => Number(x);\n".to_string(),
        ),
        (
            "server/pay.ts",
            format!("import Stripe from \"stripe\";\nconst k = \"{LIVE_KEY}\";\n"),
        ),
    ]);
    let scans = vec![
        ShipScan {
            commit_sha: "c1c1c1c".into(),
            result: c1,
        },
        ShipScan {
            commit_sha: "c2c2c2c".into(),
            result: c2,
        },
        ShipScan {
            commit_sha: "c3c3c3c".into(),
            result: c3,
        },
    ];
    let o = ship_overview(
        "feat/payments",
        &scans,
        &|p: &str| head.get(p).cloned(),
        &HashSet::new(),
    );
    assert_eq!(o.checkpoints, 3);
    assert!(o.blocking);
    assert_eq!(o.level, Level::Critical);
    assert_eq!(o.open.len(), 1, "{:?}", o.open);
    assert_eq!(o.open[0].path, "server/pay.ts");
    assert_eq!(o.fixed.len(), 1, "{:?}", o.fixed);
    assert_eq!(o.fixed[0].path, "src/a.ts");
    assert_eq!(o.fixed[0].fixed_in.as_deref(), Some("c3c3c3c"));
}

#[test]
fn before_you_ship_lists_sensitive_areas_and_what_was_not_scanned() {
    let c1 = scan(
        "d1d1d1d",
        &(add(".github/workflows/ci.yml", 0, &["on: push"])
            + "diff --git a/logo.png b/logo.png\nindex 1..2 100644\nBinary files a/logo.png and b/logo.png differ\n"),
    );
    let o = ship_overview(
        "main",
        &[ShipScan {
            commit_sha: "d1d1d1d".into(),
            result: c1,
        }],
        &|_: &str| None,
        &HashSet::new(),
    );
    assert!(o.open.is_empty());
    assert!(!o.blocking);
    assert_eq!(o.level, Level::None);
    let areas: Vec<(&str, &str)> = o
        .sensitive
        .iter()
        .map(|a| (a.path.as_str(), a.kind.as_str()))
        .collect();
    assert_eq!(areas, vec![(".github/workflows/ci.yml", "CI")]);
    assert_eq!(o.not_scanned.len(), 1);
    assert_eq!(o.not_scanned[0].path, "logo.png");
}

#[test]
fn a_finding_marked_not_useful_is_neither_open_nor_fixed() {
    let c1 = scan(
        "e1e1e1e",
        &add("pay.ts", 0, &[&format!("const k = \"{LIVE_KEY}\";")]),
    );
    let fp = c1.findings[0].fingerprint.clone();
    let head: HashMap<&str, String> =
        HashMap::from([("pay.ts", format!("const k = \"{LIVE_KEY}\";\n"))]);
    let o = ship_overview(
        "main",
        &[ShipScan {
            commit_sha: "e1e1e1e".into(),
            result: c1,
        }],
        &|p: &str| head.get(p).cloned(),
        &HashSet::from([fp]),
    );
    assert!(o.open.is_empty() && o.fixed.is_empty());
    assert!(!o.blocking);
}

#[test]
fn a_checkpoint_view_says_which_credential_files_the_agent_read() {
    let repo = StaticRepo {
        diff: add("src/calc.ts", 0, &["export const x = 1;"]).into_bytes(),
        files: HashMap::new(),
        parent: None,
    };
    let provenance = Provenance {
        sensitive_reads: vec![".env".to_string()],
        ..Provenance::default()
    };
    let result = scan_checkpoint(ScanInput {
        sha: "f1f1f1f",
        repo: &repo,
        provenance: &provenance,
        advisories: None,
        limits: Limits::default(),
        deadline: Instant::now() + Duration::from_secs(30),
    });
    let view = checkpoint_view("cp-f", "f1f1f1f", Utc::now(), &result, &HashSet::new());
    assert_eq!(view.sensitive_reads, vec![".env".to_string()]);
}
