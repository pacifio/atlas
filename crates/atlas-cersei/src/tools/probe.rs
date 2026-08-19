//! M3 stage 1 — ground truth after edit.
//!
//! Two cheap checks run after every successful write-class tool call
//! (Edit, Write, NotebookEdit, ApplyPatch — the guard applies them, so the
//! SDK's own Write tool is covered without a wrapper):
//!
//! 1. **Parse probe** — tree-sitter parses each edited file and reports
//!    `ERROR`/`MISSING` nodes with line numbers. A file that stops parsing
//!    is the cheapest possible ground truth that an edit went wrong.
//! 2. **Check command** — an optional project-configured command from
//!    `.atlas/check.json` (`{"command": "...", "timeout_secs": N}`), run in
//!    the workspace root with a hard timeout. Exit 0 → silence; non-zero →
//!    an output tail. The command is the project author's own (it lives in
//!    their repo), so it runs unsandboxed like their shell would — unlike
//!    agent-authored Bash, which stays sandbox-wrapped.
//!
//! Findings are appended to the tool result as a bounded text block — the
//! same channel the SDK's retry guidance already uses. The dedup ledger
//! lives on `ToolPolicy` (mirroring the repeat-read `served` map) so the
//! same findings aren't repeated while they're still visible in fresh
//! messages.

use std::path::Path;

use serde::Deserialize;

/// Findings cap: the block appended to a tool result never exceeds this
/// many lines (the roadmap's ≤20-line budget, shared by both checks).
pub const MAX_REPORT_LINES: usize = 20;
/// Per-file cap on reported parse errors.
const MAX_ERRORS_PER_FILE: usize = 5;
/// Default / ceiling for the check command's timeout.
const CHECK_DEFAULT_TIMEOUT_SECS: u64 = 10;
const CHECK_MAX_TIMEOUT_SECS: u64 = 60;

/// One parse finding: 1-based line plus what the parser saw.
#[derive(Debug, Clone, PartialEq)]
pub struct ParseFinding {
    pub line: usize,
    pub detail: String,
}

/// Parse-probe one file. `None` = nothing to say (unsupported language,
/// unreadable file, or parser failure — the probe must never turn a
/// successful edit into noise about the probe itself). `Some(vec![])` = the
/// file parses cleanly.
pub fn parse_probe(path: &Path) -> Option<Vec<ParseFinding>> {
    let language = language_for(path)?;
    let source = std::fs::read_to_string(path).ok()?;
    let mut parser = tree_sitter::Parser::new();
    parser.set_language(&language).ok()?;
    let tree = parser.parse(&source, None)?;
    if !tree.root_node().has_error() {
        return Some(Vec::new());
    }

    let mut findings = Vec::new();
    let mut cursor = tree.root_node().walk();
    collect_errors(&mut cursor, &mut findings);
    findings.truncate(MAX_ERRORS_PER_FILE);
    Some(findings)
}

fn collect_errors(cursor: &mut tree_sitter::TreeCursor, findings: &mut Vec<ParseFinding>) {
    loop {
        let node = cursor.node();
        if findings.len() >= MAX_ERRORS_PER_FILE {
            return;
        }
        if node.is_error() || node.is_missing() {
            let row = node.start_position().row + 1;
            let detail = if node.is_missing() {
                format!("missing {}", node.kind())
            } else {
                "syntax error".to_string()
            };
            findings.push(ParseFinding { line: row, detail });
            // An ERROR subtree's children are more ERROR noise — skip into
            // the next sibling instead.
        } else if node.has_error() && cursor.goto_first_child() {
            continue;
        }
        while !cursor.goto_next_sibling() {
            if !cursor.goto_parent() {
                return;
            }
        }
    }
}

fn language_for(path: &Path) -> Option<tree_sitter::Language> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "rs" => tree_sitter_rust::LANGUAGE.into(),
        "ts" | "mts" | "cts" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        "tsx" => tree_sitter_typescript::LANGUAGE_TSX.into(),
        "js" | "jsx" | "mjs" | "cjs" => tree_sitter_typescript::LANGUAGE_TSX.into(),
        "py" | "pyi" => tree_sitter_python::LANGUAGE.into(),
        "go" => tree_sitter_go::LANGUAGE.into(),
        "sh" | "bash" => tree_sitter_bash::LANGUAGE.into(),
        _ => return None,
    })
}

