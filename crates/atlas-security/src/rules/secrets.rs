//! Credentials on added lines, found by `atlas-redact`.
//!
//! The same detector Atlas uses to keep secrets out of its session record:
//! vendored provider rules, provider prefixes, credentialed URIs, connection
//! strings, credential assignments and entropy. A matched value never leaves
//! this function: not in the reason, the references, the logs, or even the
//! fingerprint, which hashes the redacted line.

use atlas_redact::{detect_categories, redact, Category};

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
        let categories = detect_categories(text);
        // The strongest layer that fired decides the grade: a provider rule
        // is a confirmed credential, entropy alone is a guess.
        let Some(category) = categories.iter().copied().max_by_key(|c| strength(*c)) else {
            continue;
        };
        let (level, blocking) = match category {
            Category::VendorRule | Category::ProviderToken => (Level::Critical, true),
            Category::CredentialedUri | Category::ConnectionString | Category::CredentialValue => {
                (Level::High, false)
            }
            // The leak signal: a secret-looking literal in a Session that read
            // a credentials file.
            Category::Entropy if !prov.sensitive_reads.is_empty() => (Level::High, false),
            Category::Entropy => (Level::Medium, false),
        };
        let rule_id = format!("secret.{}", category.as_str());
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

fn strength(category: Category) -> u8 {
    match category {
        Category::VendorRule | Category::ProviderToken => 3,
        Category::CredentialedUri | Category::ConnectionString | Category::CredentialValue => 2,
        Category::Entropy => 1,
    }
}
