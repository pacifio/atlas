//! Reading agent transcripts that already exist on disk.
//!
//! This closes the two highest product risks in one mechanism.
//!
//! **Cold start.** A timeline's value is proportional to its history, and
//! without this the board ships empty and stays that way for months. Meanwhile a
//! developer's own transcripts are already sitting in `~/.claude/projects/` —
//! hundreds of Sessions, hundreds of megabytes. Importing them makes day one
//! look like month six.
//!
//! **The terminal gap.** Someone who runs `claude` in a terminal instead of
//! inside Atlas produces a Session that does not exist in Atlas, which reads as
//! a bug and permanently undermines trust in the record. The same reader that
//! backfills history keeps picking up new terminal Sessions as they appear.
//!
//! # Three rules that are not obvious
//!
//! **Imported Sessions get no Checkpoints.** The link rule needs
//! `existed_before` captured at write time, which is unknowable retroactively —
//! inferring it would manufacture exactly the false attribution the rule exists
//! to prevent. This is a deliberate divergence from Entire's importer, which
//! *does* reconstruct checkpoint records from old transcripts. It can, because
//! its checkpoints are self-contained snapshots making no attribution claim;
//! Atlas's assert "this Session produced this commit", and imported data cannot
//! honestly support that. Do not "fix" this later by copying Entire.
//!
//! **Cross-source dedupe is explicit work here, not a schema guarantee.** The
//! UNIQUE constraint covers `(workspace, source, native_id)` and therefore
//! dedupes *re-imports*. It does **not** dedupe across sources — Atlas's
//! ACP-hosted Claude Code writes JSONL to the very same directory, so
//! `('acp', id)` and `('external_jsonl', id)` are both permitted rows. Skipping
//! that duplicate is this module's job.
//!
//! **Redaction applies identically.** Imported content goes through the same
//! on-write scrubbing as live capture, titles included. An old transcript is
//! exactly as likely to contain a pasted key as a new one.
//!
//! # Failure containment
//!
//! One bad line costs that line; one bad file costs that file; only the store
//! itself failing stops the pass. The distinction matters because the importer
//! re-runs every thirty seconds forever: an error that propagated freely would
//! re-abort the same corpus on every tick, and a transcript sorting *after* the
//! poisoned one would never import at all.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::blobs;
use crate::capture::{Capture, SessionKey, ToolCallContent, TurnContent};
use crate::error::{Error, Result};
use crate::model::{Mode, Role, Source, TokenTotals, ToolStatus, WorkspaceMode};
use crate::store::Store;
use crate::tools::{canonical_name, ToolName};

/// What one import pass did.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub files_seen: usize,
    pub sessions_imported: usize,
    pub messages_imported: usize,
    /// Files skipped because the Session is already recorded under another
    /// source — an in-app Session whose agent also wrote its own transcript.
    pub skipped_already_captured: usize,
    /// Files with nothing new since the last pass.
    pub skipped_unchanged: usize,
    /// Lines that would not parse. Counted rather than fatal: a transcript being
    /// appended to while it is read ends mid-object, and one bad line must not
    /// cost the rest of the file.
    pub malformed_lines: usize,
    /// Lines that parsed but could not be recorded — a redaction failure, one
    /// unspillable payload. Counted for the same reason malformed lines are:
    /// the Session is flagged, the line is charged here, and the rest of the
    /// file (and every file after it) still imports.
    pub turns_failed: usize,
    /// Files whose import ended on a non-fatal error. The rest of the corpus
    /// imported anyway; only a store-level failure stops the pass.
    pub files_failed: usize,
}

/// What a bulk import is about to disclose.
///
/// Importing into a **Cloud** Workspace makes months of terminal conversations
/// org-visible in one action, which is a bulk disclosure and gets the same
/// real-numbers confirmation as Local→Cloud promotion. A Local Workspace needs
/// no ceremony, because nothing leaves the machine.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    /// Every transcript on disk, including ones an import would skip.
    pub session_count: usize,
    /// How many of those an import would actually take — already-imported files
    /// and cross-source duplicates excluded. This is the number the disclosure
    /// dialog must lead with; `session_count` alone over-promises. Equal to
    /// `session_count` when the preview was computed without a store to ask.
    pub new_session_count: usize,
    /// Oldest and newest transcript, as RFC3339. `None` when nothing was found.
    pub earliest: Option<String>,
    pub latest: Option<String>,
    pub total_bytes: u64,
    /// Whether confirming would publish this to an Organisation.
    pub is_bulk_disclosure: bool,
}

