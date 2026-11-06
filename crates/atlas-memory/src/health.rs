//! The reconciler's checks and repairs (M2). Every invariant compares a
//! derived thing with the canonical thing it comes from; every repair
//! rebuilds the derived side. No model is asked, and no memory's content,
//! kind, key or confidence is ever changed here.
//!
//! - **The view** (`entries`) against its latest revisions.
//! - **The word index** (`entries_fts`) against the live entries.
//! - **The vector cache** against the live entries' texts: missing vectors
//!   are embedded (when a model is loaded), vectors no live text keys are
//!   dropped.
//! - **The hash chain** over the revisions: a break is reported and never
//!   repaired here (re-sealing would bless an outside edit), and while it is
//!   broken the view is not rebuilt from the edited history.
//! - **SQLite's own consistency check**: a damaged file is left for the next
//!   open, which quarantines it and restores the daily snapshot.

use std::collections::HashSet;

use anyhow::Result;
use serde::Serialize;

use crate::record::{memory_dir, RecordStore};

/// The daily snapshot of a scope's record, beside `memory.sqlite`.
pub const SNAPSHOT_FILE: &str = "memory.snapshot.sqlite";
/// A snapshot is refreshed at most this often.
pub const SNAPSHOT_EVERY_MS: i64 = 24 * 3600 * 1000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Issue {
    /// Live rows that disagree with their latest revision, plus entries whose
    /// latest revision is live but who have no row.
    EntriesDrift { count: usize },
    /// FTS rows missing for live entries / present for no entry.
    FtsDrift { missing: usize, extra: usize },
    /// Live entries with no cached vector for the installed model.
    VectorsMissing { count: usize },
    /// Cached vectors that no live entry's current text keys.
    CacheGarbage { count: usize },
    /// A revision no longer matches the hash chain: history was edited
    /// outside the store. Never repaired here: re-sealing would bless the
    /// edit, and nothing canonical says what the text was.
    ChainBroken { first_bad_rev: i64 },
    /// SQLite's own consistency check failed.
    Corrupt { detail: String },
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub checked_at: i64,
    pub found: Vec<Issue>,
    pub repaired: Vec<Issue>,
    pub deferred: Vec<Issue>,
}

fn count(conn: &rusqlite::Connection, sql: &str) -> Result<usize> {
    Ok(conn.query_row(sql, [], |r| r.get::<_, i64>(0))? as usize)
}

/// The cache keys every live entry's current text has under every model the
/// cache holds vectors for.
fn live_keys(conn: &rusqlite::Connection) -> Result<HashSet<[u8; 32]>> {
    let models: Vec<String> = conn
        .prepare("SELECT DISTINCT model FROM embed_cache")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let texts: Vec<String> = conn
        .prepare("SELECT content FROM entries")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(models
        .iter()
        .flat_map(|m| {
            texts
                .iter()
                .map(move |t| atlas_retrieval::codec::cache_key(m, t))
        })
        .collect())
}

/// Every cached vector's key that no live text keys.
fn garbage_keys(conn: &rusqlite::Connection) -> Result<Vec<Vec<u8>>> {
    let live = live_keys(conn)?;
    let all: Vec<Vec<u8>> = conn
        .prepare("SELECT key FROM embed_cache")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(all
        .into_iter()
        .filter(|k| match <[u8; 32]>::try_from(k.as_slice()) {
            Ok(key) => !live.contains(&key),
            Err(_) => true,
        })
        .collect())
}

impl RecordStore {
    /// Every invariant, checked against canonical state. Cheap: a handful
    /// of SQL counts plus one pass over the live texts.
    pub fn check(&self) -> Result<Vec<Issue>> {
        let mut issues = Vec::new();
        {
            let conn = self.conn();
            let quick: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
            if quick != "ok" {
                return Ok(vec![Issue::Corrupt { detail: quick }]);
            }
            let drift = count(
                &conn,
                "SELECT COUNT(*) FROM entries e LEFT JOIN revisions r ON r.rev = e.rev \
                 WHERE r.rev IS NULL OR r.entry_id <> e.id OR r.content <> e.content \
                    OR r.kind <> e.kind OR r.key <> e.key OR r.state = 'tombstoned'",
            )? + count(
                &conn,
                "SELECT COUNT(*) FROM revisions r \
                 WHERE r.rev = (SELECT MAX(m.rev) FROM revisions m WHERE m.entry_id = r.entry_id) \
                   AND r.state <> 'tombstoned' \
                   AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.id = r.entry_id)",
            )?;
            if drift > 0 {
                issues.push(Issue::EntriesDrift { count: drift });
            }
        }
        if let Some(first_bad_rev) = self.verify_chain()? {
            issues.push(Issue::ChainBroken { first_bad_rev });
        }
        let texts: Vec<String> = {
            let conn = self.conn();
            let missing = count(
                &conn,
                "SELECT COUNT(*) FROM entries WHERE id NOT IN (SELECT rowid FROM entries_fts)",
            )?;
            let extra = count(
                &conn,
                "SELECT COUNT(*) FROM entries_fts WHERE rowid NOT IN (SELECT id FROM entries)",
            )?;
            if missing + extra > 0 {
                issues.push(Issue::FtsDrift { missing, extra });
            }
            let garbage = garbage_keys(&conn)?.len();
            if garbage > 0 {
                issues.push(Issue::CacheGarbage { count: garbage });
            }
            let texts: Vec<String> = conn
                .prepare("SELECT content FROM entries")?
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            texts
        };
        if let Some(model) = self.embedder().and_then(|e| e.model_id()) {
            let conn = self.conn();
            let mut get = conn.prepare_cached("SELECT 1 FROM embed_cache WHERE key = ?1")?;
            let mut missing = 0;
            for t in &texts {
                if !get.exists([&atlas_retrieval::codec::cache_key(&model, t)[..]])? {
                    missing += 1;
                }
            }
            if missing > 0 {
                issues.push(Issue::VectorsMissing { count: missing });
            }
        }
        Ok(issues)
    }