/// `.atlas/check.json` — the project's own fast check command.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CheckConfig {
    pub command: String,
    #[serde(default)]
    pub timeout_secs: Option<u64>,
}

impl CheckConfig {
    pub fn timeout_secs(&self) -> u64 {
        self.timeout_secs
            .unwrap_or(CHECK_DEFAULT_TIMEOUT_SECS)
            .min(CHECK_MAX_TIMEOUT_SECS)
    }
}

/// Relative path of the config, next to the other `.atlas/` state.
pub const CHECK_CONFIG_REL: &str = ".atlas/check.json";

/// Load the check config from a workspace root. Absent, unreadable, or
/// malformed all mean "no check command" — same forgiving idiom as the MCP
/// config reader.
pub fn load_check_config(root: &Path) -> Option<CheckConfig> {
    let raw = std::fs::read_to_string(root.join(CHECK_CONFIG_REL)).ok()?;
    let config: CheckConfig = serde_json::from_str(&raw).ok()?;
    if config.command.trim().is_empty() {
        return None;
    }
    Some(config)
}

/// Run the project check command. `None` = nothing to report (clean exit,
/// timeout, or spawn failure — a broken check setup must not fail edits).
/// `Some(text)` = a bounded failure tail.
pub async fn run_check(config: &CheckConfig, root: &Path) -> Option<String> {
    use cersei::tools::tool_primitives::process::{exec, ExecOptions};
    let opts = ExecOptions {
        cwd: Some(root.to_path_buf()),
        timeout: Some(std::time::Duration::from_secs(config.timeout_secs())),
        ..Default::default()
    };
    let out = exec(&config.command, opts).await.ok()?;
    if out.timed_out {
        return Some(format!(
            "check command timed out after {}s (`{}`)",
            config.timeout_secs(),
            config.command
        ));
    }
    if out.exit_code == 0 {
        return None;
    }
    let mut combined = String::new();
    combined.push_str(out.stdout.trim_end());
    if !out.stderr.trim().is_empty() {
        if !combined.is_empty() {
            combined.push('\n');
        }
        combined.push_str(out.stderr.trim_end());
    }
    let tail: Vec<&str> = combined.lines().rev().take(10).collect();
    let tail: Vec<&str> = tail.into_iter().rev().collect();
    Some(format!(
        "check command failed (exit {}): `{}`\n{}",
        out.exit_code,
        config.command,
        tail.join("\n")
    ))
}