/// Where an agent keeps its transcripts for a given project directory.
///
/// Claude Code encodes the cwd into a folder name; the host passes the encoded
/// directory in rather than the crate reproducing that encoding, since the
/// runtime already owns it.
#[derive(Debug, Clone)]
pub struct TranscriptSource {
    pub directory: PathBuf,
}

impl TranscriptSource {
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        Self { directory: directory.into() }
    }

    /// Every transcript file, oldest first, so an interrupted import resumes in
    /// a stable order rather than re-shuffling on each pass.
    pub fn files(&self) -> Vec<PathBuf> {
        let Ok(entries) = std::fs::read_dir(&self.directory) else {
            return Vec::new();
        };
        let mut files: Vec<PathBuf> = entries
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
            .collect();
        files.sort();
        files
    }
}

/// What would be imported, without importing it.
///
/// Prefer [`preview_with_store`] when a store is at hand — it also reports how
/// many of the files a real import would take, which is what the disclosure
/// dialog should headline. Without a store every file counts as new.
pub fn preview(source: &TranscriptSource, mode: WorkspaceMode) -> ImportPreview {
    preview_inner(source, mode, None)
}

/// [`preview`], with the store consulted so already-imported files and
/// cross-source duplicates are excluded from `new_session_count`.
pub fn preview_with_store(
    store: &Store,
    workspace_id: &str,
    source: &TranscriptSource,
    mode: WorkspaceMode,
) -> ImportPreview {
    preview_inner(source, mode, Some((store, workspace_id)))
}

fn preview_inner(
    source: &TranscriptSource,
    mode: WorkspaceMode,
    store: Option<(&Store, &str)>,
) -> ImportPreview {
    let files = source.files();
    let mut total_bytes = 0u64;
    let mut new_session_count = 0usize;
    let mut timestamps: Vec<String> = Vec::new();

    for path in &files {
        let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        total_bytes += size;
        if let Some(first) = first_timestamp(path) {
            timestamps.push(first);
        }
        let is_new = match store {
            None => true,
            Some((store, workspace_id)) => would_import(store, workspace_id, path, size),
        };
        if is_new {
            new_session_count += 1;
        }
    }
    timestamps.sort();

    ImportPreview {
        session_count: files.len(),
        new_session_count,
        earliest: timestamps.first().cloned(),
        latest: timestamps.last().cloned(),
        total_bytes,
        is_bulk_disclosure: mode == WorkspaceMode::Cloud,
    }
}

/// Read-only mirror of [`import_file`]'s skip logic, so the preview's promise
/// matches what an import would actually do. A store error reads as "would
/// import" — over-promising a count beats under-stating a disclosure.
fn would_import(store: &Store, workspace_id: &str, path: &Path, size: u64) -> bool {
    let key = path.to_string_lossy().to_string();
    if size > 0 && store.import_progress(&key).ok().flatten() == Some(size) {
        return false;
    }
    let Some(native_session_id) = session_id_of(path) else {
        return false;
    };
    let imported_already = store
        .session_id_for(workspace_id, Source::ExternalJsonl, &native_session_id)
        .ok()
        .flatten()
        .is_some();
    if !imported_already
        && store
            .native_session_exists(workspace_id, &native_session_id)
            .unwrap_or(false)
    {
        // Captured live under another source; the importer will skip it.
        return false;
    }
    true
}

/// Errors that must stop the whole import pass, as opposed to costing one line
/// or one file.
///
/// `AlreadyLocked` means another window owns the store, `Storage` is the disk
/// itself (full, read-only, corrupt), and `SchemaTooNew` means this build must
/// not write at all — continuing past any of those would fail every subsequent
/// write identically. Everything else (a redaction failure, one unspillable
/// blob) is the fault of one piece of content, and one piece of content must
/// never cost the rest of the corpus.
fn is_fatal(err: &Error) -> bool {
    matches!(
        err,
        Error::AlreadyLocked | Error::Storage(_) | Error::SchemaTooNew { .. }
    )
}