    /// Repair what `check` found, in dependency order (the view before FTS,
    /// both before vectors). Returns `(repaired, deferred)`: corruption is
    /// deferred to the next open (which restores a snapshot), a broken chain
    /// to the user, and missing vectors while no model can embed them.
    pub fn repair(&self, issues: &[Issue]) -> Result<(Vec<Issue>, Vec<Issue>)> {
        let mut repaired = Vec::new();
        let mut deferred = Vec::new();
        if let Some(c) = issues.iter().find(|i| matches!(i, Issue::Corrupt { .. })) {
            return Ok((repaired, vec![c.clone()]));
        }
        // With a broken chain, history is not trusted, so the view is not
        // rebuilt from it.
        let chain_broken = issues
            .iter()
            .any(|i| matches!(i, Issue::ChainBroken { .. }));
        let mut ordered: Vec<&Issue> = issues.iter().collect();
        ordered.sort_by_key(|i| match i {
            Issue::EntriesDrift { .. } => 0,
            Issue::FtsDrift { .. } => 1,
            Issue::CacheGarbage { .. } => 2,
            Issue::VectorsMissing { .. } => 3,
            Issue::ChainBroken { .. } | Issue::Corrupt { .. } => 4,
        });
        let mut view_rebuilt = false;
        for issue in ordered {
            match issue {
                Issue::EntriesDrift { .. } if chain_broken => deferred.push(issue.clone()),
                Issue::EntriesDrift { .. } => {
                    // Rebuilding the view rebuilds its FTS rows too.
                    self.rebuild_entries_from_revisions()?;
                    view_rebuilt = true;
                    repaired.push(issue.clone());
                }
                Issue::FtsDrift { .. } => {
                    if !view_rebuilt {
                        let conn = self.conn();
                        conn.execute_batch(
                            "INSERT INTO entries_fts(entries_fts) VALUES('delete-all');
                             INSERT INTO entries_fts (rowid, key, content) \
                             SELECT id, key, content FROM entries;",
                        )?;
                    }
                    repaired.push(issue.clone());
                }
                Issue::CacheGarbage { .. } => {
                    self.collect_cache_garbage()?;
                    repaired.push(issue.clone());
                }
                Issue::VectorsMissing { count } => {
                    let added = self.sync_vectors()?;
                    if added >= *count {
                        repaired.push(issue.clone());
                    } else {
                        deferred.push(issue.clone());
                    }
                }
                Issue::ChainBroken { .. } | Issue::Corrupt { .. } => deferred.push(issue.clone()),
            }
        }
        Ok((repaired, deferred))
    }

    /// Check, repair, and say what happened.
    pub fn heal(&self, now: i64) -> Result<Report> {
        let found = self.check()?;
        let (repaired, deferred) = self.repair(&found)?;
        Ok(Report {
            checked_at: now,
            found,
            repaired,
            deferred,
        })
    }

    /// The user confirmed an outside edit of the history was theirs: re-seal
    /// the chain from the first bad revision, so the next heal rebuilds the
    /// view from it. Only from a confirmed UI action, never from the health
    /// pass. Returns whether there was anything to accept.
    pub fn accept_history(&self) -> Result<bool> {
        let Some(first) = self.verify_chain()? else {
            return Ok(false);
        };
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        crate::record::reseal_from(&tx, first)?;
        tx.commit()?;
        Ok(true)
    }

    /// Delete every cached vector no live entry's current text keys.
    fn collect_cache_garbage(&self) -> Result<usize> {
        let conn = self.conn();
        let mut n = 0;
        for k in garbage_keys(&conn)? {
            n += conn.execute("DELETE FROM embed_cache WHERE key = ?1", [&k[..]])?;
        }
        Ok(n)
    }

