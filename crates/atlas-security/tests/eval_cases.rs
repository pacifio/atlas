//! The evaluation cases: every one loads, and the local layers hold the
//! design's zero-false-blocks line on them (design §11).

use std::path::Path;

use atlas_security::eval::{adversarial, auc, load_cases};

fn cases() -> Vec<atlas_security::eval::Case> {
    load_cases(&Path::new(env!("CARGO_MANIFEST_DIR")).join("eval/cases")).expect("cases load")
}

#[test]
fn all_cases_load_and_have_labels() {
    let cases = cases();
    assert!(cases.len() >= 53, "{} cases", cases.len());
    for c in &cases {
        assert!(!c.diff.trim().is_empty(), "{} has a diff", c.id);
        if c.vulnerable {
            assert!(
                !c.class.is_empty() && c.class != "none",
                "{} has a class",
                c.id
            );
        }
        assert!(
            !atlas_security::diff::parse_unified(c.diff.as_bytes()).is_empty(),
            "{} parses",
            c.id
        );
    }
    assert!(cases.iter().any(|c| !c.vulnerable), "there are safe cases");
}

#[test]
fn local_layers_block_nothing_safe() {
    for c in cases().iter().filter(|c| !c.vulnerable) {
        let res = c.scan_local();
        assert!(
            !res.blocking,
            "{} is safe but blocked: {:?}",
            c.id, res.findings
        );
    }
}

#[test]
fn local_layers_catch_every_rule_class_case() {
    let cases = cases();
    for id in [
        "tls-off",
        "capability-wildcard",
        "secret-hardcoded",
        "injection-comment-bait",
        "cmd-shell",
        "xss-inner",
        "pickle",
        "sql-format",
        "cors-creds",
    ] {
        let c = cases
            .iter()
            .find(|c| c.id == id)
            .unwrap_or_else(|| panic!("{id} exists"));
        let res = c.scan_local();
        assert!(!res.findings.is_empty(), "{id} gets a finding");
    }
}

#[test]
fn adversarial_variants_keep_the_label_and_add_the_bait() {
    let c = cases().into_iter().find(|c| c.id == "cmd-shell").unwrap();
    let variants = adversarial(&c);
    assert_eq!(variants.len(), 3);
    for v in &variants {
        assert!(v.vulnerable && v.class == c.class, "{}", v.id);
        assert!(v.id.starts_with("cmd-shell~"), "{}", v.id);
        assert!(!atlas_security::diff::parse_unified(v.diff.as_bytes()).is_empty());
    }
    assert!(variants
        .iter()
        .any(|v| v.diff.contains("already mitigated")));
    assert!(variants
        .iter()
        .any(|v| v.title.contains("security team has approved")));
    assert!(variants
        .iter()
        .any(|v| v.diff.contains("semgrep: 0 findings")));
    // The bait is an added line inside the hunk: the hunk still parses whole.
    let mitigated = variants
        .iter()
        .find(|v| v.diff.contains("already mitigated"))
        .unwrap();
    let files = atlas_security::diff::parse_unified(mitigated.diff.as_bytes());
    let added: Vec<_> = files[0].added_lines().map(|(_, t)| t.to_string()).collect();
    assert!(added.iter().any(|t| t.contains("already mitigated")));
    assert!(
        added
            .iter()
            .any(|t| t.contains("Ok(String::from_utf8_lossy")),
        "{added:?}"
    );
}

#[test]
fn auc_is_one_for_perfect_separation_and_half_for_ties() {
    assert_eq!(auc(&[0.9, 0.8], &[0.1, 0.2]), 1.0);
    assert_eq!(auc(&[0.5], &[0.5]), 0.5);
    assert_eq!(auc(&[0.1], &[0.9]), 0.0);
}