/// Import every transcript in `source` that is not already recorded.
///
/// Progressive and resumable: per-file progress is persisted, so killing Atlas
/// mid-import resumes rather than restarting. Idempotent at the turn level too —
/// every line carries the agent's own message id (or a synthesised stand-in),
/// so re-reading a file that grew cannot duplicate the turns already taken from
/// it. A file that fails on a non-fatal error is counted and skipped; only a
/// store-level failure stops the pass.
pub fn import_all(
    store: &mut Store,
    workspace_id: &str,
    source: &TranscriptSource,
    mode: WorkspaceMode,
) -> Result<ImportOutcome> {
    let mut outcome = ImportOutcome::default();
    for path in source.files() {
        outcome.files_seen += 1;
        match import_file(store, workspace_id, &path, mode, &mut outcome) {
            Ok(()) => {}
            Err(err) if is_fatal(&err) => return Err(err),
            Err(_) => outcome.files_failed += 1,
        }
    }
    Ok(outcome)
}

/// Import one transcript file.
fn import_file(
    store: &mut Store,
    workspace_id: &str,
    path: &Path,
    mode: WorkspaceMode,
    outcome: &mut ImportOutcome,
) -> Result<()> {
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let key = path.to_string_lossy().to_string();

    // Nothing new since last time. Cheap enough to run on every watcher tick,
    // which is what makes the ongoing watch affordable.
    if store.import_progress(&key)? == Some(size) && size > 0 {
        outcome.skipped_unchanged += 1;
        return Ok(());
    }

    let Some(native_session_id) = session_id_of(path) else {
        return Ok(());
    };

    // Cross-source dedupe. The schema cannot do this — `source` differs, so both
    // rows are legal — and without it every in-app Session would be captured a
    // second time from the transcript its own agent wrote.
    if store
        .session_id_for(workspace_id, Source::ExternalJsonl, &native_session_id)?
        .is_none()
        && store.native_session_exists(workspace_id, &native_session_id)?
    {
        outcome.skipped_already_captured += 1;
        // Recorded as done so it is not re-examined on every pass.
        store.set_import_progress(&key, size)?;
        return Ok(());
    }

    let Ok(file) = File::open(path) else {
        return Ok(());
    };

    let session_key = SessionKey {
        workspace_id: workspace_id.to_string(),
        source: Source::ExternalJsonl,
        native_session_id: native_session_id.clone(),
    };

    let mut session_id: Option<String> = None;
    let mut turn_seq = 0i64;
    let mut imported_here = 0usize;
    let mut earliest: Option<DateTime<Utc>> = None;
    let mut clean_read = true;
    // The transcript names a call's tool only on its `tool_use` block; the
    // matching `tool_result` carries just the id. Remembered per file so the
    // result's upsert does not downgrade the stored name to `Other`.
    let mut call_meta: HashMap<String, (ToolName, i64)> = HashMap::new();
    // Usage, deduplicated by request — see `read_usage`. Accumulated for the
    // whole file and written once at the end, because the total is only true
    // once the file has been read.
    let mut usage_by_request: HashMap<String, TokenTotals> = HashMap::new();
    // `read_turn` only sees `message.model` on lines that carry text, so a
    // transcript whose assistant lines are all tool calls would never name its
    // model. Taken from any line that has one.
    let mut model_seen: Option<String> = None;
    let no_locations = serde_json::json!([]);

    {
        let mut capture = Capture::new(store, mode);

        for (line_index, line) in BufReader::new(file).lines().enumerate() {
            let Ok(line) = line else {
                // An I/O error mid-file ends this pass. `clean_read` keeps the
                // progress marker honest below — recording the full file size
                // here would permanently skip the unread tail.
                clean_read = false;
                break;
            };
            if line.trim().is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                // A transcript being appended to while it is read ends mid-object.
                outcome.malformed_lines += 1;
                continue;
            };

            // Sidechain lines are a subagent's own conversation, not this Session's,
            // and including them would double-count work under the wrong Session —
            // consistent with the existing replay behaviour.
            if value.get("isSidechain").and_then(serde_json::Value::as_bool) == Some(true) {
                continue;
            }
            // Meta lines are the harness talking to itself — injected context,
            // command envelopes — not something the developer said. Importing
            // them floods the timeline with machinery and, worse, lets a
            // command caveat become a Session's title.
            if value.get("isMeta").and_then(serde_json::Value::as_bool) == Some(true) {
                continue;
            }

            // Read before the "nothing usable here" filter below: a tool-only
            // assistant line produces no turn and no tool_result, and dropping
            // it would silently lose the usage of every tool-calling request.
            if let Some(line_usage) = read_usage(&value) {
                let slot = usage_by_request.entry(line_usage.key).or_default();
                // Per-field max rather than overwrite: two copies of one
                // request disagree when the first was written mid-stream, and
                // the finished one is the larger.
                slot.input_tokens = slot.input_tokens.max(line_usage.totals.input_tokens);
                slot.output_tokens = slot.output_tokens.max(line_usage.totals.output_tokens);
                slot.cache_creation_tokens =
                    slot.cache_creation_tokens.max(line_usage.totals.cache_creation_tokens);
                slot.cache_read_tokens =
                    slot.cache_read_tokens.max(line_usage.totals.cache_read_tokens);
            }
            // Assistant lines only: the model is a property of what answered,
            // and a user line that happens to carry one is echoing the client's
            // request rather than reporting what ran.
            if model_seen.is_none()
                && value.get("type").and_then(serde_json::Value::as_str) == Some("assistant")
            {
                model_seen = value
                    .get("message")
                    .and_then(|m| m.get("model"))
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string);
            }

            let created_at = line_timestamp(&value);
            let turn = read_turn(&value).filter(|t| !is_envelope(t));
            let tool_uses = read_tool_uses(&value);
            let tool_results = read_tool_results(&value);
            if turn.is_none() && tool_uses.is_empty() && tool_results.is_empty() {
                continue;
            }

            // The transcript's own clock, kept so imported history holds its
            // real dates — ordering, day grouping and the promotion preview all
            // read these timestamps back.
            if let Some(ts) = created_at {
                earliest = Some(earliest.map_or(ts, |seen| seen.min(ts)));
            }

            // The Session is created from its first usable line rather than up
            // front, so a transcript that is entirely sidechain or entirely
            // unparseable leaves no empty Session behind.
            let id = match &session_id {
                Some(id) => id.clone(),
                None => {
                    let (agent, model) = turn
                        .as_ref()
                        .map(|t| (t.agent.as_deref(), t.model.as_deref()))
                        .unwrap_or((None, None));
                    // No branch: an imported transcript is read long after the
                    // fact, and today's HEAD says nothing about where the work
                    // was done. Guessing it would be worse than leaving it
                    // empty — the same reason imported Sessions get no
                    // Checkpoints.
                    let id = capture.ensure_session(
                        &session_key,
                        agent.or(Some("claude-code")),
                        model,
                        None,
                        None,
                    )?;
                    session_id = Some(id.clone());
                    imported_here += 1;
                    id
                }
            };

            if let Some(turn) = turn {
                turn_seq += 1;

                // The title comes from the first *user* turn. Derivation fails
                // closed to "no title" inside capture, so a pathological prompt
                // cannot end the file here.
                if turn.role == Role::User {
                    capture.set_title_from_prompt(&id, &turn.body)?;
                }

                // The agent's own id when the line has one; otherwise a stable
                // synthetic key, so a grown file re-read never duplicates the
                // lines already taken from it.
                let native_id = turn
                    .native_id
                    .clone()
                    .unwrap_or_else(|| synthetic_line_id(line_index, &line));

                match capture.record_turn(
                    &id,
                    TurnContent {
                        turn_seq,
                        native_message_id: Some(native_id),
                        role: turn.role,
                        mode: turn.mode,
                        body: turn.body.clone(),
                        created_at,
                    },
                ) {
                    Ok(Some(_)) => outcome.messages_imported += 1,
                    Ok(None) => {}
                    Err(err) if is_fatal(&err) => return Err(err),
                    // One unrecordable line is that line's problem. The Session
                    // was already flagged by the capture path; charging the line
                    // here and continuing is what keeps a 44 MB transcript from
                    // being re-parsed and re-aborted on every 30-second tick.
                    Err(_) => outcome.turns_failed += 1,
                }
            }

            // Tool calls are their own rows — an explicit acceptance criterion:
            // imported Sessions must show the same facets as live ones. The
            // block id is the idempotency key, so re-reads are free.
            let call_turn = turn_seq.max(1);
            for tool_use in &tool_uses {
                let name =
                    canonical_name(Some(&tool_use.name), Some(&tool_use.name), None, &tool_use.input);
                call_meta.insert(tool_use.id.clone(), (name, call_turn));
                let arguments = tool_use.input.to_string();
                match capture.record_tool_call(
                    &id,
                    ToolCallContent {
                        turn_seq: call_turn,
                        native_call_id: Some(&tool_use.id),
                        tool_name: name,
                        title: Some(&tool_use.name),
                        kind: None,
                        // The transcript records outcomes on `tool_result`
                        // lines; until one arrives the honest status is that
                        // the call never finished.
                        status: ToolStatus::Pending,
                        locations: &no_locations,
                        arguments: Some(&arguments),
                        result: None,
                    },
                ) {
                    Ok(_) => {}
                    Err(err) if is_fatal(&err) => return Err(err),
                    Err(_) => outcome.turns_failed += 1,
                }
            }

            for tool_result in &tool_results {
                let (name, use_turn) = call_meta
                    .get(&tool_result.tool_use_id)
                    .copied()
                    .unwrap_or((ToolName::Other, call_turn));
                let status = if tool_result.is_error {
                    ToolStatus::Failed
                } else {
                    ToolStatus::Completed
                };
                match capture.record_tool_call(
                    &id,
                    ToolCallContent {
                        turn_seq: use_turn,
                        native_call_id: Some(&tool_result.tool_use_id),
                        tool_name: name,
                        title: None,
                        kind: None,
                        status,
                        locations: &no_locations,
                        arguments: None,
                        result: tool_result.body.as_deref().map(str::as_bytes),
                    },
                ) {
                    Ok(_) => {}
                    Err(err) if is_fatal(&err) => return Err(err),
                    Err(_) => outcome.turns_failed += 1,
                }
            }
        }
    }

    if let Some(id) = &session_id {
        outcome.sessions_imported += imported_here;

        // The whole-file total, deduplicated by request and written as a
        // replace. After an I/O error this covers only the prefix that was
        // read, which is correct: the progress marker below is not advanced, so
        // the next pass recomputes the file from the top.
        let mut usage = TokenTotals::default();
        for request in usage_by_request.values() {
            usage.input_tokens = usage.input_tokens.saturating_add(request.input_tokens);
            usage.output_tokens = usage.output_tokens.saturating_add(request.output_tokens);
            usage.cache_creation_tokens =
                usage.cache_creation_tokens.saturating_add(request.cache_creation_tokens);
            usage.cache_read_tokens =
                usage.cache_read_tokens.saturating_add(request.cache_read_tokens);
        }
        if usage != TokenTotals::default() {
            store.replace_usage_totals(id, &usage)?;
        }
        // The model, when the Session did not already have one — `COALESCE` in
        // the upsert takes the new value and leaves an existing one alone.
        if let Some(model) = &model_seen {
            let mut capture = Capture::new(store, mode);
            capture.ensure_session(&session_key, None, Some(model.as_str()), None, None)?;
        }

        // Live capture stamped "now" at first sighting; the transcript knows
        // when the conversation really began. Without this, a year of imported
        // history all dates from the day the import ran.
        if let Some(earliest) = earliest {
            store.backdate_session(id, earliest)?;
        }
    }

    // Only after the content is durably written — and only when the file was
    // read to its end. After an I/O error the unread tail must stay unclaimed,
    // so the next pass resumes rather than skipping it; the per-line ids make
    // the re-read a no-op for everything already taken.
    if clean_read {
        store.set_import_progress(&key, size)?;
    }
    Ok(())
}