    /// Refresh `memory.snapshot.sqlite` when the last one is older than a
    /// day (or missing): `VACUUM INTO` a temp file, then rename. Returns
    /// whether it wrote one. `now` is in ms; the snapshot's age is read from
    /// a `snapshot_meta` row inside the snapshot itself, not its mtime.
    pub fn snapshot_if_due(&self, now: i64) -> Result<bool> {
        let dir = memory_dir(self.root());
        let path = dir.join(SNAPSHOT_FILE);
        let last: Option<i64> = rusqlite::Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .ok()
        .and_then(|c| {
            c.query_row("SELECT v FROM snapshot_meta WHERE k = 'at'", [], |r| {
                r.get::<_, String>(0)
            })
            .ok()
        })
        .and_then(|v| v.parse().ok());
        if last.is_some_and(|at| now - at < SNAPSHOT_EVERY_MS) {
            return Ok(false);
        }
        let tmp = dir.join(format!("{SNAPSHOT_FILE}.tmp"));
        let _ = std::fs::remove_file(&tmp);
        {
            let conn = self.conn();
            conn.execute("VACUUM INTO ?1", [tmp.to_string_lossy().as_ref()])?;
        }
        {
            let snap = rusqlite::Connection::open(&tmp)?;
            snap.execute_batch(
                "CREATE TABLE IF NOT EXISTS snapshot_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);",
            )?;
            snap.execute(
                "INSERT OR REPLACE INTO snapshot_meta (k, v) VALUES ('at', ?1)",
                [now.to_string()],
            )?;
        }
        std::fs::rename(&tmp, &path)?;
        Ok(true)
    }

