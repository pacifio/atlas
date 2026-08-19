//! Contract C4 — the one shared session-log parser. Mines Claude Code
//! JSONL (`~/.claude/projects/`) and the native Cersei session store
//! (`<config>/cersei-sessions/`) into two local JSONL outputs:
//!
//! - `harness-baseline.jsonl` — one line per session: tool mix, edit
//!   failure counts, token totals. The harness workstream's baseline data.
//! - `retrieval-candidates.jsonl` — prompt anchors, grep patterns, bash
//!   searches, and touched-file targets. The retrieval workstream's
//!   query/label candidates.
//!
//! Output contains real prompt and command content, so it lives under the
//! gitignored `evals/harvest/` and never leaves the machine. Tool names are
//! folded into the same canonical buckets as
//! `atlas-checkpoint/src/tools.rs::canonical_name` (Read/Edit/Write/Bash/
//! Search/Fetch/Think/Task) so cross-harness baselines compare like with
//! like — kept as a small local map rather than a dependency on the whole
//! checkpoint crate.

pub mod cersei;
pub mod claude;

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Per-session baseline metrics, source-agnostic.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SessionBaseline {
    pub source: String,
    pub session_id: String,
    pub cwd: String,
    pub user_prompts: u64,
    /// Canonical tool name → call count.
    pub tool_calls: BTreeMap<String, u64>,
    /// Canonical tool name → errored-result count.
    pub tool_errors: BTreeMap<String, u64>,
    pub edit_calls: u64,
    pub edit_errors: u64,
    pub bash_searches: u64,
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub models: BTreeSet<String>,
}

/// A retrieval query/label candidate.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Candidate {
    pub kind: CandidateKind,
    pub value: String,
    pub source: String,
    pub session_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateKind {
    /// A genuine user prompt — what a retrieval query would be built from.
    PromptAnchor,
    /// A Grep tool pattern.
    GrepPattern,
    /// A bash command that is itself a search (`rg`, `grep`, `find`, …).
    BashSearch,
    /// A file the session read or edited — a relevance label candidate.
    FileTarget,
}

/// Fold a wire tool name into the cross-harness canonical bucket.
pub fn canonical_tool(name: &str) -> String {
    match name {
        "Read" => "read",
        "Edit" | "MultiEdit" | "NotebookEdit" => "edit",
        "Write" => "write",
        "Bash" | "Shell" => "bash",
        "Grep" | "Glob" | "LS" | "List" | "CodeSearch" | "WebSearch" => "search",
        "WebFetch" | "Fetch" => "fetch",
        "TodoWrite" => "think",
        "Task" | "Agent" | "Delegate" => "task",
        other => return format!("other:{other}"),
    }
    .to_string()
}

/// Whether a bash command line is a search (any pipeline stage invoking a
/// search binary).
pub fn is_bash_search(command: &str) -> bool {
    command
        .split(['|', ';', '&', '\n'])
        .filter_map(|stage| stage.split_whitespace().next())
        .any(|bin| {
            let bin = bin.rsplit('/').next().unwrap_or(bin);
            matches!(bin, "rg" | "grep" | "egrep" | "fgrep" | "fd" | "find" | "ag" | "ugrep")
        })
}

/// What one harvest pass produced. Failures are counted, never silent.
#[derive(Debug, Default, Serialize)]
pub struct HarvestSummary {
    pub sessions_parsed: u64,
    pub sessions_failed: u64,
    pub candidates: u64,
    pub baseline_path: PathBuf,
    pub candidates_path: PathBuf,
}

/// Enumerate Claude Code session files under `root` (`~/.claude/projects`).
/// Temp-workspace project dirs (`/var/folders/...` cwds) are indexer noise
/// and are skipped.
pub fn claude_session_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let Ok(projects) = std::fs::read_dir(root) else {
        return files;
    };
    for project in projects.filter_map(|e| e.ok()) {
        let name = project.file_name().to_string_lossy().into_owned();
        if name.contains("-var-folders-") {
            continue;
        }
        let Ok(sessions) = std::fs::read_dir(project.path()) else {
            continue;
        };
        for f in sessions.filter_map(|e| e.ok()) {
            let p = f.path();
            if p.extension().is_some_and(|e| e == "jsonl") {
                files.push(p);
            }
        }
    }
    files.sort();
    files
}

/// Enumerate Cersei session documents under `root`
/// (`<config>/cersei-sessions`). Corruption backups are skipped.
pub fn cersei_session_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let Ok(hash_dirs) = std::fs::read_dir(root) else {
        return files;
    };
    for dir in hash_dirs.filter_map(|e| e.ok()) {
        let Ok(sessions) = std::fs::read_dir(dir.path()) else {
            continue;
        };
        for f in sessions.filter_map(|e| e.ok()) {
            let p = f.path();
            if p.extension().is_some_and(|e| e == "json")
                && !p.file_name().is_some_and(|n| n.to_string_lossy().contains(".corrupt-"))
            {
                files.push(p);
            }
        }
    }
    files.sort();
    files
}