/// The usage one assistant line reports, with the request it belongs to.
struct UsageLine {
    key: String,
    totals: TokenTotals,
}

/// Read `message.usage` off an assistant line.
///
/// The transcript writes the same logical assistant message more than once — a
/// streaming record, then its rewrite — and every copy repeats the same usage
/// block. On a real transcript here, 18 usage lines collapsed to 8 requests:
/// summing lines instead of requests over-counts by 2.2x. `requestId` is the
/// key that collapses them, falling back to the message id and then the line's
/// own uuid so a line without one is at least counted once rather than merged
/// into a neighbour.
fn read_usage(value: &serde_json::Value) -> Option<UsageLine> {
    let message = value.get("message")?;
    let usage = message.get("usage")?;
    let key = value
        .get("requestId")
        .and_then(serde_json::Value::as_str)
        .or_else(|| message.get("id").and_then(serde_json::Value::as_str))
        .or_else(|| value.get("uuid").and_then(serde_json::Value::as_str))?
        .to_string();

    let field = |name: &str| usage.get(name).and_then(serde_json::Value::as_u64).unwrap_or(0);
    let totals = TokenTotals {
        input_tokens: field("input_tokens"),
        output_tokens: field("output_tokens"),
        cache_creation_tokens: field("cache_creation_input_tokens"),
        cache_read_tokens: field("cache_read_input_tokens"),
        ..Default::default()
    };
    // A usage block of all zeros carries no information and would otherwise
    // occupy a request slot, so an empty total stays empty.
    if totals == TokenTotals::default() {
        return None;
    }
    Some(UsageLine { key, totals })
}