/// Compose the appended block from per-file parse findings and an optional
/// check failure. Empty string = nothing to append. Bounded to
/// [`MAX_REPORT_LINES`].
pub fn render_report(parse: &[(String, Vec<ParseFinding>)], check: Option<&str>) -> String {
    let mut lines: Vec<String> = Vec::new();
    for (file, findings) in parse {
        for f in findings {
            lines.push(format!("[syntax] {file}:{} {}", f.line, f.detail));
        }
    }
    if let Some(check) = check {
        for l in check.lines() {
            lines.push(format!("[check] {l}"));
        }
    }
    if lines.is_empty() {
        return String::new();
    }
    let total = lines.len();
    lines.truncate(MAX_REPORT_LINES);
    if total > MAX_REPORT_LINES {
        lines.push(format!("… ({} more lines)", total - MAX_REPORT_LINES));
    }
    format!("\n\n[ground truth after edit]\n{}", lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unique scratch dir per test, removed on drop (house idiom — the crate
    /// has no tempfile dependency).
    struct Scratch(std::path::PathBuf);
    impl Scratch {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("atlas-probe-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&p).unwrap();
            Scratch(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn write(dir: &Path, name: &str, content: &str) -> std::path::PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, content).unwrap();
        p
    }

    #[test]
    fn a_clean_rust_file_probes_clean_and_a_broken_one_reports_a_line() {
        let tmp = Scratch::new();
        let ok = write(tmp.path(), "ok.rs", "fn main() { println!(\"hi\"); }\n");
        assert_eq!(parse_probe(&ok), Some(Vec::new()));

        let bad = write(tmp.path(), "bad.rs", "fn main() {\n    let x = ;\n}\n");
        let findings = parse_probe(&bad).unwrap();
        assert!(!findings.is_empty());
        assert!(findings[0].line >= 1 && findings[0].line <= 3, "{findings:?}");
    }

    #[test]
    fn typescript_python_and_unknown_extensions_behave() {
        let tmp = Scratch::new();
        let ts = write(tmp.path(), "a.ts", "const x: number = ;\n");
        assert!(!parse_probe(&ts).unwrap().is_empty());

        let py = write(tmp.path(), "a.py", "def f(:\n    pass\n");
        assert!(!parse_probe(&py).unwrap().is_empty());

        let ok_py = write(tmp.path(), "b.py", "def f():\n    return 1\n");
        assert_eq!(parse_probe(&ok_py), Some(Vec::new()));

        let md = write(tmp.path(), "notes.md", "# not code\n");
        assert_eq!(parse_probe(&md), None);
    }

    #[test]
    fn findings_are_capped_per_file() {
        let tmp = Scratch::new();
        let junk = "let ; ".repeat(50);
        let bad = write(tmp.path(), "many.rs", &junk);
        let findings = parse_probe(&bad).unwrap();
        assert!(findings.len() <= MAX_ERRORS_PER_FILE);
        assert!(!findings.is_empty());
    }

    #[test]
    fn check_config_loads_caps_and_rejects_garbage() {
        let tmp = Scratch::new();
        std::fs::create_dir_all(tmp.path().join(".atlas")).unwrap();
        assert_eq!(load_check_config(tmp.path()), None);

        std::fs::write(
            tmp.path().join(CHECK_CONFIG_REL),
            r#"{"command": "cargo check --quiet", "timeout_secs": 300}"#,
        )
        .unwrap();
        let cfg = load_check_config(tmp.path()).unwrap();
        assert_eq!(cfg.command, "cargo check --quiet");
        assert_eq!(cfg.timeout_secs(), CHECK_MAX_TIMEOUT_SECS, "timeout is capped");

        std::fs::write(tmp.path().join(CHECK_CONFIG_REL), r#"{"cmd": "typo"}"#).unwrap();
        assert_eq!(load_check_config(tmp.path()), None, "unknown fields reject");

        std::fs::write(tmp.path().join(CHECK_CONFIG_REL), r#"{"command": "  "}"#).unwrap();
        assert_eq!(load_check_config(tmp.path()), None, "blank command is absent");
    }

    #[tokio::test]
    async fn the_check_command_is_silent_on_success_and_tailed_on_failure() {
        let tmp = Scratch::new();
        let ok = CheckConfig { command: "true".into(), timeout_secs: Some(5) };
        assert_eq!(run_check(&ok, tmp.path()).await, None);

        let bad = CheckConfig {
            command: "echo broken-thing >&2; exit 1".into(),
            timeout_secs: Some(5),
        };
        let report = run_check(&bad, tmp.path()).await.unwrap();
        assert!(report.contains("broken-thing"), "{report}");
        assert!(report.contains("exit"), "{report}");
    }

    #[tokio::test]
    async fn a_hung_check_command_times_out_without_failing_the_edit() {
        let tmp = Scratch::new();
        let hung = CheckConfig { command: "sleep 30".into(), timeout_secs: Some(1) };
        let started = std::time::Instant::now();
        let report = run_check(&hung, tmp.path()).await.unwrap();
        assert!(report.contains("timed out"), "{report}");
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
    }

    #[test]
    fn the_report_is_bounded_and_prefixed() {
        let findings: Vec<ParseFinding> = (1..=30)
            .map(|i| ParseFinding { line: i, detail: "syntax error".into() })
            .collect();
        let report = render_report(&[("src/a.rs".into(), findings)], Some("exit 1\nboom"));
        let lines: Vec<&str> = report.lines().collect();
        // header + blank + capped body + overflow marker
        assert!(lines.len() <= MAX_REPORT_LINES + 4, "{} lines", lines.len());
        assert!(report.contains("[ground truth after edit]"));
        assert!(report.contains("… ("), "overflow is marked, not silent");

        assert_eq!(render_report(&[("f".into(), Vec::new())], None), "");
    }
}
