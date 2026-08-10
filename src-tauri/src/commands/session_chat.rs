//! Session-Chat — grounded chat over one recorded Session.
//!
//! The Timeline's detail view *shows* everything a Session recorded; this
//! answers questions about it. "What changed in `capture.rs`", "review this
//! session", "what was `3d97807` for" — all questions whose answers are already
//! in the store and take six hundred rows of scrolling to assemble by hand.
//!
//! **Retrieval only.** Generation goes through the existing BYOK provider path
//! (`modelchat_send`), exactly as Memory ▸ Chat's provider mode does: this
//! command returns an augmented prompt and the frontend streams it. Nothing here
//! talks to a network.
//!
//! ## Why lexical and not embeddings
//!
//! A Session is a *bounded* corpus — hundreds of entries, not a codebase — and
//! the questions people ask about one are dominated by exact terms: a file path,
//! a commit SHA, a tool name. BM25 is precise for exactly that, costs nothing to
//! run, and needs no model download, so the API key is the only thing standing
//! between a user and the feature. The seam is one function ([`rank`]) if that
//! ever needs to become a vector search.
//!
//! ## What the model is given
//!
//! Three layers, in descending order of certainty:
//!
//! 1. **The brief** — always present. Metrics, every Checkpoint with its real
//!    SHA and diffstat, the tool tally, and the file-touch table. This alone
//!    answers "what changed here" and "what was each commit for", so those
//!    questions never depend on retrieval finding the right rows.
//! 2. **Exact hits** — payloads for any path or SHA named in the question, plus
//!    the actual commit diff for that path from git.
//! 3. **Ranked entries** — the top-scoring conversation and tool entries.
//!
//! When the budget runs out, layer 3 is dropped before layer 2 and layer 1 is
//! never dropped: a thinner answer beats a confidently wrong one.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::process::Command;

use serde::{Deserialize, Serialize};

use atlas_checkpoint::{EntryKind, SessionDetail, TimelineEntry};

/// How many ranked entries reach the prompt.
const TOP_K: usize = 12;

/// How much of one entry's text is kept.
const PER_ENTRY_CHARS: usize = 1200;

/// How much of one exact-hit payload is kept. Larger than a ranked entry: the
/// question named this file, so its content *is* the answer.
const PER_HIT_CHARS: usize = 2400;

/// How much of one `git show` diff is kept.
const PER_DIFF_CHARS: usize = 3000;

/// Total prompt ceiling. Roughly 6 K tokens of context, which leaves room in
/// every provider's window for the conversation and the answer.
const MAX_PROMPT_CHARS: usize = 24_000;

/// Files in a Checkpoint's list before it is summarised as "+N more".
const FILES_PER_CHECKPOINT: usize = 20;

// ── Wire ─────────────────────────────────────────────────────────────────────

/// One thing the answer was grounded in, for the "sources" strip under a reply.
///
/// `Deserialize` as well as `Serialize` because these are saved with the thread:
/// a reopened conversation whose citations had been dropped would show its
/// answers with no way to check them, which is the opposite of grounded.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRef {
    /// `checkpoint`, `tool_call`, `prompt`, `response`, `thinking`, `file`.
    pub kind: String,
    /// What to show: a commit subject, a tool name, a path, a snippet of prose.
    pub label: String,
    /// The entry id, so the UI can jump the timeline to it.
    pub entry_id: Option<String>,
    /// Set for Checkpoints, so a citation can jump by commit.
    pub commit_sha: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrieveResult {
    /// The augmented user turn to send to the provider.
    pub prompt: String,
    pub sources: Vec<SourceRef>,
}

// ── Command ──────────────────────────────────────────────────────────────────

