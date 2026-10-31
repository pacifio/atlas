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