/// One usable line of a transcript.
struct ImportedTurn {
    role: Role,
    mode: Mode,
    body: String,
    native_id: Option<String>,
    model: Option<String>,
    agent: Option<String>,
}

/// One `tool_use` block: the agent invoking a tool, with its own call id.
struct ToolUse {
    id: String,
    name: String,
    input: serde_json::Value,
}

/// One `tool_result` block: what came back, keyed to its `tool_use`.
struct ToolResult {
    tool_use_id: String,
    body: Option<String>,
    is_error: bool,
}

/// Pull a turn out of a transcript line, or `None` if it carries no content.
/// Is this parsed turn a harness envelope rather than conversation?
///
/// Command wrappers, local-command caveats and interruption markers arrive as
/// `user` lines but were never typed by a human. They are skipped entirely —
/// as messages and, by consequence, as title sources: a board full of Sessions
/// titled "<local-command-caveat>…" is the failure this exists to prevent.
fn is_envelope(turn: &ImportedTurn) -> bool {
    if turn.role != Role::User {
        return false;
    }
    let body = turn.body.trim_start();
    const ENVELOPE_PREFIXES: &[&str] = &[
        "Caveat: The messages below",
        "<local-command-caveat>",
        "<local-command-stdout>",
        "<command-name>",
        "<command-message>",
        "<bash-input>",
        "<bash-stdout>",
        "<bash-stderr>",
        "<system-reminder>",
        "<task-notification>",
        "[Request interrupted",
    ];
    ENVELOPE_PREFIXES.iter().any(|prefix| body.starts_with(prefix))
}

