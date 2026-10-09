//! The handoff note (M4): what one session leaves for whichever agent comes
//! next, built from what the session itself logged. No model, nothing
//! inferred. When the session recorder captured the session, the app adds
//! what it did ([`SessionFacts`]) at read time; this crate never reads the
//! recorder, and the facts are never stored here.

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::record::{EventKind, EventRow, RecordStore};

/// At most this many paths in a note.
pub const MAX_FILES: usize = 30;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffNote {
    pub session: String,
    pub agent: String,
    pub started_at: Option<i64>,
    pub ended_at: i64,
    /// The session's last plan, if it set one.
    pub plan: Option<String>,
    /// Plan items not done (`[pending]` / `[in_progress]` lines).
    pub open_items: Vec<String>,
    pub decisions: Vec<String>,
    pub failures: Vec<String>,
    pub facts: Vec<String>,
    pub architecture: Vec<String>,
    /// Paths the session changed, newest first, at most [`MAX_FILES`].
    pub files: Vec<String>,
    // From the recorded session, applied when the note is read
    // (`apply_facts`); absent from the JSON without capture.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub failed_tools: Vec<FailedTool>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub commits: Vec<CommitFact>,
    /// The session's last turn never finished.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub interrupted: bool,
    /// Turns the agent took back (a retry).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub rewound_turns: u32,
    /// The recorder flagged the session: it may have missed some of it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub incomplete: bool,
}

// Serde's `skip_serializing_if` passes a reference.
#[allow(clippy::trivially_copy_pass_by_ref)]
fn is_zero(n: &u32) -> bool {
    *n == 0
}

/// Tool calls that failed, folded by what was tried.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedTool {
    pub tool: String,
    /// The command, else the call's title: first line, short.
    pub detail: String,
    /// The result's first line, short. Never shown to a model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub count: u32,
}

/// A commit that carried the session's work.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFact {
    /// The first 12 hex.
    pub sha: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub orphaned: bool,
}

/// What the session recorder shows a session did. Plain data: the app reads
/// it from the recorder.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionFacts {
    pub title: Option<String>,
    pub branch: Option<String>,
    /// Newest first; a deletion as `path (deleted)`.
    pub files_written: Vec<String>,
    pub failed_tools: Vec<FailedTool>,
    pub commits: Vec<CommitFact>,
    pub interrupted: bool,
    pub rewound_turns: u32,
    pub incomplete: bool,
}

impl SessionFacts {
    /// Whether the session did anything worth handing off.
    pub fn is_empty(&self) -> bool {
        self.files_written.is_empty()
            && self.failed_tools.is_empty()
            && self.commits.is_empty()
            && !self.interrupted
    }

    /// The facts a model may see (the dream): no tool output.
    pub fn for_dream(mut self) -> Self {
        for f in &mut self.failed_tools {
            f.error = None;
        }
        self
    }
}

impl HandoffNote {
    /// Whether the session left anything for the next agent.
    pub fn is_empty(&self) -> bool {
        self.plan.is_none()
            && self.decisions.is_empty()
            && self.failures.is_empty()
            && self.facts.is_empty()
            && self.architecture.is_empty()
            && self.files.is_empty()
    }

    /// Fold the recorded session's facts into the note. The recorder's
    /// written paths lead `files` (completed writes only, shell writes
    /// included); paths only the memory events named follow.
    pub fn apply_facts(&mut self, facts: SessionFacts) {
        let mut files = facts.files_written;
        for f in std::mem::take(&mut self.files) {
            if !files
                .iter()
                .any(|w| w == &f || w.strip_suffix(" (deleted)") == Some(f.as_str()))
            {
                files.push(f);
            }
        }
        files.truncate(MAX_FILES);
        self.files = files;
        self.title = facts.title;
        self.branch = facts.branch;
        self.failed_tools = facts.failed_tools;
        self.commits = facts.commits;
        self.interrupted = facts.interrupted;
        self.rewound_turns = facts.rewound_turns;
        self.incomplete = facts.incomplete;
    }
}

/// The note `session` leaves, from the events it logged (not the entries:
/// an entry's session is its last writer). A merge logs nothing, so a
/// restatement of an older memory is not "left" by this session. The note
/// is stored as built; reading it back (`RecordStore::last_episode` and the
/// rest) drops each decision, failure, fact and architecture item that is
/// no longer an active entry.
pub fn build_handoff(
    store: &RecordStore,
    session: &str,
    agent: &str,
    ended_at: i64,
) -> Result<HandoffNote> {
    let events = store.events_of_session(session)?;
    let mut note = HandoffNote {
        session: session.into(),
        agent: agent.into(),
        ended_at,
        ..Default::default()
    };
    let text = |e: &EventRow, f: &str| {
        e.payload
            .get(f)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string()
    };
    for e in &events {
        match EventKind::parse(&e.kind) {
            EventKind::SessionStart => note.started_at = note.started_at.or(Some(e.ts)),
            EventKind::PlanSet => {
                let t = text(e, "text");
                if !t.is_empty() {
                    note.open_items = open_items(&t);
                    note.plan = Some(t);
                }
            }
            EventKind::Decision => push_unique(&mut note.decisions, text(e, "text")),
            EventKind::Failure => push_unique(&mut note.failures, text(e, "text")),
            EventKind::Fact => push_unique(&mut note.facts, text(e, "text")),
            EventKind::Architecture => push_unique(&mut note.architecture, text(e, "text")),
            EventKind::FileChanged => {
                let p = e
                    .payload
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&e.key)
                    .to_string();
                if !p.is_empty() {
                    note.files.retain(|f| *f != p);
                    note.files.insert(0, p);
                }
            }
            _ => {}
        }
    }
    // Only this scope's files: an agent here may also have edited another
    // checkout, `/tmp` or `~/.claude`.
    let dirs = store.scope_dirs();
    note.files.retain(|f| crate::record::path_in_dirs(f, &dirs));
    note.files.truncate(MAX_FILES);
    Ok(note)
}