/// Assemble the grounded prompt for one question about one Session.
///
/// `checkpoints` holds commit SHAs to scope the answer to; `None` or empty
/// grounds on the whole Session.
#[tauri::command]
pub async fn session_chat_retrieve(
    project_path: String,
    session_id: String,
    query: String,
    checkpoints: Option<Vec<String>>,
) -> Result<RetrieveResult, String> {
    if query.trim().is_empty() {
        return Err("empty query".into());
    }

    // Reuse the viewer's own read model rather than querying the store here.
    // The detail is what the user is looking at, so grounding on anything else
    // would let the answer and the screen disagree.
    let mut detail = super::capture::artifacts_session(project_path.clone(), session_id)
        .await?
        .ok_or("session not found")?;

    // Scope BEFORE building. Every layer below (the brief, exact hits, ranked
    // entries, the character budget) reads `detail.entries`, so filtering here
    // scopes all of them at once — and none of them need to know that scoping
    // exists.
    let scope = checkpoints.unwrap_or_default();
    let scoped = if scope.is_empty() {
        None
    } else {
        let total = count_checkpoints(&detail);
        detail.entries = scope_to_checkpoints(&detail.entries, &scope);
        Some((scope, total))
    };

    let root = std::path::PathBuf::from(&project_path);
    tauri::async_runtime::spawn_blocking(move || build(&detail, &root, &query, scoped.as_ref()))
        .await
        .map_err(|e| e.to_string())
}

fn count_checkpoints(detail: &SessionDetail) -> usize {
    detail
        .entries
        .iter()
        .filter(|e| matches!(e.kind, EntryKind::Checkpoint))
        .count()
}

/// Keep only the entries belonging to the selected Checkpoints.
///
/// A Checkpoint's SPAN is the run of entries after the previous Checkpoint up to
/// and including it — the prompts, tool calls and responses that produced the
/// commit. Taking the Checkpoint entry alone would give the model a diffstat and
/// nothing else, which answers "what files changed" but never "why", and the
/// second question is the one people scope a chat to ask.
///
/// Entries arrive ordered, so this is one pass: accumulate a run, and when a
/// Checkpoint closes it, keep the run if that Checkpoint was selected.
fn scope_to_checkpoints(entries: &[TimelineEntry], shas: &[String]) -> Vec<TimelineEntry> {
    let selected: HashSet<&str> = shas.iter().map(|s| s.as_str()).collect();
    let mut out: Vec<TimelineEntry> = Vec::new();
    let mut run: Vec<TimelineEntry> = Vec::new();

    for entry in entries {
        let is_checkpoint = matches!(entry.kind, EntryKind::Checkpoint);
        run.push(entry.clone());
        if !is_checkpoint {
            continue;
        }
        let keep = entry
            .commit_sha
            .as_deref()
            .is_some_and(|sha| selected.contains(sha));
        if keep {
            out.append(&mut run);
        } else {
            run.clear();
        }
    }
    // Trailing entries after the last Checkpoint belong to no span and are
    // dropped: they are work that has not been committed yet, and the reader
    // asked about specific commits.
    out
}

/// `scope` is `(selected shas, total Checkpoints in the Session)` when the
/// caller narrowed the record, and `None` when it did not.
fn build(
    detail: &SessionDetail,
    root: &Path,
    query: &str,
    scope: Option<&(Vec<String>, usize)>,
) -> RetrieveResult {
    let mut sources: Vec<SourceRef> = Vec::new();
    let mut out = String::with_capacity(MAX_PROMPT_CHARS / 2);

    out.push_str(PREAMBLE);
    out.push_str("\n\n");
    out.push_str(&brief(detail, &mut sources));

    // Say so explicitly. The preamble promises the answer is grounded in "the
    // record below"; if that record is a slice of the Session, a model that
    // does not know it will read absence as "it never happened" and state that
    // as fact.
    if let Some((shas, total)) = scope {
        let short: Vec<String> = shas.iter().map(|s| s.chars().take(7).collect()).collect();
        out.push_str(&format!(
            "\n> Scope: this record covers {} of {} Checkpoint(s) in the Session — {}. \
             Work outside those commits is NOT included; if the question is about it, say the \
             selected Checkpoints do not cover it rather than answering from silence.\n\n",
            shas.len(),
            total,
            short.join(", "),
        ));
    }

    // Layer 2 before layer 3, and measured against the budget, so an exact hit
    // is never crowded out by a merely-plausible one.
    let hits = exact_hits(detail, root, query, &mut sources);
    let ranked = ranked_entries(detail, query, &mut sources);

    let mut remaining = MAX_PROMPT_CHARS.saturating_sub(out.len() + query.len() + 200);
    for section in hits {
        if section.len() > remaining {
            break;
        }
        remaining -= section.len();
        out.push_str(&section);
    }
    for section in ranked {
        if section.len() > remaining {
            break;
        }
        remaining -= section.len();
        out.push_str(&section);
    }

    out.push_str("\n## The question\n\n");
    out.push_str(query);

    RetrieveResult { prompt: out, sources }
}

