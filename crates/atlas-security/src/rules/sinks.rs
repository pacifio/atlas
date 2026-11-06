//! Dangerous calls on added lines, as a versioned table of patterns.
//!
//! Each rule is one regex for a line, optionally an `unless` that clears the
//! same line (a sanitiser wrapped around the sink) and an `also` that must
//! appear within the next few added lines of the same hunk (a shell spawn
//! followed by a `format!`). Only rules whose false positives are
//! near-impossible are blocking; the rest are findings with a level. Changing
//! any row is a scanner version bump.

use std::sync::LazyLock;

use regex::Regex;

use crate::diff::LineKind;
use crate::finding::{on_line, Class, Finding, Hit, Level, Source};
use crate::map::MappedFile;
use crate::tags::Language;

#[derive(Debug)]
pub struct SinkRule {
    pub id: &'static str,
    /// `None` runs on every language.
    pub lang: Option<Language>,
    /// Only files whose path matches: `**/` and `*` globs.
    pub path_glob: Option<&'static str>,
    pub pattern: &'static str,
    /// Clears a match on the same line.
    pub unless: Option<&'static str>,
    /// Must also match within [`ALSO_WINDOW`] added lines after the match.
    pub also: Option<&'static str>,
    pub class: Class,
    pub level: Level,
    pub blocking: bool,
}

/// How far `also` may sit after the line `pattern` matched.
pub const ALSO_WINDOW: usize = 3;

