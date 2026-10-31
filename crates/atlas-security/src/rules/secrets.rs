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
use crate::map::MappedFile;
use crate::provenance::Provenance;
use crate::tags::Tag;

pub fn scan_secrets(sha: &str, file: &MappedFile, prov: &Provenance) -> Vec<Finding> {
    // Lockfiles are full of integrity hashes, which look exactly like keys.
    if file.skip.is_some() || file.tags.contains(&Tag::Lockfile) {
        return Vec::new();
    }
    let mut out = Vec::new();
    for (line_no, text) in file.change.added_lines() {
        let Some((level, blocking, rule_id)) = grade(text, prov) else {
            continue;
        };
        out.push(on_line(
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
        ));
    }
    out
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
    if has(Category::VendorRule) {
        let ids = vendor_rule_ids(text);
        if let Some(id) = ids.iter().find(|id| !GENERIC_VENDOR_RULES.contains(id)) {
            return Some((Level::Critical, true, format!("secret.vendor.{id}")));
        }
        if ids.iter().any(|id| id.starts_with("jwt")) {
            return Some((Level::High, false, "secret.vendor.jwt".to_string()));
        }
    }
    if has(Category::ProviderToken) {
        return Some((Level::Critical, true, "secret.provider_token".to_string()));
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
