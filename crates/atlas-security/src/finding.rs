//! What the scanner reports: one finding per issue, with the exact lines.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Ordered: a finding's level is the highest any layer gave it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    None,
    Low,
    Medium,
    High,
    Critical,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::None => "none",
            Level::Low => "low",
            Level::Medium => "medium",
            Level::High => "high",
            Level::Critical => "critical",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Class {
    Secret,
    VulnerableDependency,
    MaliciousDependency,
    Injection,
    PathTraversal,
    Xss,
    TlsDisabled,
    Deserialization,
    DataExposure,
    Permissions,
    InstallScript,
}

impl Class {
    pub const ALL: [Class; 11] = [
        Class::Secret,
        Class::VulnerableDependency,
        Class::MaliciousDependency,
        Class::Injection,
        Class::PathTraversal,
        Class::Xss,
        Class::TlsDisabled,
        Class::Deserialization,
        Class::DataExposure,
        Class::Permissions,
        Class::InstallScript,
    ];

    /// The fixed, plain reason shown and synced for this class. Model-written
    /// text never replaces it.
    pub fn template(self) -> &'static str {
        match self {
            Class::Secret => "A credential appears in the added code.",
            Class::VulnerableDependency => {
                "A dependency was added or updated to a version with a known security advisory."
            }
            Class::MaliciousDependency => "A dependency was added that is listed as malicious.",
            Class::Injection => {
                "Outside input may reach a shell command, query or code evaluation unchecked."
            }
            Class::PathTraversal => {
                "A file path built from outside input may reach outside its intended folder."
            }
            Class::Xss => "Content may be rendered as HTML without being sanitised.",
            Class::TlsDisabled => "Certificate checks are turned off for a network connection.",
            Class::Deserialization => {
                "Data is loaded with a method that can run code if the data is untrusted."
            }
            Class::DataExposure => {
                "User data or a credential may be logged or sent somewhere it should not go."
            }
            Class::Permissions => "A permission or access setting was widened.",
            Class::InstallScript => {
                "A package install script was added, which runs code when dependencies install."
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Rule,
    Dependency,
    Clef,
    DeepReview,
}

/// Exact changed lines, shown as `[[sha7:path#Lstart-Lend]]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LineRef {
    pub sha: String,
    pub path: String,
    pub start: u32,
    pub end: u32,
}

impl std::fmt::Display for LineRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let sha7: String = self.sha.chars().take(7).collect();
        write!(f, "[[{sha7}:{}#L{}-L{}]]", self.path, self.start, self.end)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Finding {
    pub fingerprint: String,
    pub level: Level,
    pub blocking: bool,
    pub class: Class,
    pub source: Source,
    pub rule_id: String,
    pub refs: Vec<LineRef>,
    pub reason: String,
    /// The line is in test code: reported at its level, never blocking.
    #[serde(default)]
    pub test_code: bool,
}

/// Stable across commits: the same issue on the same line text in the same
/// file has the same fingerprint wherever it is seen.
pub fn fingerprint(class: Class, rule_id: &str, path: &str, line_text: &str) -> String {
    let mut h = Sha256::new();
    h.update(format!("{class:?}|{rule_id}|{path}|{}", line_text.trim()));
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// What a rule found, before it is placed on a line.
#[derive(Debug, Clone, Copy)]
pub struct Hit<'a> {
    pub class: Class,
    pub level: Level,
    pub blocking: bool,
    pub source: Source,
    pub rule_id: &'a str,
}

/// A finding on one added line. `fingerprint_text` is the line as it may be
/// hashed (the secrets rule passes the redacted line).
pub fn on_line(hit: Hit<'_>, sha: &str, path: &str, line: (u32, &str)) -> Finding {
    let (line_no, fingerprint_text) = line;
    Finding {
        fingerprint: fingerprint(hit.class, hit.rule_id, path, fingerprint_text),
        level: hit.level,
        blocking: hit.blocking,
        class: hit.class,
        source: hit.source,
        rule_id: hit.rule_id.to_string(),
        refs: vec![LineRef {
            sha: sha.to_string(),
            path: path.to_string(),
            start: line_no,
            end: line_no,
        }],
        reason: hit.class.template().to_string(),
        test_code: false,
    }
}