    /// Archive what nobody wrote or used within
    /// [`EXPIRE_AFTER_MS`](crate::record::EXPIRE_AFTER_MS) (M3, ADR-0018):
    /// every such candidate, and an active memory only when `resolver` finds
    /// its citations stale. An active memory without citations never expires
    /// on time alone: it is the long-term memory. Returns how many archived.
    pub fn expire(&self, now: i64, resolver: &dyn crate::citation::Resolver) -> Result<usize> {
        use crate::citation::{overall, validate, Validity};
        use crate::record::State;
        let mut ids = Vec::new();
        for e in self.expiry_candidates(now)? {
            if e.state == State::Candidate {
                ids.push(e.id);
                continue;
            }
            let each: Vec<Validity> = e
                .citations()
                .iter()
                .map(|c| validate(c, resolver).0)
                .collect();
            if overall(&each) == Some(Validity::Stale) {
                ids.push(e.id);
            }
        }
        self.archive(&ids, now)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record::{open_scope, EntryKind, NewEntry, Origin, DB_FILE};

    fn root(label: &str) -> std::path::PathBuf {
        let r = std::env::temp_dir().join(format!("atlas-health-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&r);
        std::fs::create_dir_all(&r).unwrap();
        r
    }

    fn write(store: &RecordStore, content: &str, at: i64) -> i64 {
        store
            .remember(
                NewEntry {
                    kind: EntryKind::Fact,
                    key: String::new(),
                    content: content.into(),
                    source: "claude".into(),
                    agent: "claude".into(),
                    session_id: "s".into(),
                    confidence: 1.0,
                    at,
                },
                at,
            )
            .unwrap()
            .entry
            .id
    }

    #[test]
    fn every_invariant_violation_is_repaired_without_a_human() {
        let r = root("repair");
        let store = open_scope(&r).unwrap();
        let a = write(&store, "Deploys go through Fly", 1);
        let b = write(&store, "The API speaks JSON", 2);
        assert!(
            store.check().unwrap().is_empty(),
            "a fresh store is healthy"
        );

        {
            let conn = store.conn();
            // The view drifts from history; FTS loses a row and gains a stray one.
            conn.execute("UPDATE entries SET content = 'tampered' WHERE id = ?1", [a])
                .unwrap();
            conn.execute("DELETE FROM entries_fts WHERE rowid = ?1", [b])
                .unwrap();
            conn.execute(
                "INSERT INTO entries_fts (rowid, key, content) VALUES (999, '', 'ghost')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO embed_cache (key, model, dims, vec) VALUES (x'00', 'm', 1, x'0000')",
                [],
            )
            .unwrap();
        }
        let found = store.check().unwrap();
        assert!(
            found.contains(&Issue::EntriesDrift { count: 1 }),
            "{found:?}"
        );
        assert!(
            found.contains(&Issue::FtsDrift {
                missing: 1,
                extra: 1
            }),
            "{found:?}"
        );
        assert!(
            found.contains(&Issue::CacheGarbage { count: 1 }),
            "{found:?}"
        );

        let report = store.heal(10).unwrap();
        assert_eq!(report.deferred, vec![], "{report:?}");
        assert!(store.check().unwrap().is_empty(), "healthy after one pass");
        assert_eq!(
            store.get(a, 11).unwrap().unwrap().content,
            "Deploys go through Fly",
            "rebuilt from its revision"
        );
        assert_eq!(
            store.search("JSON", &[], 5, 12).unwrap().len(),
            1,
            "FTS row restored"
        );

        // An edit to history itself is reported and left for the user.
        store
            .conn()
            .execute(
                "UPDATE revisions SET content = 'Deploys go by hand' WHERE entry_id = ?1",
                [a],
            )
            .unwrap();
        let report = store.heal(13).unwrap();
        assert!(
            report
                .deferred
                .iter()
                .any(|i| matches!(i, Issue::ChainBroken { .. })),
            "{report:?}"
        );
        assert_eq!(
            store.get(a, 14).unwrap().unwrap().content,
            "Deploys go through Fly",
            "the view is not rebuilt from tampered history"
        );

        // The user says the edit was theirs: the chain is re-sealed and the
        // view follows the accepted history.
        assert!(store.accept_history().unwrap());
        let report = store.heal(15).unwrap();
        assert_eq!(report.deferred, vec![], "{report:?}");
        assert_eq!(
            store.get(a, 16).unwrap().unwrap().content,
            "Deploys go by hand"
        );
        let _ = std::fs::remove_dir_all(&r);
    }

    #[test]
    fn a_damaged_database_is_quarantined_and_restored_from_the_snapshot() {
        let r = root("restore");
        {
            let store = RecordStore::open(&r).unwrap();
            write(&store, "Kept by the snapshot", 1);
            assert!(store.snapshot_if_due(1).unwrap());
            assert!(!store.snapshot_if_due(2).unwrap(), "at most once a day");
            write(&store, "Written after the snapshot", 3);
        }
        let db = memory_dir(&r).join(DB_FILE);
        let _ = std::fs::remove_file(memory_dir(&r).join(format!("{DB_FILE}-wal")));
        std::fs::write(&db, b"SQLite format 3\0 but then garbage everywhere").unwrap();

        let store = RecordStore::open(&r).unwrap();
        let facts: Vec<String> = store
            .list(EntryKind::Fact, 10, Origin::Any)
            .unwrap()
            .into_iter()
            .map(|e| e.content)
            .collect();
        assert_eq!(facts, ["Kept by the snapshot"]);
        let quarantined = std::fs::read_dir(memory_dir(&r))
            .unwrap()
            .filter_map(Result::ok)
            .any(|e| e.file_name().to_string_lossy().contains(".corrupt-"));
        assert!(quarantined, "the damaged file is kept");
        assert_eq!(RecordStore::restored_marker(&r).map(|(_, s)| s), Some(true));
        assert_eq!(RecordStore::restored_marker(&r), None, "reported once");
        let _ = std::fs::remove_dir_all(&r);
    }

    #[test]
    fn expiry_archives_old_candidates_and_old_stale_citations_only() {
        use crate::citation::{cite, FileResolver};
        use crate::record::{State, CANDIDATE_CONFIDENCE, EXPIRE_AFTER_MS};
        let r = root("expire");
        let store = open_scope(&r).unwrap();
        std::fs::write(r.join("ttl.rs"), "const TTL: u32 = 15;\n").unwrap();
        let files = FileResolver::new(&r);
        let entry = |content: &str, confidence: f64| NewEntry {
            kind: EntryKind::Fact,
            key: String::new(),
            content: content.into(),
            source: "claude".into(),
            agent: "claude".into(),
            session_id: "s".into(),
            confidence,
            at: 1,
        };
        let candidate = store
            .upsert(entry("always force-push", CANDIDATE_CONFIDENCE))
            .unwrap()
            .id;
        let cited = store
            .remember_guarded(
                entry("Tokens live 15 minutes", 1.0),
                1,
                None,
                &[cite(&files, "ttl.rs", 1, 1, None).unwrap()],
            )
            .unwrap()
            .entry
            .id;
        let uncited = write(&store, "Deploys go through Fly", 1);
        let now = 2 + EXPIRE_AFTER_MS;
        // The cited lines still hold: only the candidate expires.
        assert_eq!(store.expire(now, &files).unwrap(), 1);
        std::fs::write(r.join("ttl.rs"), "const TTL: u32 = 30;\n").unwrap();
        assert_eq!(store.expire(now, &files).unwrap(), 1);
        let state = |id| store.get(id, now).unwrap().unwrap().state;
        assert_eq!(state(candidate), State::Archived);
        assert_eq!(state(cited), State::Archived);
        assert_eq!(state(uncited), State::Active, "never on time alone");
    }
}