const PREAMBLE: &str = "\
You are answering questions about ONE recorded coding session, using only the record below.

Rules:
- Ground every claim in the record. If it does not contain the answer, say so plainly \
rather than inferring one — \"the session did not record that\" is a useful answer.
- Cite commits by their short SHA and files by their path, so the reader can jump to them.
- Numbers (line counts, token counts, durations) come from the record verbatim. Never estimate one.
- When a diagram genuinely clarifies the answer, emit a ```mermaid fenced block. Do not \
produce one for its own sake.
- For a review, be specific about what changed and where; a review that could describe any \
session is not a review.";

// ── Layer 1: the brief ───────────────────────────────────────────────────────

/// The Session's own facts. Cheap, small, and the answer to most questions.
fn brief(detail: &SessionDetail, sources: &mut Vec<SourceRef>) -> String {
    let s = &detail.summary;
    let mut out = String::from("## Session\n\n");

    let line = |out: &mut String, k: &str, v: String| {
        if !v.is_empty() {
            out.push_str(&format!("- {k}: {v}\n"));
        }
    };
    line(&mut out, "Title", s.title.clone().unwrap_or_default());
    line(&mut out, "Agent", s.agent.clone().unwrap_or_default());
    line(&mut out, "Model", s.model.clone().unwrap_or_default());
    line(&mut out, "Branch", s.branches.first().cloned().unwrap_or_default());
    line(&mut out, "Started", s.started_at.clone());
    line(&mut out, "Duration", format!("{} minutes", s.duration_seconds / 60));
    line(
        &mut out,
        "Turns",
        format!("{} messages, {} tool calls", s.message_count, s.tool_call_count),
    );
    if s.total_tokens > 0 {
        line(&mut out, "Tokens", format!("{}", s.total_tokens));
    } else if let Some(used) = s.context_used {
        line(&mut out, "Context used", format!("{used} tokens"));
    }
    if s.insertions > 0 || s.deletions > 0 {
        line(
            &mut out,
            "Committed changes",
            format!(
                "+{} -{} across {} files",
                s.insertions, s.deletions, s.files_touched
            ),
        );
    }
    // Stated rather than left implicit: an imported Session has no linked
    // commits and no token split, and an answer that does not know that will
    // read the absence as "nothing changed".
    if s.source == "external_jsonl" {
        out.push_str(
            "- Note: imported from a transcript on disk. Commits are not linked to imported \
             history and token usage was not recorded, so their absence here means \"not \
             captured\", not \"none\".\n",
        );
    }
    if s.needs_attention {
        if let Some(reason) = &s.attention_reason {
            out.push_str(&format!("- Incomplete record: {reason}\n"));
        }
    }

    // ── Checkpoints ──
    let checkpoints: Vec<&TimelineEntry> =
        detail.entries.iter().filter(|e| e.kind == EntryKind::Checkpoint).collect();
    if !checkpoints.is_empty() {
        out.push_str("\n## Commits this session produced\n\n");
        for cp in &checkpoints {
            let sha = cp.commit_sha.as_deref().unwrap_or("unknown");
            let short = sha.get(..7).unwrap_or(sha);
            let subject = cp.commit_subject.as_deref().unwrap_or("(subject unavailable)");
            out.push_str(&format!("### {short} — {subject}\n"));
            if let Some(branch) = &cp.branch {
                out.push_str(&format!("- branch: {branch}\n"));
            }
            out.push_str(&format!("- diffstat: +{} -{}\n", cp.insertions, cp.deletions));
            if !cp.files.is_empty() {
                out.push_str("- files:\n");
                for f in cp.files.iter().take(FILES_PER_CHECKPOINT) {
                    out.push_str(&format!("  - {f}\n"));
                }
                if cp.files.len() > FILES_PER_CHECKPOINT {
                    out.push_str(&format!(
                        "  - (+{} more)\n",
                        cp.files.len() - FILES_PER_CHECKPOINT
                    ));
                }
            }
            sources.push(SourceRef {
                kind: "checkpoint".into(),
                label: format!("{short} {subject}"),
                entry_id: Some(cp.id.clone()),
                commit_sha: cp.commit_sha.clone(),
            });
        }
    }

    // ── Tools ──
    if !detail.tools.is_empty() {
        out.push_str("\n## Tools used\n\n");
        for tally in &detail.tools {
            out.push_str(&format!("- {} × {}\n", tally.count, tally.tool_name));
        }
    }

    // ── Files ──
    let touches = file_touches(detail);
    if !touches.is_empty() {
        out.push_str("\n## Files this session touched\n\n");
        for (path, t) in &touches {
            let mut parts = Vec::new();
            if t.edited > 0 {
                parts.push(format!("edited {}×", t.edited));
            }
            if t.read > 0 {
                parts.push(format!("read {}×", t.read));
            }
            if t.committed {
                parts.push("committed".into());
            }
            out.push_str(&format!("- {path} — {}\n", parts.join(", ")));
        }
    }

    out
}

#[derive(Default)]
struct Touch {
    read: usize,
    edited: usize,
    committed: bool,
}

/// Which files the Session read, edited, and landed — folded into one table.
fn file_touches(detail: &SessionDetail) -> BTreeMap<String, Touch> {
    let mut map: BTreeMap<String, Touch> = BTreeMap::new();
    for entry in &detail.entries {
        match entry.kind {
            EntryKind::ToolCall => {
                let writes = is_writer(entry.tool_name.as_deref());
                for path in &entry.paths {
                    let t = map.entry(path.clone()).or_default();
                    if writes {
                        t.edited += 1;
                    } else {
                        t.read += 1;
                    }
                }
            }
            EntryKind::Checkpoint => {
                for path in &entry.files {
                    map.entry(path.clone()).or_default().committed = true;
                }
            }
            _ => {}
        }
    }
    map
}

/// Canonical tool names are lowercased by the recorder, so this matches on the
/// canonical form rather than the per-agent wire name.
fn is_writer(tool: Option<&str>) -> bool {
    matches!(
        tool.unwrap_or_default().to_ascii_lowercase().as_str(),
        "edit" | "write" | "multiedit" | "notebookedit" | "str_replace_editor" | "apply_patch"
    )
}

// ── Layer 2: exact hits ──────────────────────────────────────────────────────

/// Payloads and diffs for anything the question named outright.
///
/// A question that says `capture.rs` is asking about that file specifically, and
/// letting a ranker decide whether to include it would sometimes lose to an
/// entry that merely mentions it more often.
fn exact_hits(
    detail: &SessionDetail,
    root: &Path,
    query: &str,
    sources: &mut Vec<SourceRef>,
) -> Vec<String> {
    let lower = query.to_ascii_lowercase();
    let mut out = Vec::new();

    // ── Paths ──
    let mut named: Vec<String> = Vec::new();
    for path in file_touches(detail).keys() {
        // Match on the basename too: people ask about `capture.rs`, not
        // `src-tauri/src/commands/capture.rs`.
        let base = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
        if lower.contains(&path.to_ascii_lowercase()) || (base.len() > 3 && lower.contains(&base)) {
            named.push(path.clone());
        }
    }
    named.truncate(4);

    for path in &named {
        let mut section = format!("\n## What the session did to `{path}`\n\n");

        for entry in detail.entries.iter().filter(|e| e.kind == EntryKind::ToolCall) {
            if !entry.paths.iter().any(|p| p == path) {
                continue;
            }
            let tool = entry.tool_name.as_deref().unwrap_or("tool");
            section.push_str(&format!("### {tool} (turn {})\n", entry.turn_seq));
            if let Some(args) = &entry.arguments {
                section.push_str("Arguments:\n```json\n");
                section.push_str(&clip(args, PER_HIT_CHARS / 2));
                section.push_str("\n```\n");
            }
            if let Some(result) = &entry.result {
                section.push_str("Result:\n```\n");
                section.push_str(&clip(result, PER_HIT_CHARS / 2));
                section.push_str("\n```\n");
            }
            sources.push(SourceRef {
                kind: "tool_call".into(),
                label: format!("{tool} {path}"),
                entry_id: Some(entry.id.clone()),
                commit_sha: None,
            });
        }

        // The commit diff, which is the literal answer to "what changed".
        for cp in detail.entries.iter().filter(|e| e.kind == EntryKind::Checkpoint) {
            if !cp.files.iter().any(|f| f == path) {
                continue;
            }
            let Some(sha) = &cp.commit_sha else { continue };
            if let Some(diff) = git_show(root, sha, path) {
                let short = sha.get(..7).unwrap_or(sha);
                section.push_str(&format!("### Committed in {short}\n```diff\n"));
                section.push_str(&clip(&diff, PER_DIFF_CHARS));
                section.push_str("\n```\n");
            }
        }

        sources.push(SourceRef {
            kind: "file".into(),
            label: path.clone(),
            entry_id: None,
            commit_sha: None,
        });
        out.push(section);
    }

    // ── SHAs ──
    for cp in detail.entries.iter().filter(|e| e.kind == EntryKind::Checkpoint) {
        let Some(sha) = &cp.commit_sha else { continue };
        let short = sha.get(..7).unwrap_or(sha);
        if !lower.contains(&short.to_ascii_lowercase()) {
            continue;
        }
        // Already covered if the question also named one of its files.
        if named.iter().any(|p| cp.files.contains(p)) {
            continue;
        }
        if let Some(diff) = git_show_commit(root, sha) {
            out.push(format!(
                "\n## Commit {short} in full\n\n```diff\n{}\n```\n",
                clip(&diff, PER_DIFF_CHARS)
            ));
        }
    }

    out
}

