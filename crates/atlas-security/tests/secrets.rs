use atlas_security::diff::parse_unified;
use atlas_security::finding::{fingerprint, Class, Level, LineRef};
use atlas_security::map::{build, Limits, MappedFile};
use atlas_security::provenance::Provenance;
use atlas_security::rules::secrets::scan_secrets;

const SHA: &str = "abcdef1234567890abcdef1234567890abcdef12";

fn mapped(path: &str, added: &[&str], removed: &[&str]) -> MappedFile {
    let mut d = format!(
        "diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n@@ -1,{} +1,{} @@\n",
        removed.len(),
        added.len()
    );
    for l in removed {
        d.push_str(&format!("-{l}\n"));
    }
    for l in added {
        d.push_str(&format!("+{l}\n"));
    }
    build(parse_unified(d.as_bytes()), &Limits::default())
        .files
        .remove(0)
}

const LIVE_KEY: &str = "sk_live_51NzQ8vKj2mXyR4tPq9WbE7cL0dF3gH6";
const HIGH_ENTROPY: &str = "q8Zr3Lx9Vt2Wm7Np4Ks6Hd1Jf5Gb0Yc8";

#[test]
fn stripe_live_key_is_critical_blocking() {
    let file = mapped(
        "server/pay.ts",
        &[&format!("const k = \"{LIVE_KEY}\";")],
        &[],
    );
    let f = scan_secrets(SHA, &file, &Provenance::default());
    assert_eq!(f.len(), 1, "{f:?}");
    assert_eq!(f[0].class, Class::Secret);
    assert_eq!(f[0].level, Level::Critical);
    assert!(f[0].blocking);
    assert!(!f[0].reason.contains("sk_live"));
    assert!(!format!("{:?}", f[0]).contains(LIVE_KEY));
    assert_eq!(f[0].refs[0].path, "server/pay.ts");
    assert_eq!(f[0].refs[0].start, 1);
}

#[test]
fn env_lookup_is_not_a_finding() {
    let file = mapped(
        "server/pay.ts",
        &["const key = process.env.STRIPE_SECRET_KEY;"],
        &[],
    );
    assert!(scan_secrets(SHA, &file, &Provenance::default()).is_empty());
}

#[test]
fn placeholder_test_key_is_not_blocking() {
    let file = mapped(
        "server/pay.test.ts",
        &["const FAKE_KEY = \"sk_test_000000000000000000000000\";"],
        &[],
    );
    let f = scan_secrets(SHA, &file, &Provenance::default());
    assert!(f.iter().all(|x| !x.blocking), "{f:?}");
}

#[test]
fn lockfile_integrity_hash_is_ignored() {
    let file = mapped(
        "package-lock.json",
        &["      \"integrity\": \"sha512-Vq3Y8bFjK0pT2mLx9Wn4Rs7Ud6Hc1Ge5Za8Qb3Xy2Vw0Nt9Mk4Lj7Ph6Og5Fi1Ed3Cb2Aa9Zz8Yy7Xx6Ww5Vv4Uu3Tt2Ss1Rr0Q==\","],
        &[],
    );
    assert!(scan_secrets(SHA, &file, &Provenance::default()).is_empty());
}

#[test]
fn entropy_raised_after_sensitive_read() {
    let line = format!("let build_label = \"{HIGH_ENTROPY}\";");
    let file = mapped("src/client.rs", &[&line], &[]);
    let quiet = scan_secrets(SHA, &file, &Provenance::default());
    let after_read = scan_secrets(
        SHA,
        &file,
        &Provenance {
            sensitive_reads: vec![".env".to_string()],
            ..Provenance::default()
        },
    );
    let level = |f: &[atlas_security::finding::Finding]| {
        f.iter()
            .find(|x| x.rule_id == "secret.entropy")
            .map(|x| x.level)
    };
    assert_eq!(level(&quiet), Some(Level::Medium), "{quiet:?}");
    assert_eq!(level(&after_read), Some(Level::High), "{after_read:?}");
}

#[test]
fn removed_secret_is_not_a_finding() {
    let file = mapped(
        "server/pay.ts",
        &["const k = process.env.KEY;"],
        &[&format!("const k = \"{LIVE_KEY}\";")],
    );
    assert!(scan_secrets(SHA, &file, &Provenance::default()).is_empty());
}

#[test]
fn fingerprint_stable_across_shas() {
    let file = mapped(
        "server/pay.ts",
        &[&format!("const k = \"{LIVE_KEY}\";")],
        &[],
    );
    let a = scan_secrets(SHA, &file, &Provenance::default());
    let b = scan_secrets(
        "1111111111111111111111111111111111111111",
        &file,
        &Provenance::default(),
    );
    assert_eq!(a[0].fingerprint, b[0].fingerprint);
    assert_ne!(a[0].refs[0].to_string(), b[0].refs[0].to_string());
    assert_eq!(
        fingerprint(Class::Secret, "x", "p", "  line  "),
        fingerprint(Class::Secret, "x", "p", "line")
    );
}