fn read_turn(value: &serde_json::Value) -> Option<ImportedTurn> {
    let kind = value.get("type").and_then(serde_json::Value::as_str)?;
    let role = match kind {
        "user" => Role::User,
        "assistant" => Role::Assistant,
        // `summary`, `system` and friends are envelope, not conversation.
        _ => return None,
    };

    let message = value.get("message")?;
    let body = content_text(message.get("content")?)?;
    if body.trim().is_empty() {
        return None;
    }

    Some(ImportedTurn {
        role,
        // Thinking blocks are recorded as their own mode so the sidebar's
        // Intermediate-steps count works on imported Sessions too.
        mode: if is_thinking(message.get("content")) {
            Mode::Thinking
        } else {
            Mode::Text
        },
        body,
        // The agent's own id for the line — what makes re-reading a grown file
        // idempotent rather than duplicating everything before the growth.
        native_id: value
            .get("uuid")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        model: message
            .get("model")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        agent: None,
    })
}

/// The `tool_use` blocks of an assistant line.
fn read_tool_uses(value: &serde_json::Value) -> Vec<ToolUse> {
    if value.get("type").and_then(serde_json::Value::as_str) != Some("assistant") {
        return Vec::new();
    }
    content_blocks(value)
        .iter()
        .filter_map(|block| {
            if block.get("type").and_then(serde_json::Value::as_str) != Some("tool_use") {
                return None;
            }
            Some(ToolUse {
                id: block.get("id").and_then(serde_json::Value::as_str)?.to_string(),
                name: block
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                input: block
                    .get("input")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({})),
            })
        })
        .collect()
}