/// One file's diff in one commit. `None` when git cannot resolve it — a moved
/// repository or a rewritten history, both of which are normal states here.
fn git_show(root: &Path, sha: &str, path: &str) -> Option<String> {
    run_git(root, &["show", "--format=", "--no-color", sha, "--", path])
}

fn git_show_commit(root: &Path, sha: &str) -> Option<String> {
    run_git(root, &["show", "--stat", "--no-color", sha])
}

fn run_git(root: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git").current_dir(root).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

// ── Layer 3: ranked entries ──────────────────────────────────────────────────

/// The top-scoring entries for the question.
fn ranked_entries(
    detail: &SessionDetail,
    query: &str,
    sources: &mut Vec<SourceRef>,
) -> Vec<String> {
    let scored = rank(&detail.entries, query);
    if scored.is_empty() {
        return Vec::new();
    }

    let mut out = vec!["\n## Relevant moments in the session\n".to_string()];
    for entry in scored {
        let kind = match entry.kind {
            EntryKind::Prompt => "Prompt",
            EntryKind::Response => "Response",
            EntryKind::Thinking => "Thinking",
            EntryKind::ToolCall => "Tool call",
            EntryKind::Checkpoint => continue, // already in the brief, in full
        };
        let mut section = format!("\n### {kind} (turn {})\n", entry.turn_seq);
        if let Some(tool) = &entry.tool_name {
            section.push_str(&format!("Tool: {tool}\n"));
            if !entry.paths.is_empty() {
                section.push_str(&format!("Paths: {}\n", entry.paths.join(", ")));
            }
        }
        section.push_str("```\n");
        section.push_str(&clip(&searchable(entry), PER_ENTRY_CHARS));
        section.push_str("\n```\n");

        sources.push(SourceRef {
            kind: kind.to_ascii_lowercase().replace(' ', "_"),
            label: clip(&searchable(entry).replace('\n', " "), 80),
            entry_id: Some(entry.id.clone()),
            commit_sha: None,
        });
        out.push(section);
    }
    out
}

/// BM25 over the Session's entries.
///
/// The one function to replace if this ever becomes a vector search. Standard
/// parameters (k1 = 1.2, b = 0.75); the corpus is the Session, so "inverse
/// document frequency" means "rare within this session", which is exactly the
/// right notion — a term in every entry says nothing about which entry to show.
fn rank<'a>(entries: &'a [TimelineEntry], query: &str) -> Vec<&'a TimelineEntry> {
    const K1: f64 = 1.2;
    const B: f64 = 0.75;

    let terms = tokenize(query);
    if terms.is_empty() {
        return Vec::new();
    }
    let unique: HashSet<&String> = terms.iter().collect();

    // Checkpoints are excluded: the brief already carries every one of them in
    // full, so ranking them in would spend the budget re-stating what is there.
    let docs: Vec<(&TimelineEntry, Vec<String>)> = entries
        .iter()
        .filter(|e| e.kind != EntryKind::Checkpoint)
        .map(|e| (e, tokenize(&searchable(e))))
        .filter(|(_, t)| !t.is_empty())
        .collect();
    if docs.is_empty() {
        return Vec::new();
    }

    let n = docs.len() as f64;
    let avg_len = docs.iter().map(|(_, t)| t.len()).sum::<usize>() as f64 / n;

    let mut doc_freq: HashMap<&str, f64> = HashMap::new();
    for term in &unique {
        let count = docs
            .iter()
            .filter(|(_, tokens)| tokens.iter().any(|t| t == *term))
            .count() as f64;
        doc_freq.insert(term.as_str(), count);
    }

    let mut scored: Vec<(f64, &TimelineEntry)> = docs
        .iter()
        .map(|(entry, tokens)| {
            let len = tokens.len() as f64;
            let mut score = 0.0;
            for term in &unique {
                let tf = tokens.iter().filter(|t| *t == *term).count() as f64;
                if tf == 0.0 {
                    continue;
                }
                let df = doc_freq.get(term.as_str()).copied().unwrap_or(0.0);
                // The +1 inside the log keeps the IDF positive for a term that
                // appears in every entry, so a common term contributes little
                // rather than subtracting from the score.
                let idf = (((n - df + 0.5) / (df + 0.5)) + 1.0).ln();
                score += idf * (tf * (K1 + 1.0)) / (tf + K1 * (1.0 - B + B * len / avg_len));
            }
            (score, *entry)
        })
        .filter(|(score, _)| *score > 0.0)
        .collect();

    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(TOP_K);
    // Back into timeline order: a set of moments reads as a narrative when it is
    // chronological and as a list of fragments when it is sorted by score.
    scored.sort_by_key(|(_, entry)| entry.turn_seq);
    scored.into_iter().map(|(_, e)| e).collect()
}

