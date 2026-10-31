//! What a changed file is, and what risky things its added lines touch.
//!
//! Tags come from the path (a lockfile, a CI workflow, a capability file) and
//! from patterns on added lines (a shell call, an HTML sink). They decide the
//! order a reviewer should read files in and which files are floors: areas
//! where any change gets the deeper checks. A tag is never a finding.

use std::sync::LazyLock;

use regex::Regex;

use crate::diff::{Hunk, LineKind};

/// The languages with deep checks. Everything else gets path tags only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Language {
    JsTs,
    Rust,
    Python,
    Other,
}

pub fn language_of(path: &str) -> Language {
    let ext = path.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
    match ext.as_deref() {
        Some("js" | "jsx" | "mjs" | "cjs" | "ts" | "tsx" | "mts" | "cts") => Language::JsTs,
        Some("rs") => Language::Rust,
        Some("py" | "pyi") => Language::Python,
        _ => Language::Other,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Tag {
    EntryPoint,
    ShellSink,
    FsSink,
    NetSink,
    HtmlSink,
    EvalSink,
    SqlSink,
    DeserializeSink,
    TelemetrySink,
    TlsConfig,
    Capability,
    CspConfig,
    CiWorkflow,
    Manifest,
    Lockfile,
    AgentConfig,
    AuthCode,
    InstallScript,
}

impl Tag {
    /// How much this tag pulls a file up the reading order.
    pub fn weight(self) -> u32 {
        match self {
            Tag::Capability | Tag::CspConfig | Tag::CiWorkflow | Tag::AgentConfig => 5,
            Tag::ShellSink
            | Tag::EvalSink
            | Tag::SqlSink
            | Tag::HtmlSink
            | Tag::DeserializeSink
            | Tag::TlsConfig
            | Tag::InstallScript => 4,
            Tag::EntryPoint | Tag::TelemetrySink | Tag::Lockfile | Tag::AuthCode => 3,
            Tag::FsSink | Tag::NetSink | Tag::Manifest => 2,
        }
    }
}

/// Areas where any change gets the deeper checks (design §6.1).
pub fn is_floor(tag: Tag) -> bool {
    matches!(
        tag,
        Tag::CiWorkflow
            | Tag::Capability
            | Tag::CspConfig
            | Tag::Lockfile
            | Tag::AgentConfig
            | Tag::TelemetrySink
            | Tag::AuthCode
    )
}

const LOCKFILES: &[&str] = &[
    "Cargo.lock",
    "package-lock.json",
    "bun.lock",
    "bun.lockb",
    "pnpm-lock.yaml",
    "yarn.lock",
    "uv.lock",
    "poetry.lock",
];

/// Path words that mark authentication, authorization and crypto code.
const AUTH_WORDS: &[&str] = &[
    "auth",
    "oauth",
    "authn",
    "authz",
    "authentication",
    "authorization",
    "login",
    "session",
    "sessions",
    "permission",
    "permissions",
    "acl",
    "crypto",
    "jwt",
];

pub fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Test code by path: test directories, fixtures, and the test-file naming
/// conventions of the deep-check languages.
pub fn is_test_path(path: &str) -> bool {
    let name = file_name(path);
    let dirs = path.split('/').rev().skip(1);
    if dirs.into_iter().any(|d| {
        matches!(
            d,
            "test" | "tests" | "__tests__" | "spec" | "fixtures" | "testdata" | "__fixtures__"
        )
    }) {
        return true;
    }
    let stem = name.split('.').next().unwrap_or(name);
    let js_test = [".test.", ".spec."].iter().any(|m| name.contains(m));
    js_test
        || name == "conftest.py"
        || (name.ends_with(".py") && (stem.starts_with("test_") || stem.ends_with("_test")))
        || (name.ends_with(".rs") && stem.ends_with("_test"))
}

pub fn is_lockfile(path: &str) -> bool {
    LOCKFILES.contains(&file_name(path))
}

pub fn path_tags(path: &str) -> Vec<Tag> {
    let name = file_name(path);
    let lower = path.to_ascii_lowercase();
    let segments: Vec<&str> = path.split('/').collect();
    let mut tags = Vec::new();

    if lower.starts_with(".github/workflows/") || lower.contains("/.github/workflows/") {
        tags.push(Tag::CiWorkflow);
    }
    if segments.contains(&"capabilities") && (name.ends_with(".json") || name.ends_with(".toml")) {
        tags.push(Tag::Capability);
    }
    if name == "tauri.conf.json" || (name.starts_with("tauri.") && name.ends_with(".conf.json")) {
        tags.push(Tag::CspConfig);
    }
    if matches!(name, "Cargo.toml" | "package.json" | "pyproject.toml")
        || (name.starts_with("requirements") && name.ends_with(".txt"))
    {
        tags.push(Tag::Manifest);
    }
    if is_lockfile(path) {
        tags.push(Tag::Lockfile);
    }
    let agent_dir = segments
        .iter()
        .any(|s| matches!(*s, ".claude" | ".cursor" | ".agents" | ".husky"));
    if matches!(name, ".mcp.json" | "AGENTS.md" | "CLAUDE.md")
        || agent_dir
        || (name == "SKILL.md" && segments.contains(&"skills"))
    {
        tags.push(Tag::AgentConfig);
    }
    if lower.contains("telemetry") || lower.contains("analytics") {
        tags.push(Tag::TelemetrySink);
    }
    let words = lower.split(['/', '.', '_', '-']);
    if words.into_iter().any(|w| AUTH_WORDS.contains(&w)) {
        tags.push(Tag::AuthCode);
    }
    tags
}

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("tag pattern compiles")
}

static RUST: LazyLock<Vec<(Tag, Regex)>> = LazyLock::new(|| {
    vec![
        (
            Tag::EntryPoint,
            re(r"#\[tauri::command\]|generate_handler!"),
        ),
        (Tag::ShellSink, re(r"Command::new\(")),
        (
            Tag::FsSink,
            re(r"\bfs::(read|write|remove|create|copy|rename|open)|File::(open|create)"),
        ),
        (Tag::NetSink, re(r"reqwest::|Client::builder\(")),
        (Tag::TlsConfig, re(r"danger_accept_invalid")),
        (Tag::TelemetrySink, re(r"telemetry::|posthog")),
    ]
});

static JS_TS: LazyLock<Vec<(Tag, Regex)>> = LazyLock::new(|| {
    vec![
        (Tag::EntryPoint, re(r"\binvoke\(")),
        (
            Tag::HtmlSink,
            re(r"innerHTML|dangerouslySetInnerHTML|outerHTML|insertAdjacentHTML"),
        ),
        (Tag::EvalSink, re(r"\beval\(|new Function\(")),
        (Tag::NetSink, re(r"\bfetch\(|axios\.")),
        (
            Tag::ShellSink,
            re(r"child_process|execSync\(|\bexec\(|\bspawn\("),
        ),
        (Tag::TelemetrySink, re(r"posthog|\btrack\(|analytics\.")),
    ]
});

static PYTHON: LazyLock<Vec<(Tag, Regex)>> = LazyLock::new(|| {
    vec![
        (
            Tag::EntryPoint,
            re(r"@(app|router|bp|blueprint)\.(route|get|post|put|patch|delete)\b|@api_view"),
        ),
        (
            Tag::ShellSink,
            re(r"\bsubprocess\.|\bos\.system\(|\bos\.popen\("),
        ),
        (Tag::EvalSink, re(r"\beval\(|\bexec\(")),
        (
            Tag::DeserializeSink,
            re(r"\bpickle\.loads?\(|\byaml\.load\("),
        ),
        (Tag::TlsConfig, re(r"verify\s*=\s*False")),
        (Tag::SqlSink, re(r#"execute\(\s*f["']"#)),
        (Tag::FsSink, re(r"\bopen\(|os\.path\.join\(")),
        (Tag::NetSink, re(r"\brequests\.|httpx\.|urllib\.request")),
    ]
});

static SQL_KEYWORD: LazyLock<Regex> = LazyLock::new(|| {
    re(r"(?i)\b(select\s.+\sfrom|insert\s+into|update\s+\w+\s+set|delete\s+from)\b")
});
static INTERPOLATION: LazyLock<Regex> =
    LazyLock::new(|| re(r#"format!\(|\$\{|\{\}|%s|%d|["']\s*\+|\+\s*["']|\bf["']"#));
static INSTALL_SCRIPT: LazyLock<Regex> = LazyLock::new(|| re(r#""(pre|post)?install"\s*:"#));

/// Tags from the hunk's added lines.
pub fn hunk_tags(lang: Language, hunk: &Hunk) -> Vec<Tag> {
    let table: &[(Tag, Regex)] = match lang {
        Language::Rust => &RUST,
        Language::JsTs => &JS_TS,
        Language::Python => &PYTHON,
        Language::Other => &[],
    };
    let mut tags = Vec::new();
    for line in hunk.lines.iter().filter(|l| l.kind == LineKind::Added) {
        for (tag, pattern) in table {
            if !tags.contains(tag) && pattern.is_match(&line.text) {
                tags.push(*tag);
            }
        }
        if !tags.contains(&Tag::SqlSink)
            && SQL_KEYWORD.is_match(&line.text)
            && INTERPOLATION.is_match(&line.text)
        {
            tags.push(Tag::SqlSink);
        }
    }
    tags
}

/// An added npm lifecycle script in a `package.json` hunk.
pub fn adds_install_script(hunk: &Hunk) -> bool {
    hunk.lines
        .iter()
        .any(|l| l.kind == LineKind::Added && INSTALL_SCRIPT.is_match(&l.text))
}