/// The `tool_result` blocks of a user line — the transcript's record of what a
/// call returned, and whether it failed.
fn read_tool_results(value: &serde_json::Value) -> Vec<ToolResult> {
    if value.get("type").and_then(serde_json::Value::as_str) != Some("user") {
        return Vec::new();
    }
    content_blocks(value)
        .iter()
        .filter_map(|block| {
            if block.get("type").and_then(serde_json::Value::as_str) != Some("tool_result") {
                return None;
            }
            Some(ToolResult {
                tool_use_id: block
                    .get("tool_use_id")
                    .and_then(serde_json::Value::as_str)?
                    .to_string(),
                body: block.get("content").and_then(content_text),
                is_error: block
                    .get("is_error")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
            })
        })
        .collect()
}

/// A line's `message.content` as a slice of typed blocks, or empty.
fn content_blocks(value: &serde_json::Value) -> &[serde_json::Value] {
    value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(serde_json::Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

/// Flatten a transcript `content` field to text.
///
/// It is a bare string on older lines and an array of typed blocks on newer
/// ones; tool blocks are dropped here because tool calls are their own rows.
fn content_text(content: &serde_json::Value) -> Option<String> {
    match content {
        serde_json::Value::String(text) => Some(text.clone()),
        serde_json::Value::Array(blocks) => {
            let parts: Vec<String> = blocks
                .iter()
                .filter_map(|block| {
                    let kind = block.get("type").and_then(serde_json::Value::as_str)?;
                    match kind {
                        "text" => block
                            .get("text")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_string),
                        "thinking" => block
                            .get("thinking")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_string),
                        _ => None,
                    }
                })
                .collect();
            (!parts.is_empty()).then(|| parts.join("\n"))
        }
        _ => None,
    }
}

fn is_thinking(content: Option<&serde_json::Value>) -> bool {
    content
        .and_then(serde_json::Value::as_array)
        .map(|blocks| {
            blocks.iter().all(|block| {
                block.get("type").and_then(serde_json::Value::as_str) == Some("thinking")
            })
        })
        .unwrap_or(false)
}

