//! One-time migration of a directory's legacy shared memory into the record
//! store.
//!
//! Before the record store, shared memory lived per launch directory in two
//! places: the JSONL event log (`<dir>/.atlas/shared-memory/events.jsonl`, with
//! its folded `state.json`) and the extracted-memory markdown written by the
//! session extractor (`<dir>/.atlas/memory/extracted/*.md`). A scope (a
//! repository) may have several such directories — one per worktree — and all
//! of them migrate into the one store at the scope root.
//!
//! - The event log is imported line by line into `events` and folded into
//!   `entries` exactly as if each line had just been appended. Sequence numbers
//!   are kept when they still ascend, so a single migrated log answers the
//!   Shared-tab commands exactly as the JSONL store did.
//! - Each memdir bullet (`- **[category]** text *(confidence: NN%)*`) becomes a
//!   direct entry: `decision`, `failure` and `architecture` map to their kind,
//!   every other category to Fact; the confidence is kept; the source is
//!   `import:memdir`.
//!
//! A marker file (`<dir>/.atlas/memory/.record-store-migrated`) gates re-runs,
//! backed by a `legacy_imports` row written in the import's own transaction. The old files are left in place
//! for one release; readers that still use them keep working.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::Deserialize;

use super::{
    fold, insert_event, last_seq_tx, redact_text, redact_value, upsert_tx, EntryKind, EventRow,
    NewEntry, RecordStore,
};

/// Marker (under `<dir>/.atlas/memory/`) recording that `<dir>`'s legacy shared
/// memory has been folded into a record store.
pub const MARKER: &str = ".record-store-migrated";

/// Confidence given to a memdir bullet that carries none.
const DEFAULT_IMPORT_CONFIDENCE: f64 = 0.7;

/// What [`RecordStore::migrate_legacy`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MigrationOutcome {
    /// No legacy event log or memdir in that directory.
    NothingToDo,
    /// The marker is present: an earlier open already migrated it.
    AlreadyDone,
    /// Imported `events` log lines and `memories` memdir bullets.
    Migrated { events: usize, memories: usize },
}

/// One JSONL line, as the JSONL store read it: the same required fields, so a
/// line that store skipped is skipped here too.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyEvent {
    seq: u64,
    ts: i64,
    agent: String,
    session_id: String,
    kind: String,
    #[serde(default)]
    key: String,
    payload: serde_json::Value,
}

// Through the profile like the record itself: a dev build migrating the
// released app's legacy files would fold them into its own record, and the
// legacy log is the released app's to retire.
fn events_path(dir: &Path) -> PathBuf {
    atlas_profile::dir_in(dir)
        .join("shared-memory")
        .join("events.jsonl")
}

fn memdir_path(dir: &Path) -> PathBuf {
    atlas_profile::dir_in(dir).join("memory").join("extracted")
}

fn marker_path(dir: &Path) -> PathBuf {
    super::memory_dir(dir).join(MARKER)
}

impl RecordStore {
    /// Fold `dir`'s legacy event log and memdir into this store, once. `dir`
    /// is the scope root or another worktree / launch directory of the same
    /// scope. Idempotent across opens and processes via the marker file.
    pub fn migrate_legacy(&self, dir: &Path) -> Result<MigrationOutcome> {
        // Held across the marker check, the import and the marker write, so
        // two threads opening the same scope cannot both import.
        let mut conn = self.conn();
        let source = dir
            .canonicalize()
            .unwrap_or_else(|_| dir.to_path_buf())
            .to_string_lossy()
            .to_string();
        let recorded: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM legacy_imports WHERE source = ?1)",
            [&source],
            |r| r.get(0),
        )?;
        if recorded || marker_path(dir).exists() {
            return Ok(MigrationOutcome::AlreadyDone);
        }
        let log = std::fs::read_to_string(events_path(dir)).ok();
        let memdir = read_memdir(&memdir_path(dir));
        if log.is_none() && memdir.is_empty() {
            return Ok(MigrationOutcome::NothingToDo);
        }

        let tx = conn.transaction()?;
        let mut events = 0;
        for line in log.as_deref().unwrap_or("").lines() {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(old) = serde_json::from_str::<LegacyEvent>(line) else {
                continue;
            };
            let seq = old.seq.max(last_seq_tx(&tx)? + 1);
            let row = EventRow {
                seq,
                ts: old.ts,
                agent: old.agent,
                session_id: old.session_id,
                kind: old.kind,
                key: redact_text(&old.key),
                payload: redact_value(old.payload),
            };
            insert_event(&tx, &row)?;
            fold(&tx, &row)?;
            events += 1;
        }
        let memories = memdir.len();
        for m in memdir {
            upsert_tx(&tx, m)?;
        }
        // Recorded in the same transaction as the import, so a failed marker
        // write below can never lead to a second import.
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as i64);
        tx.execute(
            "INSERT INTO legacy_imports (source, at) VALUES (?1, ?2)",
            rusqlite::params![source, now],
        )?;
        tx.commit()?;

        let marker = marker_path(dir);
        if let Some(parent) = marker.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }
        std::fs::write(
            &marker,
            format!("migrated into {}\n", self.root().display()),
        )
        .with_context(|| format!("write {}", marker.display()))?;
        drop(conn);
        Ok(MigrationOutcome::Migrated { events, memories })
    }
}