/// Run the full harvest into `out_dir`.
pub fn run(claude_root: &Path, cersei_root: &Path, out_dir: &Path) -> Result<HarvestSummary, String> {
    std::fs::create_dir_all(out_dir).map_err(|e| format!("create {}: {e}", out_dir.display()))?;
    let baseline_path = out_dir.join("harness-baseline.jsonl");
    let candidates_path = out_dir.join("retrieval-candidates.jsonl");
    let mut baseline_file = create(&baseline_path)?;
    let mut candidates_file = create(&candidates_path)?;

    let mut summary = HarvestSummary {
        baseline_path: baseline_path.clone(),
        candidates_path: candidates_path.clone(),
        ..Default::default()
    };

    let mut emit = |parsed: Result<(SessionBaseline, Vec<Candidate>), String>| -> Result<(), String> {
        match parsed {
            Ok((baseline, candidates)) => {
                writeln!(
                    baseline_file,
                    "{}",
                    serde_json::to_string(&baseline).map_err(|e| e.to_string())?
                )
                .map_err(|e| e.to_string())?;
                for c in &candidates {
                    writeln!(
                        candidates_file,
                        "{}",
                        serde_json::to_string(c).map_err(|e| e.to_string())?
                    )
                    .map_err(|e| e.to_string())?;
                }
                summary.sessions_parsed += 1;
                summary.candidates += candidates.len() as u64;
            }
            Err(_) => summary.sessions_failed += 1,
        }
        Ok(())
    };

    for path in claude_session_files(claude_root) {
        emit(claude::parse_file(&path))?;
    }
    for path in cersei_session_files(cersei_root) {
        emit(cersei::parse_file(&path))?;
    }
    Ok(summary)
}

fn create(path: &Path) -> Result<std::fs::File, String> {
    std::fs::File::create(path).map_err(|e| format!("create {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_tool_folds_both_harnesses_into_shared_buckets() {
        assert_eq!(canonical_tool("Grep"), "search");
        assert_eq!(canonical_tool("List"), "search");
        assert_eq!(canonical_tool("MultiEdit"), "edit");
        assert_eq!(canonical_tool("TodoWrite"), "think");
        assert_eq!(canonical_tool("mcp__linear__save_issue"), "other:mcp__linear__save_issue");
    }

    #[test]
    fn bash_search_detection_sees_through_pipelines_and_paths() {
        assert!(is_bash_search("rg -n foo src/"));
        assert!(is_bash_search("cat f.txt | grep bar"));
        assert!(is_bash_search("/usr/bin/find . -name '*.rs'"));
        assert!(!is_bash_search("cargo test"));
        assert!(!is_bash_search("echo grep is a word here"));
    }

    #[test]
    fn claude_walker_skips_temp_workspace_projects() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("-Users-x-proj");
        let noise = tmp.path().join("-private-var-folders-ab-atlas-indexer-1");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::create_dir_all(&noise).unwrap();
        std::fs::write(real.join("s1.jsonl"), "").unwrap();
        std::fs::write(noise.join("s2.jsonl"), "").unwrap();
        let files = claude_session_files(tmp.path());
        assert_eq!(files.len(), 1);
        assert!(files[0].ends_with("-Users-x-proj/s1.jsonl"));
    }

    #[test]
    fn cersei_walker_skips_corruption_backups() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("abcd1234");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("s1.json"), "{}").unwrap();
        std::fs::write(dir.join("s2.json.corrupt-123"), "{}").unwrap();
        let files = cersei_session_files(tmp.path());
        assert_eq!(files.len(), 1);
    }

    #[test]
    fn run_writes_both_outputs_and_counts_failures() {
        let tmp = tempfile::tempdir().unwrap();
        let claude = tmp.path().join("claude/-Users-x-p");
        std::fs::create_dir_all(&claude).unwrap();
        std::fs::write(
            claude.join("good.jsonl"),
            r#"{"type":"user","sessionId":"s1","cwd":"/x","message":{"role":"user","content":"find the bug in the parser"}}"#,
        )
        .unwrap();
        // Invalid UTF-8 — an unreadable session document is a counted
        // failure (merely-malformed JSON lines are skipped per line instead).
        std::fs::write(claude.join("bad.jsonl"), [0xFFu8, 0xFE, 0x00]).unwrap();
        let cersei_root = tmp.path().join("cersei-sessions");
        std::fs::create_dir_all(cersei_root.join("h1")).unwrap();
        std::fs::write(
            cersei_root.join("h1/s2.json"),
            r#"{"session_id":"s2","cwd":"/y","provider":"anthropic","model":"m","updated_at":"t",
                "messages":[],"usage":{"input_tokens":10,"output_tokens":5,"cost":0.01}}"#,
        )
        .unwrap();

        let out = tmp.path().join("out");
        let summary = run(tmp.path().join("claude").as_path(), &cersei_root, &out).unwrap();
        assert_eq!(summary.sessions_parsed, 2);
        assert_eq!(summary.sessions_failed, 1);
        let baselines = std::fs::read_to_string(out.join("harness-baseline.jsonl")).unwrap();
        assert_eq!(baselines.lines().count(), 2);
        let cands = std::fs::read_to_string(out.join("retrieval-candidates.jsonl")).unwrap();
        assert!(cands.contains("find the bug in the parser"));
    }
}