/// Whether every item of `plan` is done: it has at least one
/// `[status] item` line and all of them are `completed` (or `done`,
/// `cancelled`, `skipped`, `superseded`). A finished plan is no longer the
/// active plan.
pub fn plan_is_finished(plan: &str) -> bool {
    let mut items = 0usize;
    for line in plan.lines() {
        let line = line.trim().trim_start_matches("- ");
        let Some((status, _)) = line.strip_prefix('[').and_then(|l| l.split_once(']')) else {
            continue;
        };
        items += 1;
        if !matches!(
            status.trim(),
            "completed" | "complete" | "done" | "cancelled" | "canceled" | "skipped" | "superseded"
        ) {
            return false;
        }
    }
    items > 0
}

/// The plan lines still to do: `[pending]` and `[in_progress]`.
fn open_items(plan: &str) -> Vec<String> {
    plan.lines()
        .filter_map(|l| {
            let l = l.trim().trim_start_matches("- ");
            let (status, rest) = l.strip_prefix('[')?.split_once("] ")?;
            matches!(status, "pending" | "in_progress").then(|| rest.trim().to_string())
        })
        .collect()
}

fn push_unique(list: &mut Vec<String>, item: String) {
    if !item.is_empty() && !list.contains(&item) {
        list.push(item);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record::{EventKind, NewEvent};

    #[test]
    fn the_handoff_note_lists_what_the_session_left() {
        let root = std::env::temp_dir().join(format!("atlas-handoff-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let store = crate::record::open_scope(&root).unwrap();
        let ev = |kind, key: &str, payload: serde_json::Value, session: &str, ts| {
            store
                .append_event(
                    NewEvent {
                        agent: "claude-code".into(),
                        session_id: session.into(),
                        kind,
                        key: key.into(),
                        payload,
                    },
                    ts,
                )
                .unwrap();
        };
        use crate::record::EventKind::*;
        ev(SessionStart, "", serde_json::json!({}), "s-a", 1);
        ev(
            PlanSet,
            "plan",
            serde_json::json!({"text": "- [completed] Read auth\n- [in_progress] Move to EdDSA\n- [pending] Rotate keys", "status": "active"}),
            "s-a",
            2,
        );
        ev(
            Decision,
            "auth.alg",
            serde_json::json!({"text": "Sign JWTs with EdDSA"}),
            "s-a",
            3,
        );
        ev(
            Failure,
            "",
            serde_json::json!({"text": "ring 0.16 can't parse PKCS#8 v2"}),
            "s-a",
            4,
        );
        ev(
            FileChanged,
            "src/auth.rs",
            serde_json::json!({"path": "src/auth.rs", "summary": "Edit"}),
            "s-a",
            5,
        );
        ev(
            Decision,
            "",
            serde_json::json!({"text": "Another session's decision"}),
            "s-b",
            6,
        );
        let note = build_handoff(&store, "s-a", "claude-code", 7).unwrap();
        assert_eq!(note.open_items, ["Move to EdDSA", "Rotate keys"]);
        assert_eq!(note.decisions, ["Sign JWTs with EdDSA"]);
        assert_eq!(note.failures, ["ring 0.16 can't parse PKCS#8 v2"]);
        assert_eq!(note.files, ["src/auth.rs"]);
        assert_eq!(note.started_at, Some(1));
        store.record_episode(&note).unwrap();
        assert_eq!(store.last_episode("s-b").unwrap(), Some(note.clone()));
        assert_ne!(
            store.last_episode("s-a").unwrap().map(|n| n.session),
            Some("s-a".to_string()),
            "a session is not handed its own note"
        );
        assert_eq!(store.episodes_since(0, 10).unwrap(), vec![note]);
        let _ = std::fs::remove_dir_all(&root);
    }

    fn scope(label: &str) -> (std::path::PathBuf, std::sync::Arc<RecordStore>) {
        let root =
            std::env::temp_dir().join(format!("atlas-handoff-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let store = crate::record::open_scope(&root).unwrap();
        (root, store)
    }

    fn log(
        store: &RecordStore,
        session: &str,
        kind: EventKind,
        key: &str,
        payload: serde_json::Value,
        ts: i64,
    ) {
        store
            .append_event(
                NewEvent {
                    agent: "claude-acp".into(),
                    session_id: session.into(),
                    kind,
                    key: key.into(),
                    payload,
                },
                ts,
            )
            .unwrap();
    }

    /// A session that edited another checkout, `/tmp` and `~/.claude` hands
    /// on only the files of this scope.
    #[test]
    fn the_note_lists_only_files_under_the_scope_root() {
        let (root, store) = scope("files");
        let root_canon = root.canonicalize().unwrap();
        let inside = root_canon.join("src/lib.rs").to_string_lossy().into_owned();
        for (i, path) in [
            inside.as_str(),
            "src/relative.rs",
            "/Users/someone/Developer/other-checkout/src/main.rs",
            "/tmp/homebrew-cask-pr/Casks/a/atlas-ai.rb",
            "~/.claude/plans/plan.md",
            "../escape.rs",
        ]
        .into_iter()
        .enumerate()
        {
            log(
                &store,
                "s-a",
                EventKind::FileChanged,
                path,
                serde_json::json!({"path": path, "summary": "Edit"}),
                i as i64 + 1,
            );
        }
        let note = build_handoff(&store, "s-a", "claude-acp", 10).unwrap();
        assert_eq!(note.files, ["src/relative.rs", inside.as_str()]);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Notes are stored only when a session's end is recorded. A session
    /// that never ended (still open, crashed, ran before notes existed) is
    /// still the previous session: its note is built from what it logged.
    #[test]
    fn a_session_that_never_ended_still_hands_off() {
        let (root, store) = scope("unended");
        log(
            &store,
            "s-old",
            EventKind::SessionStart,
            "",
            serde_json::json!({}),
            1,
        );
        store
            .remember(
                crate::record::NewEntry {
                    kind: crate::record::EntryKind::Decision,
                    key: String::new(),
                    content: "Keep SQLite in WAL mode".into(),
                    source: "claude-acp".into(),
                    agent: "claude-acp".into(),
                    session_id: "s-old".into(),
                    confidence: 1.0,
                    at: 2,
                },
                2,
            )
            .unwrap();
        log(
            &store,
            "s-old",
            EventKind::FileChanged,
            "src/db.rs",
            serde_json::json!({"path": "src/db.rs", "summary": "Edit"}),
            3,
        );
        // A session with only its start logged nothing worth handing on.
        log(
            &store,
            "s-idle",
            EventKind::SessionStart,
            "",
            serde_json::json!({}),
            4,
        );

        let note = store.last_episode("s-new").unwrap().expect("a handoff");
        assert_eq!(note.session, "s-old");
        assert_eq!(note.decisions, ["Keep SQLite in WAL mode"]);
        assert_eq!(note.files, ["src/db.rs"]);
        assert_eq!(note.ended_at, 3, "its last event");

        // A stored note that ended later wins over an older unended session.
        let stored = HandoffNote {
            session: "s-ended".into(),
            agent: "codex-acp".into(),
            ended_at: 50,
            files: vec!["src/later.rs".into(), "/tmp/elsewhere.rs".into()],
            ..Default::default()
        };
        store.record_episode(&stored).unwrap();
        let handed = store.last_episode("s-new").unwrap().unwrap();
        assert_eq!(handed.session, "s-ended");
        assert_eq!(
            handed.files,
            ["src/later.rs"],
            "stored notes are filtered on read"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_plan_is_finished_when_every_item_is_done() {
        assert!(plan_is_finished(
            "- [completed] Create branch\n- [completed] Commit, push, open PR"
        ));
        assert!(plan_is_finished("- [completed] A\n- [cancelled] B"));
        assert!(plan_is_finished("- [completed] A\n- [superseded] B"));
        assert!(!plan_is_finished("- [completed] A\n- [in_progress] B"));
        assert!(!plan_is_finished("- [pending] A"));
        assert!(!plan_is_finished("free text with no items"));
        assert!(!plan_is_finished(""));
    }

    #[test]
    fn facts_lead_the_files_and_fill_the_recorded_fields() {
        let mut note = HandoffNote {
            files: vec!["src/auth.rs".into(), "README.md".into()],
            ..Default::default()
        };
        note.apply_facts(SessionFacts {
            title: Some("Move auth to EdDSA".into()),
            files_written: vec!["src/keys.rs".into(), "src/auth.rs".into()],
            failed_tools: vec![FailedTool {
                tool: "bash".into(),
                detail: "cargo test -p auth".into(),
                error: Some("error: test failed".into()),
                count: 3,
            }],
            interrupted: true,
            ..Default::default()
        });
        assert_eq!(
            note.files,
            ["src/keys.rs", "src/auth.rs", "README.md"],
            "capture first, then memory-only paths"
        );
        assert_eq!(note.failed_tools[0].count, 3);
        assert!(note.interrupted);
        let json = serde_json::to_value(&note).unwrap();
        assert!(
            json.get("commits").is_none(),
            "empty facts stay out of the JSON"
        );
        assert!(
            SessionFacts {
                failed_tools: note.failed_tools.clone(),
                ..Default::default()
            }
            .for_dream()
            .failed_tools[0]
                .error
                .is_none(),
            "the dream never sees tool output"
        );
    }
}