/// Every bullet of every `*.md` in the memdir, in file-name order.
fn read_memdir(dir: &Path) -> Vec<NewEntry> {
    let Ok(read) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = read
        .filter_map(std::result::Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "md"))
        .collect();
    files.sort();
    let mut out = Vec::new();
    for file in files {
        let Ok(body) = std::fs::read_to_string(&file) else {
            continue;
        };
        let session = file
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let mut at = 0_i64;
        for line in body.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("### Session memories") {
                at = rest
                    .rsplit_once(char::is_whitespace)
                    .and_then(|(_, d)| chrono::NaiveDate::parse_from_str(d.trim(), "%Y-%m-%d").ok())
                    .and_then(|d| d.and_hms_opt(0, 0, 0))
                    .map(|d| d.and_utc().timestamp_millis())
                    .unwrap_or(at);
                continue;
            }
            if let Some((category, content, confidence)) = parse_bullet(line) {
                out.push(NewEntry {
                    kind: match category.as_str() {
                        "decision" => EntryKind::Decision,
                        "failure" => EntryKind::Failure,
                        "architecture" => EntryKind::Architecture,
                        _ => EntryKind::Fact,
                    },
                    key: String::new(),
                    content,
                    source: "import:memdir".into(),
                    agent: String::new(),
                    session_id: session.clone(),
                    confidence,
                    at,
                });
            }
        }
    }
    out
}

/// `- **[category]** content *(confidence: NN%)*` → (category, content, 0–1).
fn parse_bullet(line: &str) -> Option<(String, String, f64)> {
    let rest = line.strip_prefix("- **[")?;
    let (category, rest) = rest.split_once("]**")?;
    let (content, confidence) = match rest.rsplit_once("*(confidence:") {
        Some((content, conf)) => {
            let pct = conf
                .trim()
                .trim_end_matches(")*")
                .trim()
                .trim_end_matches('%')
                .trim();
            let confidence = pct.parse::<f64>().map(|p| (p / 100.0).clamp(0.0, 1.0));
            (content, confidence.unwrap_or(DEFAULT_IMPORT_CONFIDENCE))
        }
        None => (rest, DEFAULT_IMPORT_CONFIDENCE),
    };
    let content = content.trim();
    if content.is_empty() {
        return None;
    }
    Some((
        category.trim().to_lowercase(),
        content.to_string(),
        confidence,
    ))
}

#[cfg(test)]
mod tests {
    use super::super::tests::temp_root;
    use super::super::{open_scope, EntryKind, Origin};
    use super::*;

