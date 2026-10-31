//! Credentials on added lines, found by `atlas-redact`.
//!
//! The same detector Atlas uses to keep secrets out of its session record:
//! vendored provider rules, provider prefixes, credentialed URIs, connection
//! strings, credential assignments and entropy. A matched value never leaves
//! this function: not in the reason, the references, the logs, or even the
//! fingerprint, which hashes the redacted line.

use std::sync::LazyLock;

use atlas_redact::{detect_categories, redact, vendor_rule_ids, Category};
use regex::Regex;

use crate::finding::{on_line, Class, Finding, Hit, Level, Source};
use crate::map::{MappedFile, SkipReason};
use crate::provenance::Provenance;
use crate::tags::Tag;

pub fn scan_secrets(sha: &str, file: &MappedFile, prov: &Provenance) -> Vec<Finding> {
    // Lockfiles are full of integrity hashes, which look exactly like keys.
    if file.tags.contains(&Tag::Lockfile) {
        return Vec::new();
    }
    // Generated files still get the confirmed-credential checks: a header
    // must not be able to switch off the layer that blocks. Guesses
    // (entropy, credential names) are skipped there, since bundles and
    // generated code are full of them.
    let confirmed_only = match file.skip {
        None => false,
        Some(SkipReason::Generated) => true,
        Some(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    let mut in_pem = false;
    for (line_no, text) in file.change.added_lines() {
        // A PEM private key spans lines: report its BEGIN line once and skip
        // its body, which would otherwise read as entropy.
        if in_pem {
            if PEM_END.is_match(text) {
                in_pem = false;
            }
            continue;
        }
        if PEM_BEGIN.is_match(text) {
            in_pem = !PEM_END.is_match(text);
            out.push(finding(
                sha,
                file,
                line_no,
                text,
                (Level::Critical, true, "secret.private_key".to_string()),
            ));
            continue;
        }
        let Some(graded) = grade(text, prov) else {
            continue;
        };
        if confirmed_only && !graded.1 {
            continue;
        }
        out.push(finding(sha, file, line_no, text, graded));
    }
    out
}

fn finding(
    sha: &str,
    file: &MappedFile,
    line_no: u32,
    text: &str,
    (level, blocking, rule_id): (Level, bool, String),
) -> Finding {
    on_line(
        Hit {
            class: Class::Secret,
            level,
            blocking,
            source: Source::Rule,
            rule_id: &rule_id,
        },
        sha,
        &file.change.path,
        (line_no, &redact(text).text),
    )
}

static PEM_BEGIN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY( BLOCK)?-----").expect("pem pattern compiles")
});
static PEM_END: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"-----END ([A-Z0-9]+ )*PRIVATE KEY( BLOCK)?-----").expect("pem pattern compiles")
});

/// Placeholder words and runs that real credentials do not contain. A
/// confirmed shape with one of these is a fixture or an example, not a key.
fn looks_fake(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    const WORDS: &[&str] = &[
        "your_",
        "your-",
        "<your",
        "example",
        "sample",
        "dummy",
        "fake",
        "placeholder",
        "changeme",
        "redacted",
        "xxxx",
        "0000",
        "1234",
        "abcd",
        "_test_",
    ];
    WORDS.iter().any(|w| lower.contains(w))
}

/// A vendored rule that fires on a generic shape rather than a provider's
/// own format.
fn is_generic_vendor_rule(id: &str, text: &str) -> bool {
    if GENERIC_VENDOR_RULES.contains(&id) || id.starts_with("curl-") || id.ends_with("-client-id") {
        return true;
    }
    // A client-secret rule is keyword + hex: on a line that names a client
    // id, it has matched the id.
    let lower = text.to_ascii_lowercase();
    id.ends_with("-client-secret")
        && ["client_id", "clientid", "client-id"]
            .iter()
            .any(|k| lower.contains(k))
}

/// Vendored rules that fire on generic shapes (any `password = "…"`, any
/// JWT), so a match is not a confirmed credential for a provider.
const GENERIC_VENDOR_RULES: &[&str] = &[
    "hashicorp-tf-password",
    "nuget-config-password",
    "jwt",
    "jwt-base64",
];

/// The strongest evidence on the line decides: a provider-specific rule is
/// a confirmed credential and blocks; everything else is a guess of some
/// strength and never blocks.
fn grade(text: &str, prov: &Provenance) -> Option<(Level, bool, String)> {
    let categories = detect_categories(text);
    if categories.is_empty() {
        return None;
    }
    let has = |c: Category| categories.contains(&c);
    let fake = looks_fake(text);
    if has(Category::VendorRule) {
        let ids = vendor_rule_ids(text);
        if let Some(id) = ids.iter().find(|id| !is_generic_vendor_rule(id, text)) {
            return Some((Level::Critical, !fake, format!("secret.vendor.{id}")));
        }
        if ids.iter().any(|id| id.starts_with("jwt")) {
            return Some((Level::High, false, "secret.vendor.jwt".to_string()));
        }
    }
    if has(Category::ProviderToken) {
        return Some((Level::Critical, !fake, "secret.provider_token".to_string()));
    }
    for c in [Category::CredentialedUri, Category::ConnectionString] {
        if has(c) {
            return Some((Level::High, false, format!("secret.{}", c.as_str())));
        }
    }
    // A credential-looking name is only a finding with a secret-like literal:
    // `let token = |name| …` and `type FontToken = "font-sans"` are code.
    let literal = has_secret_like_literal(text);
    if literal && (has(Category::CredentialValue) || has(Category::VendorRule)) {
        return Some((Level::Medium, false, "secret.credential_value".to_string()));
    }
    if has(Category::Entropy) {
        // The leak signal: a secret-looking literal in a Session that read a
        // credentials file.
        let level = if prov.sensitive_reads.is_empty() {
            Level::Medium
        } else {
            Level::High
        };
        return Some((level, false, "secret.entropy".to_string()));
    }
    None
}

/// A quoted literal that could be a credential: mixed letters and digits,
/// or at least 20 characters, with no spaces.
fn has_secret_like_literal(text: &str) -> bool {
    LITERAL.captures_iter(text).any(|c| {
        let v = &c[1];
        let mixed =
            v.chars().any(|ch| ch.is_ascii_alphabetic()) && v.chars().any(|ch| ch.is_ascii_digit());
        mixed || v.len() >= 20
    })
}

static LITERAL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"["'`]([^"'`\s]{8,})["'`]"#).expect("literal pattern compiles"));