/// The line's own clock, when it has one.
fn line_timestamp(value: &serde_json::Value) -> Option<DateTime<Utc>> {
    let raw = value.get("timestamp").and_then(serde_json::Value::as_str)?;
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

/// A stable stand-in for a missing `uuid`, so re-reading a grown file cannot
/// duplicate the lines already taken from it.
///
/// Keyed on the line's position *and* content: both are immutable for an
/// append-only transcript, and the content hash alone would wrongly merge two
/// legitimately identical lines.
fn synthetic_line_id(line_index: usize, line: &str) -> String {
    format!("line-{line_index}-{}", blobs::key_for(line.as_bytes()))
}

/// The agent's session id, which is the transcript's file stem.
fn session_id_of(path: &Path) -> Option<String> {
    path.file_stem().map(|s| s.to_string_lossy().to_string())
}

/// The first timestamp in a transcript, for the preview's date range.
fn first_timestamp(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    for line in BufReader::new(file).lines().take(50) {
        let line = line.ok()?;
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
            if let Some(ts) = value.get("timestamp").and_then(serde_json::Value::as_str) {
                return Some(ts.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bare_string_content_reads_as_text() {
        assert_eq!(
            content_text(&serde_json::json!("hello")).as_deref(),
            Some("hello")
        );
    }

    #[test]
    fn typed_blocks_are_flattened_and_tool_blocks_dropped() {
        let content = serde_json::json!([
            { "type": "text", "text": "first" },
            { "type": "tool_use", "name": "Bash" },
            { "type": "text", "text": "second" },
        ]);
        assert_eq!(content_text(&content).as_deref(), Some("first\nsecond"));
    }

    #[test]
    fn a_thinking_only_message_is_recognised_as_thinking() {
        let content = serde_json::json!([{ "type": "thinking", "thinking": "hmm" }]);
        assert!(is_thinking(Some(&content)));
        assert!(!is_thinking(Some(&serde_json::json!([{ "type": "text", "text": "hi" }]))));
    }

    #[test]
    fn a_tool_only_message_yields_no_turn_but_yields_its_tool_use() {
        let line = serde_json::json!({
            "type": "assistant",
            "message": { "content": [
                { "type": "tool_use", "id": "toolu_01", "name": "Bash",
                  "input": { "command": "cargo test" } },
            ] },
        });
        assert!(read_turn(&line).is_none());
        let uses = read_tool_uses(&line);
        assert_eq!(uses.len(), 1);
        assert_eq!(uses[0].id, "toolu_01");
        assert_eq!(uses[0].name, "Bash");
    }

    #[test]
    fn a_tool_result_block_reads_back_with_its_id_and_error_bit() {
        let line = serde_json::json!({
            "type": "user",
            "message": { "content": [
                { "type": "tool_result", "tool_use_id": "toolu_01",
                  "content": [{ "type": "text", "text": "error: it broke" }],
                  "is_error": true },
            ] },
        });
        assert!(read_turn(&line).is_none(), "a result is not a conversation turn");
        let results = read_tool_results(&line);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].tool_use_id, "toolu_01");
        assert_eq!(results[0].body.as_deref(), Some("error: it broke"));
        assert!(results[0].is_error);
    }

    #[test]
    fn envelope_lines_are_not_turns() {
        for kind in ["summary", "system", "file-history-snapshot"] {
            let line = serde_json::json!({ "type": kind, "message": { "content": "x" } });
            assert!(read_turn(&line).is_none(), "{kind} should not be a turn");
        }
    }

    #[test]
    fn the_session_id_is_the_file_stem() {
        assert_eq!(
            session_id_of(Path::new("/x/abc-123.jsonl")).as_deref(),
            Some("abc-123")
        );
    }

    #[test]
    fn a_transcript_timestamp_parses_to_utc() {
        let line = serde_json::json!({ "timestamp": "2026-07-01T10:00:00.000Z" });
        let parsed = line_timestamp(&line).expect("parses");
        assert_eq!(parsed.to_rfc3339(), "2026-07-01T10:00:00+00:00");
        assert!(line_timestamp(&serde_json::json!({})).is_none());
        assert!(line_timestamp(&serde_json::json!({ "timestamp": "not a date" })).is_none());
    }

    #[test]
    fn synthetic_line_ids_are_stable_and_position_scoped() {
        // Stability across re-reads is the dedupe key; position-scoping keeps
        // two identical lines distinct.
        assert_eq!(synthetic_line_id(3, "same"), synthetic_line_id(3, "same"));
        assert_ne!(synthetic_line_id(3, "same"), synthetic_line_id(4, "same"));
        assert_ne!(synthetic_line_id(3, "same"), synthetic_line_id(3, "different"));
    }

    #[test]
    fn only_store_level_failures_are_fatal_to_a_pass() {
        // The importer re-runs every thirty seconds forever: anything that is
        // one line's fault must be charged to that line, or the same corpus
        // re-aborts on every tick.
        assert!(is_fatal(&Error::AlreadyLocked));
        assert!(is_fatal(&Error::Storage("disk full".into())));
        assert!(is_fatal(&Error::SchemaTooNew { found: 9, supported: 1 }));
        assert!(!is_fatal(&Error::RedactionFailed("panicked".into())));
        assert!(!is_fatal(&Error::Blob("unwritable".into())));
    }
}