/// Everything about an entry that a question could match on.
fn searchable(entry: &TimelineEntry) -> String {
    let mut parts: Vec<&str> = Vec::new();
    if let Some(text) = &entry.text {
        parts.push(text);
    }
    if let Some(tool) = &entry.tool_name {
        parts.push(tool);
    }
    if let Some(title) = &entry.tool_title {
        parts.push(title);
    }
    if let Some(args) = &entry.arguments {
        parts.push(args);
    }
    if let Some(result) = &entry.result {
        parts.push(result);
    }
    if let Some(subject) = &entry.commit_subject {
        parts.push(subject);
    }
    let mut joined = parts.join("\n");
    for path in &entry.paths {
        joined.push('\n');
        joined.push_str(path);
    }
    joined
}

/// Lowercased alphanumeric terms.
///
/// `/` and `.` split rather than join, so `src/commands/capture.rs` yields
/// `src`, `commands`, `capture`, `rs` — which is what makes a question about
/// `capture.rs` match an entry that only ever wrote the full path.
fn tokenize(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|t| t.len() > 1)
        .map(|t| t.to_ascii_lowercase())
        .collect()
}

/// Truncate on a character boundary, saying so when it cuts.
fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let kept: String = text.chars().take(max).collect();
    format!("{kept}\n… (truncated)")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, kind: EntryKind, text: &str, turn: i64) -> TimelineEntry {
        TimelineEntry {
            id: id.into(),
            kind,
            at: "2026-07-30T00:00:00Z".into(),
            turn_seq: turn,
            text: Some(text.into()),
            truncated: false,
            body_bytes: text.len() as i64,
            body_ref: None,
            tool_name: None,
            tool_title: None,
            tool_status: None,
            paths: Vec::new(),
            arguments: None,
            arguments_ref: None,
            result: None,
            result_ref: None,
            result_binary: false,
            commit_sha: None,
            commit_subject: None,
            branch: None,
            link_state: None,
            insertions: 0,
            deletions: 0,
            files: Vec::new(),
        }
    }

    #[test]
    fn tokenize_splits_paths_into_parts() {
        let tokens = tokenize("src/commands/capture.rs");
        assert!(tokens.contains(&"capture".to_string()));
        assert!(tokens.contains(&"commands".to_string()));
        assert!(tokens.contains(&"rs".to_string()));
    }

    #[test]
    fn tokenize_drops_single_characters() {
        assert!(tokenize("a bb c ddd").iter().all(|t| t.len() > 1));
    }

    #[test]
    fn rank_keeps_only_entries_that_share_a_term() {
        let entries = vec![
            entry("a", EntryKind::Response, "we changed the watcher and the poller", 1),
            entry("b", EntryKind::Response, "capture.rs now guards the writer lock", 2),
            entry("c", EntryKind::Response, "unrelated prose about colours", 3),
        ];
        let ids: Vec<&str> =
            rank(&entries, "what changed in capture.rs").iter().map(|e| e.id.as_str()).collect();
        // "a" shares "changed", "b" shares "capture"/"rs" — both are legitimate
        // context. "c" shares nothing and must not consume budget.
        assert!(ids.contains(&"b"));
        assert!(!ids.contains(&"c"));
    }

    #[test]
    fn rank_scores_the_distinctive_term_above_the_common_one() {
        // "session" is in every entry, so it must not decide the outcome; only
        // "capture" is discriminating.
        let entries = vec![
            entry("common", EntryKind::Response, "session session session session", 1),
            entry("hit", EntryKind::Response, "session capture", 2),
        ];
        let ids: Vec<&str> = rank(&entries, "capture session").iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, vec!["common", "hit"], "both match, chronologically");

        // With the common term alone dropped from the query, only the hit survives.
        let ids: Vec<&str> = rank(&entries, "capture").iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, vec!["hit"]);
    }

    #[test]
    fn rank_returns_nothing_for_a_query_with_no_overlap() {
        let entries = vec![entry("a", EntryKind::Response, "alpha beta gamma", 1)];
        assert!(rank(&entries, "zzz qqq").is_empty());
    }

    #[test]
    fn rank_restores_chronological_order() {
        let entries = vec![
            entry("a", EntryKind::Response, "watcher watcher watcher", 3),
            entry("b", EntryKind::Response, "watcher", 1),
        ];
        let ranked = rank(&entries, "watcher");
        assert_eq!(
            ranked.iter().map(|e| e.turn_seq).collect::<Vec<_>>(),
            vec![1, 3],
            "highest-scoring first would read as fragments, not a narrative",
        );
    }

    #[test]
    fn rank_excludes_checkpoints_because_the_brief_has_them_whole() {
        let entries = vec![entry("cp", EntryKind::Checkpoint, "watcher fix", 1)];
        assert!(rank(&entries, "watcher").is_empty());
    }

    #[test]
    fn clip_marks_what_it_cut() {
        let clipped = clip(&"x".repeat(50), 10);
        assert!(clipped.ends_with("(truncated)"));
        assert!(clipped.starts_with(&"x".repeat(10)));
    }

    #[test]
    fn clip_leaves_short_text_alone() {
        assert_eq!(clip("short", 100), "short");
    }

    #[test]
    fn clip_does_not_split_a_multibyte_character() {
        // Byte-slicing "日本語" at 2 would panic; character-slicing must not.
        assert_eq!(clip("日本語です", 2), "日本\n… (truncated)");
    }

    #[test]
    fn is_writer_recognises_canonical_names() {
        assert!(is_writer(Some("edit")));
        assert!(is_writer(Some("Write")));
        assert!(!is_writer(Some("read")));
        assert!(!is_writer(None));
    }
}