#[test]
fn line_ref_display() {
    let r = LineRef {
        sha: SHA.to_string(),
        path: "src/a.rs".to_string(),
        start: 10,
        end: 12,
    };
    assert_eq!(r.to_string(), "[[abcdef1:src/a.rs#L10-L12]]");
}

#[test]
fn every_class_has_a_plain_template() {
    for class in Class::ALL {
        let t = class.template();
        assert!(t.ends_with('.'), "{class:?}");
        assert!(!t.contains('\u{2014}'), "{class:?} uses an em dash");
        assert!(!t.to_lowercase().contains("clef"), "{class:?}");
    }
}

#[test]
fn credential_name_on_code_expression_is_not_a_finding() {
    for line in [
        "    let token = |name: &str, fallback: &'static str| {",
        "    let token = std::fs::read_to_string(path)",
        "type ThemeFontToken = \"font-sans\" | \"font-mono\";",
        "export const SEED_TOKENS = [\"background\", \"foreground\", \"primary\"] as const;",
    ] {
        let file = mapped("src/theme.ts", &[line], &[]);
        assert!(
            scan_secrets(SHA, &file, &Provenance::default()).is_empty(),
            "{line}"
        );
    }
}

#[test]
fn credential_assignment_with_a_literal_is_medium() {
    let file = mapped("config.py", &["DB_PASSWORD = \"hunter2hunter2\""], &[]);
    let f = scan_secrets(SHA, &file, &Provenance::default());
    assert_eq!(f.len(), 1, "{f:?}");
    assert_eq!(f[0].level, Level::Medium);
    assert!(!f[0].blocking);
}

#[test]
fn a_provider_specific_vendor_rule_names_the_provider() {
    let file = mapped(
        "server/pay.ts",
        &[&format!("const k = \"{LIVE_KEY}\";")],
        &[],
    );
    let f = scan_secrets(SHA, &file, &Provenance::default());
    assert!(
        f[0].rule_id.starts_with("secret.vendor.stripe"),
        "{}",
        f[0].rule_id
    );
}

#[test]
fn a_jwt_is_high_but_not_blocking() {
    let jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    let file = mapped("src/api.ts", &[&format!("const session = \"{jwt}\";")], &[]);
    let f = scan_secrets(SHA, &file, &Provenance::default());
    assert_eq!(f.len(), 1, "{f:?}");
    assert_eq!(f[0].level, Level::High);
    assert!(!f[0].blocking);
}

// ── Review findings (final pass) ────────────────────────────────────────────

fn blocks(path: &str, lines: &[&str]) -> bool {
    scan_secrets(SHA, &mapped(path, lines, &[]), &Provenance::default())
        .iter()
        .any(|f| f.blocking)
}

#[test]
fn curl_placeholders_in_docs_do_not_block() {
    assert!(!blocks(
        "README.md",
        &["curl -H \"Authorization: Bearer YOUR_API_KEY\" https://api.example.com/v1"]
    ));
    assert!(!blocks(
        "docs/setup.md",
        &["curl -u admin:changeme https://localhost:8080/api"]
    ));
}

#[test]
fn client_ids_do_not_block() {
    assert!(!blocks(
        "src/oauth.ts",
        &["const DISCORD_CLIENT_ID = \"123456789012345678\";"]
    ));
    assert!(!blocks(
        "src/oauth.ts",
        &["const LINEAR_CLIENT_ID = \"9f8e7d6c5b4a39281706f5e4d3c2b1a0\";"]
    ));
}

#[test]
fn an_obviously_fake_provider_key_does_not_block() {
    assert!(!blocks(
        "src/redact.test.ts",
        &["const secret = \"sk-proj-abcd1234abcd1234abcd1234abcd1234\";"]
    ));
}

#[test]
fn a_live_provider_key_in_a_test_file_still_blocks() {
    // The secrets rule itself does not know about test code; the pipeline
    // must not demote a real-looking provider key either (see scan tests).
    assert!(blocks(
        "tests/fixtures/env.ts",
        &[&format!("const k = \"{LIVE_KEY}\";")]
    ));
}

#[test]
fn a_multi_line_pem_private_key_blocks_once() {
    let lines = [
        "const key = `",
        "-----BEGIN RSA PRIVATE KEY-----",
        "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun",
        "VTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxK",
        "-----END RSA PRIVATE KEY-----",
        "`;",
    ];
    let f = scan_secrets(
        SHA,
        &mapped("src/deploy.ts", &lines, &[]),
        &Provenance::default(),
    );
    let pem: Vec<_> = f
        .iter()
        .filter(|x| x.rule_id == "secret.private_key")
        .collect();
    assert_eq!(pem.len(), 1, "{f:?}");
    assert!(pem[0].blocking);
    assert_eq!(pem[0].level, Level::Critical);
    assert_eq!(pem[0].refs[0].start, 2);
    // The key body lines are part of the same finding, not extra entropy noise.
    assert!(f.iter().all(|x| x.rule_id != "secret.entropy"), "{f:?}");
}
