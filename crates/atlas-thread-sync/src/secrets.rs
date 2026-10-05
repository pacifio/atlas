//! Files that must not leave the machine by default (ADR-0021).
//!
//! Sharing uploads the sharer's uncommitted work, and every collaborator's
//! replica then writes it to disk. A credential in that set would be leaked to
//! the cloud and to every teammate's machine at once, so files that look like
//! secrets — by name, or by what `atlas-redact` finds in them — are held back.
//! The per-file override belongs to the share preview (ATL-402); until it
//! exists, blocked means blocked.
//!
//! The content rule leaves out `atlas-redact`'s entropy layer on purpose: it
//! fires on lockfile integrity hashes and minified assets, and a rule that
//! blocks `package-lock.json` would teach people to ignore it.

use atlas_redact::Category;

/// Why a file was held back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecretReason {
    /// The file's name is one that holds credentials (`.env`, a private key…).
    Name,
    /// `atlas-redact` found a credential in it; the categories it matched.
    Content(Vec<&'static str>),
}

/// Template files that conventionally hold placeholders, not values.
const TEMPLATE_SUFFIXES: &[&str] = &[".example", ".sample", ".template", ".dist"];

fn name_is_secret(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    if TEMPLATE_SUFFIXES.iter().any(|s| name.ends_with(s)) {
        return false;
    }
    name == ".env"
        || name.starts_with(".env.")
        || name.ends_with(".env")
        || matches!(
            name.as_str(),
            ".npmrc"
                | ".pypirc"
                | ".netrc"
                | ".htpasswd"
                | ".pgpass"
                | "credentials"
                | "credentials.json"
        )
        || name.starts_with("id_rsa")
        || name.starts_with("id_dsa")
        || name.starts_with("id_ecdsa")
        || name.starts_with("id_ed25519")
        || [
            ".pem",
            ".key",
            ".p12",
            ".pfx",
            ".jks",
            ".keystore",
            ".ppk",
            ".asc",
            ".gpg",
        ]
        .iter()
        .any(|ext| name.ends_with(ext))
}

/// Should `path` with `content` be held back from sharing?
pub fn secret_reason(path: &str, content: &str) -> Option<SecretReason> {
    if name_is_secret(path) {
        return Some(SecretReason::Name);
    }
    let counts = atlas_redact::redact(content).counts;
    let matched: Vec<&'static str> = Category::ALL
        .iter()
        .filter(|c| **c != Category::Entropy && counts.get(**c) > 0)
        .map(|c| c.as_str())
        .collect();
    (!matched.is_empty()).then_some(SecretReason::Content(matched))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn holds_back_credential_files_by_name() {
        for path in [
            ".env",
            "app/.env.local",
            "prod.env",
            "certs/server.key",
            "id_ed25519",
            ".npmrc",
            "keys/a.pem",
        ] {
            assert_eq!(secret_reason(path, "x"), Some(SecretReason::Name), "{path}");
        }
        for path in [
            ".env.example",
            "src/env.ts",
            "README.md",
            "keyboard.css",
            "docs/keys.md",
        ] {
            assert_eq!(secret_reason(path, "nothing secret here"), None, "{path}");
        }
    }

    #[test]
    fn holds_back_files_with_credentials_in_them_but_not_hashes() {
        let leaked = "const url = \"postgres://admin:hunter2hunter2@db.internal:5432/prod\";\n";
        assert!(matches!(
            secret_reason("src/db.ts", leaked),
            Some(SecretReason::Content(_))
        ));
        let lockfile = "\"integrity\": \"sha512-3Hk1a8z9QWERtyuiopASDfghjklZXCvbnm1234567890qwertyuiopASDFGHJKLzxcvbnm==\"\n";
        assert_eq!(secret_reason("package-lock.json", lockfile), None);
    }
}
