//! Kilo Code session history — read-only over the CLI's SQLite store.
//!
//! Kilo (an OpenCode fork) keeps sessions in `~/.local/share/kilo/kilo.db`
//! (WAL; `session` / `message` / `part` tables). ACP session ids ARE the DB
//! `session.id` values (`ses_…`), so a row listed here round-trips straight
//! into `session/load`, which replays the full transcript — no on-disk
//! transcript reader is needed for resume. Delete is a soft-archive
//! (`time_archived`), mirroring Codex's `archived = 1` convention, so the
//! CLI's own UI stays consistent with ours.

use serde::Serialize;
use std::path::PathBuf;

use super::claude::ClaudeSessionMeta;

fn kilo_db_path() -> Option<PathBuf> {
    if let Ok(custom) = std::env::var("KILO_DB") {
        return Some(PathBuf::from(custom));
    }
    dirs::home_dir().map(|h| h.join(".local/share/kilo/kilo.db"))
}

/// Millisecond epoch → RFC3339, the format the sidebar's date grouping expects
/// (same as the Claude JSONL reader's timestamps).
fn iso(ms: i64) -> Option<String> {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms).map(|dt| dt.to_rfc3339())
}

#[derive(Debug, Serialize)]
struct KiloRow {
    id: String,
    title: String,
    created_ms: i64,
    updated_ms: i64,
    message_count: i64,
}

/// List Kilo sessions for a project root, newest first. The DB stores the
/// CANONICALIZED cwd (`/tmp` → `/private/tmp`), so the incoming path is
/// canonicalized before matching. Missing DB / missing kilo install → empty.
#[tauri::command]
pub async fn list_kilo_sessions(project_path: String) -> Vec<ClaudeSessionMeta> {
    let Some(db) = kilo_db_path() else {
        return Vec::new();
    };
    if !db.exists() {
        return Vec::new();
    }
    // Match the canonical form Kilo stores; fall back to the raw path when
    // canonicalization fails (deleted dir) so stale sessions still list.
    let canon = std::fs::canonicalize(&project_path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| project_path.clone());

    let result = tokio::task::spawn_blocking(move || -> rusqlite::Result<Vec<KiloRow>> {
        let conn = rusqlite::Connection::open_with_flags(
            &db,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        conn.busy_timeout(std::time::Duration::from_millis(3000))?;
        let mut stmt = conn.prepare(
            "SELECT s.id, s.title, s.time_created, s.time_updated, \
             (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) \
             FROM session s \
             WHERE s.directory = ?1 AND s.time_archived IS NULL AND s.parent_id IS NULL \
             ORDER BY s.time_updated DESC LIMIT 300",
        )?;
        let rows = stmt.query_map([&canon], |row| {
            Ok(KiloRow {
                id: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                created_ms: row.get::<_, Option<i64>>(2)?.unwrap_or_default(),
                updated_ms: row.get::<_, Option<i64>>(3)?.unwrap_or_default(),
                message_count: row.get::<_, Option<i64>>(4)?.unwrap_or_default(),
            })
        })?;
        rows.collect()
    })
    .await;

    let rows = match result {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => {
            tracing::warn!(target: "atlas::history", "kilo rusqlite read failed: {e}");
            return Vec::new();
        }
        Err(e) => {
            tracing::warn!(target: "atlas::history", "kilo read task join failed: {e}");
            return Vec::new();
        }
    };

    rows.into_iter()
        .filter(|r| !r.id.is_empty())
        .map(|r| ClaudeSessionMeta {
            id: r.id,
            // No JSONL on disk — resume goes through ACP `session/load`
            // (which replays), so the sidebar routes by empty file_path +
            // agent kind, exactly like Codex/cersei synthetic rows.
            file_path: String::new(),
            started_at: iso(r.created_ms),
            last_modified: iso(r.updated_ms),
            message_count: r.message_count.max(0) as usize,
            preview: atlas_agent_transcript::strip_injected_context(&r.title),
        })
        .collect()
}

/// Soft-delete a Kilo session (archive). Kilo's own UIs filter on
/// `time_archived IS NULL`, so this hides the row everywhere consistently and
/// stays reversible from the Kilo CLI.
#[tauri::command]
pub async fn kilo_delete_session(session_id: String) -> Result<(), String> {
    let Some(db) = kilo_db_path() else {
        return Err("Kilo data directory not found".into());
    };
    if !db.exists() {
        return Err("Kilo database not found".into());
    }
    let now_ms = chrono::Utc::now().timestamp_millis();
    tokio::task::spawn_blocking(move || -> rusqlite::Result<usize> {
        let conn = rusqlite::Connection::open(&db)?;
        conn.busy_timeout(std::time::Duration::from_millis(3000))?;
        conn.execute(
            "UPDATE session SET time_archived = ?1 WHERE id = ?2 AND time_archived IS NULL",
            rusqlite::params![now_ms, session_id],
        )
    })
    .await
    .map_err(|e| format!("kilo delete task failed: {e}"))?
    .map_err(|e| format!("kilo delete failed: {e}"))?;
    Ok(())
}