pub static SINK_RULES: &[SinkRule] = &[
    SinkRule {
        id: "rust.tls.accept_invalid",
        lang: Some(Language::Rust),
        path_glob: None,
        pattern: r"danger_accept_invalid_(certs|hostnames)\(\s*true",
        unless: None,
        also: None,
        class: Class::TlsDisabled,
        level: Level::High,
        blocking: true,
    },
    SinkRule {
        id: "rust.shell.sh_c_format",
        lang: Some(Language::Rust),
        path_glob: None,
        pattern: r#"Command::new\(\s*"(sh|bash|zsh|cmd|cmd\.exe|powershell)"\s*\)"#,
        unless: None,
        also: Some(r"format!\("),
        class: Class::Injection,
        level: Level::High,
        blocking: false,
    },
    SinkRule {
        id: "rust.sql.format",
        lang: Some(Language::Rust),
        path_glob: None,
        pattern: r#"format!\(\s*"[^"]*(?i:select\s|insert\s+into|update\s+\w+\s+set|delete\s+from)"#,
        unless: None,
        also: None,
        class: Class::Injection,
        level: Level::High,
        blocking: false,
    },
    SinkRule {
        id: "ts.html.inner",
        lang: Some(Language::JsTs),
        path_glob: None,
        pattern: r"\.innerHTML\s*=|dangerouslySetInnerHTML|\.outerHTML\s*=|insertAdjacentHTML\(",
        unless: Some(r"DOMPurify\.sanitize|\bsanitize(Html)?\("),
        also: None,
        class: Class::Xss,
        level: Level::Medium,
        blocking: false,
    },
    SinkRule {
        id: "ts.eval",
        lang: Some(Language::JsTs),
        path_glob: None,
        pattern: r"\beval\(|\bnew Function\(",
        unless: None,
        also: None,
        class: Class::Injection,
        level: Level::High,
        blocking: false,
    },
    SinkRule {
        id: "ts.tls.reject_unauthorized",
        lang: Some(Language::JsTs),
        path_glob: None,
        pattern: r#"rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0"#,
        unless: None,
        also: None,
        class: Class::TlsDisabled,
        level: Level::High,
        blocking: true,
    },
    SinkRule {
        id: "ts.shell.exec_template",
        lang: Some(Language::JsTs),
        path_glob: None,
        pattern: r"\bexec(Sync)?\(\s*`[^`]*\$\{",
        unless: None,
        also: None,
        class: Class::Injection,
        level: Level::High,
        blocking: false,
    },
    SinkRule {
        id: "py.shell.true",
        lang: Some(Language::Python),
        path_glob: None,
        pattern: r"shell\s*=\s*True",
        unless: None,
        also: None,
        class: Class::Injection,
        level: Level::High,
        blocking: false,
    },
    SinkRule {
        id: "py.tls.verify_false",
        lang: Some(Language::Python),
        path_glob: None,
        pattern: r"\bverify\s*=\s*False",
        unless: None,
        also: None,
        class: Class::TlsDisabled,
        level: Level::High,
        blocking: true,
    },
    SinkRule {
        id: "py.pickle.loads",
        lang: Some(Language::Python),
        path_glob: None,
        pattern: r"\bpickle\.loads?\(|\bcPickle\.loads?\(",
        unless: None,
        also: None,
        class: Class::Deserialization,
        level: Level::High,
        blocking: false,
    },
    SinkRule {
        id: "py.yaml.unsafe",
        lang: Some(Language::Python),
        path_glob: None,
        pattern: r"\byaml\.(load|load_all)\(",
        unless: Some(r"SafeLoader|CSafeLoader|safe_load"),
        also: None,
        class: Class::Deserialization,
        level: Level::High,
        blocking: false,
    },
    SinkRule {
        id: "py.sql.fstring",
        lang: Some(Language::Python),
        path_glob: None,
        pattern: r#"\.execute(many)?\(\s*f["']"#,
        unless: None,
        also: None,
        class: Class::Injection,
        level: Level::High,
        blocking: false,
    },
    SinkRule {
        id: "cfg.capability.shell_any_args",
        lang: None,
        path_glob: Some("**/capabilities/*.json"),
        pattern: r"shell:allow-(execute|spawn)",
        unless: None,
        also: Some(r#""args"\s*:\s*true"#),
        class: Class::Permissions,
        level: Level::Critical,
        blocking: true,
    },
    SinkRule {
        id: "cfg.cors.any_with_credentials",
        lang: None,
        path_glob: None,
        pattern: r"credentials\s*:\s*true",
        unless: None,
        also: Some(r#"origin\s*:\s*(['"]\*['"]|true\b)|cb\(\s*null\s*,\s*true\s*\)"#),
        class: Class::Permissions,
        level: Level::High,
        blocking: false,
    },
    SinkRule {
        id: "pkg.install_script",
        lang: None,
        path_glob: Some("**/package.json"),
        pattern: r#""(pre|post)?install"\s*:"#,
        unless: None,
        also: None,
        class: Class::InstallScript,
        level: Level::Medium,
        blocking: false,
    },
];

struct Compiled {
    rule: &'static SinkRule,
    pattern: Regex,
    unless: Option<Regex>,
    also: Option<Regex>,
    path: Option<Regex>,
}

static COMPILED: LazyLock<Vec<Compiled>> = LazyLock::new(|| {
    SINK_RULES
        .iter()
        .map(|rule| Compiled {
            rule,
            pattern: Regex::new(rule.pattern).expect("sink pattern compiles"),
            unless: rule.unless.map(|u| Regex::new(u).expect("unless compiles")),
            also: rule.also.map(|a| Regex::new(a).expect("also compiles")),
            path: rule.path_glob.map(glob_regex),
        })
        .collect()
});

/// `**/` is any directory prefix (or none), `*` is any run within a segment.
fn glob_regex(glob: &str) -> Regex {
    let mut out = String::from("^");
    let mut rest = glob;
    while !rest.is_empty() {
        if let Some(r) = rest.strip_prefix("**/") {
            out.push_str("(?:.*/)?");
            rest = r;
        } else if let Some(r) = rest.strip_prefix('*') {
            out.push_str("[^/]*");
            rest = r;
        } else {
            let c = rest.chars().next().expect("non-empty");
            out.push_str(&regex::escape(&c.to_string()));
            rest = &rest[c.len_utf8()..];
        }
    }
    out.push('$');
    Regex::new(&out).expect("glob compiles")
}

pub fn scan_sinks(sha: &str, file: &MappedFile) -> Vec<Finding> {
    if file.skip.is_some() {
        return Vec::new();
    }
    let path = file.change.path.as_str();
    let mut out = Vec::new();
    for hunk in &file.change.hunks {
        let added: Vec<(u32, &str)> = hunk
            .lines
            .iter()
            .filter(|l| l.kind == LineKind::Added)
            .map(|l| (l.new_no.unwrap_or(0), l.text.as_str()))
            .collect();
        for c in COMPILED.iter() {
            if c.rule.lang.is_some_and(|l| l != file.language) {
                continue;
            }
            if c.path.as_ref().is_some_and(|p| !p.is_match(path)) {
                continue;
            }
            for (i, (line_no, text)) in added.iter().enumerate() {
                if !c.pattern.is_match(text) {
                    continue;
                }
                if c.unless.as_ref().is_some_and(|u| u.is_match(text)) {
                    continue;
                }
                let end = match &c.also {
                    None => *line_no,
                    Some(also) => match added[i..]
                        .iter()
                        .take(ALSO_WINDOW + 1)
                        .find(|(_, t)| also.is_match(t))
                    {
                        Some((n, _)) => *n,
                        None => continue,
                    },
                };
                let mut finding = on_line(
                    Hit {
                        class: c.rule.class,
                        level: c.rule.level,
                        blocking: c.rule.blocking,
                        source: Source::Rule,
                        rule_id: c.rule.id,
                    },
                    sha,
                    path,
                    (*line_no, text),
                );
                finding.refs[0].end = end;
                out.push(finding);
            }
        }
    }
    out
}
