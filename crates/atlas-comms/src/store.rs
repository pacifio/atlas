//! Per-organisation local state: the `seq` watermark, and enough of the
//! sidebar to paint before the socket opens.
//!
//! **Messages are deliberately not stored.** REST serves full history to any
//! member at any time, so a message cache is a paint-speed optimisation and
//! never a durability requirement; its absence loses nothing. The watermark, by
//! contrast, is the one thing that cannot be reconstructed — it is what `resume`
//! is asked from, and getting it wrong means either a replay storm or a silent
//! hole in history.
//!
//! The watermark advances **only** on journaled frames. Anything ephemeral —
//! typing, presence, read positions — carries no `seq` and must never touch it.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::Result;
use crate::wire::{Conversation, ReadState};

/// Where the store lives, given the app's config directory.
pub fn db_path(config_dir: &Path) -> PathBuf {
    config_dir.join("comms.db")
}

/// What we can paint from disk before a socket exists.
#[derive(Debug, Default, Clone)]
pub struct OrgSnapshot {
    pub watermark: i64,
    pub conversations: Vec<Conversation>,
    pub discoverable: Vec<Conversation>,
    pub reads: Vec<ReadState>,
}

pub struct CommsStore {
    conn: Connection,
}

impl CommsStore {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(path)?;
        Self::migrate(&conn)?;
        Ok(Self { conn })
    }

    /// An ephemeral store. Used by tests, and the honest fallback if the real
    /// database cannot be opened: chat still works, it just re-syncs on every
    /// launch instead of painting from disk.
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        Self::migrate(&conn)?;
        Ok(Self { conn })
    }

    fn migrate(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS orgs (
               org_id             TEXT PRIMARY KEY,
               watermark          INTEGER NOT NULL DEFAULT 0,
               conversations_json TEXT,
               discoverable_json  TEXT,
               reads_json         TEXT,
               updated_at         INTEGER NOT NULL
             );",
        )?;
        Ok(())
    }

    /// The resume point for an org, or 0 when we have never connected.
    pub fn watermark(&self, org_id: &str) -> Result<i64> {
        let found: Option<i64> = self
            .conn
            .query_row(
                "SELECT watermark FROM orgs WHERE org_id = ?1",
                params![org_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(found.unwrap_or(0))
    }

    /// Advance the watermark. **Monotonic**: a lower value is ignored rather
    /// than written, so an out-of-order frame cannot rewind history.
    pub fn set_watermark(&self, org_id: &str, seq: i64) -> Result<()> {
        self.conn.execute(
            "INSERT INTO orgs (org_id, watermark, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(org_id) DO UPDATE SET
               watermark = MAX(watermark, excluded.watermark),
               updated_at = excluded.updated_at",
            params![org_id, seq, now_ms()],
        )?;
        Ok(())
    }

    /// Reset the watermark to exactly `seq`, rewind included.
    ///
    /// The one caller is the `too_old` cold-sync, which adopts the server's
    /// `snapshot_from`. That value can be *lower* than what we hold if the
    /// journal moved on without us, and refusing the rewind there would leave
    /// us asking for a resume point the server has already told us is gone.
    pub fn reset_watermark(&self, org_id: &str, seq: i64) -> Result<()> {
        self.conn.execute(
            "INSERT INTO orgs (org_id, watermark, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(org_id) DO UPDATE SET
               watermark = excluded.watermark,
               updated_at = excluded.updated_at",
            params![org_id, seq, now_ms()],
        )?;
        Ok(())
    }

    /// Persist the sidebar so the next launch paints before connecting.
    pub fn save_snapshot(
        &self,
        org_id: &str,
        conversations: &[Conversation],
        discoverable: &[Conversation],
        reads: &[ReadState],
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO orgs (org_id, watermark, conversations_json, discoverable_json, reads_json, updated_at)
             VALUES (?1, 0, ?2, ?3, ?4, ?5)
             ON CONFLICT(org_id) DO UPDATE SET
               conversations_json = excluded.conversations_json,
               discoverable_json  = excluded.discoverable_json,
               reads_json         = excluded.reads_json,
               updated_at         = excluded.updated_at",
            params![
                org_id,
                serde_json::to_string(conversations)?,
                serde_json::to_string(discoverable)?,
                serde_json::to_string(reads)?,
                now_ms()
            ],
        )?;
        Ok(())
    }

    pub fn snapshot(&self, org_id: &str) -> Result<OrgSnapshot> {
        let row = self
            .conn
            .query_row(
                "SELECT watermark, conversations_json, discoverable_json, reads_json
                 FROM orgs WHERE org_id = ?1",
                params![org_id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .optional()?;

        let Some((watermark, convs, disc, reads)) = row else {
            return Ok(OrgSnapshot::default());
        };

        // A snapshot that fails to parse is a snapshot from an older shape.
        // Painting an empty sidebar for one launch is the right answer; the
        // socket refills it in a moment, and refusing to open is not.
        Ok(OrgSnapshot {
            watermark,
            conversations: parse_or_empty(convs.as_deref()),
            discoverable: parse_or_empty(disc.as_deref()),
            reads: parse_or_empty(reads.as_deref()),
        })
    }

    /// Drop everything for an org — used when it is deleted or unlinked.
    pub fn forget(&self, org_id: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM orgs WHERE org_id = ?1", params![org_id])?;
        Ok(())
    }
}

fn parse_or_empty<T: serde::de::DeserializeOwned>(raw: Option<&str>) -> Vec<T> {
    raw.and_then(|s| serde_json::from_str(s).ok()).unwrap_or_default()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