    fn seed(dir: &Path) {
        std::fs::create_dir_all(dir.join(".atlas/shared-memory")).unwrap();
        std::fs::create_dir_all(dir.join(".atlas/memory/extracted")).unwrap();
        std::fs::write(
            events_path(dir),
            concat!(
                r#"{"seq":1,"ts":10,"agent":"codex","sessionId":"s1","kind":"decision","key":"db","payload":{"text":"Postgres"}}"#, "\n",
                r#"{"seq":2,"ts":20,"agent":"codex","sessionId":"s1","kind":"skill_used","key":"","payload":{}}"#, "\n",
                "not json\n",
                r#"{"seq":3,"ts":30,"agent":"claude-code","sessionId":"s2","kind":"fact","key":"","payload":{"text":"Port 4747"}}"#, "\n",
            ),
        )
        .unwrap();
        std::fs::write(
            dir.join(".atlas/memory/extracted/s9.md"),
            "## Auto-extracted memories\n\n### Session memories — 2026-08-30\n\
             - **[decision]** Use WAL *(confidence: 90%)*\n\
             - **[preference]** Minimal tooling *(confidence: 80%)*\n\
             - **[decision]** use   WAL *(confidence: 60%)*\n",
        )
        .unwrap();
    }

    #[test]
    fn a_legacy_log_and_memdir_migrate_once() {
        let root = temp_root("migrate");
        seed(&root);
        let store = open_scope(&root).unwrap();

        assert_eq!(
            store.migrate_legacy(&root).unwrap(),
            MigrationOutcome::Migrated {
                events: 3,
                memories: 3
            }
        );
        let seqs: Vec<u64> = store
            .events_newest(10)
            .unwrap()
            .iter()
            .map(|e| e.seq)
            .collect();
        assert_eq!(seqs, vec![3, 2, 1]);
        let decisions = store.list(EntryKind::Decision, 10, Origin::Any).unwrap();
        let texts: Vec<&str> = decisions.iter().map(|e| e.content.as_str()).collect();
        assert_eq!(texts.len(), 2, "{texts:?}");
        assert!(texts.contains(&"Postgres") && texts.contains(&"Use WAL"));
        let wal = decisions.iter().find(|e| e.content == "Use WAL").unwrap();
        assert_eq!(wal.source, "import:memdir");
        assert!((wal.confidence - 0.9).abs() < 1e-6);
        assert_eq!(wal.seq, None);
        let facts = store.list(EntryKind::Fact, 10, Origin::Any).unwrap();
        assert_eq!(facts.len(), 2);
        // Memdir imports are in the record but not in the event-log view.
        assert_eq!(
            store
                .list(EntryKind::Decision, 10, Origin::EventLog)
                .unwrap()
                .len(),
            1
        );

        // Reopening (the marker) does not duplicate anything, even when the
        // old log is still there and has grown.
        assert_eq!(
            store.migrate_legacy(&root).unwrap(),
            MigrationOutcome::AlreadyDone
        );
        let fresh = RecordStore::open(&root).unwrap();
        assert_eq!(
            fresh.migrate_legacy(&root).unwrap(),
            MigrationOutcome::AlreadyDone
        );
        assert_eq!(fresh.events_newest(10).unwrap().len(), 3);
        assert_eq!(fresh.count(EntryKind::Decision).unwrap(), 2);
        assert_eq!(fresh.count(EntryKind::Fact).unwrap(), 2);
        // The old files are kept for one release.
        assert!(events_path(&root).exists());
        assert!(root.join(".atlas/memory/extracted/s9.md").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_second_worktree_log_continues_the_sequence() {
        let root = temp_root("wt-main");
        let other = temp_root("wt-other");
        seed(&root);
        seed(&other);
        let store = open_scope(&root).unwrap();
        store.migrate_legacy(&root).unwrap();
        store.migrate_legacy(&other).unwrap();
        let seqs: Vec<u64> = store
            .events_newest(10)
            .unwrap()
            .iter()
            .map(|e| e.seq)
            .collect();
        assert_eq!(seqs, vec![6, 5, 4, 3, 2, 1]);
        // Same decision key from both worktrees: one entry.
        assert_eq!(store.count(EntryKind::Decision).unwrap(), 2);
        assert!(marker_path(&other).exists());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[test]
    fn nothing_to_migrate_writes_no_marker() {
        let root = temp_root("empty");
        let store = open_scope(&root).unwrap();
        assert_eq!(
            store.migrate_legacy(&root).unwrap(),
            MigrationOutcome::NothingToDo
        );
        assert!(!marker_path(&root).exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
