//! Graph-backed memory over the embedded [`grafeo`] database.
//!
//! Ported into Atlas from `cersei-memory`'s `graph` + `memdir::MemoryType`. The
//! GQL text, the schema, and the shape of every return value are reproduced
//! exactly — `tests/cersei_parity.rs` was written against the SDK version and
//! passes unchanged against this one.
//!
//! ## Schema (v2)
//! ```text
//! (:Memory {id, content, mem_type, confidence, created_at, updated_at,
//!           last_validated_at, decay_rate, embedding_model_version})
//!   -[:RELATES_TO {relationship}]-> (:Memory)
//! (:Topic {name}) -[:TAGGED]-> (:Memory)
//! (:SchemaVersion {singleton, version, migrated_at, code_version})
//! ```
//!
//! ## Inherited quirks — deliberately preserved
//!
//! These are wrong-ish, load-bearing, and out of scope for a port. Each is
//! pinned by a named test in `tests/cersei_parity.rs`; fix them as their own
//! change, with that file updated in the same commit.
//!
//! - **Results are wrapped in literal double quotes.** Every query renders cells
//!   with `format!("{}", value)`, and grafeo's `Display` for a string value
//!   includes its quotes, so callers get `"\"fact\""`. Nothing downstream strips
//!   them.
//! - **`tag_memory` inserts a fresh `:Topic` node per call**, so tagging N
//!   memories with one topic leaves N `:Topic` nodes rather than one shared node.
//! - **Only `content` and the `recall` query are escaped.** Topic, relationship
//!   and id strings are interpolated raw. Every caller in Atlas passes fixed
//!   internal labels, so this is currently unreachable, not exploited.
//! - **There is no delete.** `crate::consolidate` prunes the memdir instead and
//!   documents why.

use std::path::Path;

use anyhow::{anyhow, Result};
use grafeo::GrafeoDB;

/// Schema version stamped into the graph. Both migrations Cersei shipped (v0→v1,
/// v1→v2) were pure no-ops that only moved this number — grafeo is schema-less,
/// so "new fields" just means newer `INSERT`s carry them and older nodes read
/// back as absent. The stamp is kept so a graph written here stays byte-shape
/// compatible with one written by the SDK.
pub const CURRENT_SCHEMA_VERSION: u32 = 2;

/// Taxonomy for a stored memory. Ported from `cersei_memory::memdir::MemoryType`.
///
/// The `Debug` spelling of each variant is written into the graph as `mem_type`,
/// so these names are on-disk data — renaming one orphans every stored node of
/// that type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryType {
    User,
    Feedback,
    Project,
    Reference,
}

impl MemoryType {
    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "user" => Some(Self::User),
            "feedback" => Some(Self::Feedback),
            "project" => Some(Self::Project),
            "reference" => Some(Self::Reference),
            _ => None,
        }
    }
}

/// Counts across the graph.
#[derive(Debug, Clone, Default)]
pub struct GraphStats {
    pub memory_count: usize,
    pub session_count: usize,
    pub topic_count: usize,
    pub relationship_count: usize,
}

// ─── GQL ─────────────────────────────────────────────────────────────────────

mod gql {
    /// Escape the two GQL string-literal metacharacters. Backslash first, or the
    /// backslashes introduced by the quote pass would themselves be escaped.
    pub fn escape(s: &str) -> String {
        s.replace('\\', "\\\\").replace('\'', "\\'")
    }

    pub fn insert_memory(
        id: &str,
        content: &str,
        mem_type: &str,
        confidence: f32,
        now: &str,
    ) -> String {
        format!(
            "INSERT (:Memory {{id: '{id}', content: '{content}', mem_type: '{mem_type}', \
             confidence: {confidence}, created_at: '{now}', updated_at: '{now}', \
             last_validated_at: '{now}', decay_rate: 0.01, embedding_model_version: ''}})"
        )
    }

    pub fn link_memories(from_id: &str, to_id: &str, relationship: &str) -> String {
        format!(
            "MATCH (a:Memory {{id: '{from_id}'}}), (b:Memory {{id: '{to_id}'}}) \
             INSERT (a)-[:RELATES_TO {{relationship: '{relationship}'}}]->(b)"
        )
    }

    pub fn tag_memory(memory_id: &str, topic: &str) -> String {
        format!(
            "MATCH (m:Memory {{id: '{memory_id}'}}) \
             INSERT (:Topic {{name: '{topic}'}})-[:TAGGED]->(m)"
        )
    }

    pub fn insert_session(session_id: &str, now: &str, model: &str, turns: u32) -> String {
        format!(
            "INSERT (:Session {{session_id: '{session_id}', started_at: '{now}', \
             model: '{model}', turns: {turns}}})"
        )
    }

    pub fn recall(escaped_query: &str, limit: usize) -> String {
        format!(
            "MATCH (m:Memory) WHERE m.content CONTAINS '{escaped_query}' RETURN m.content LIMIT {limit}"
        )
    }

    pub fn by_type(type_str: &str) -> String {
        format!("MATCH (m:Memory {{mem_type: '{type_str}'}}) RETURN m.content")
    }

    pub fn by_topic(topic: &str) -> String {
        format!("MATCH (:Topic {{name: '{topic}'}})-[:TAGGED]->(m:Memory) RETURN m.content")
    }

    pub fn insert_version(version: u32, now: &str, code_ver: &str) -> String {
        format!(
            "INSERT (:SchemaVersion {{singleton: 'v', version: {version}, \
             migrated_at: '{now}', code_version: '{code_ver}'}})"
        )
    }

    pub const READ_VERSION: &str = "MATCH (v:SchemaVersion) RETURN v.version";
    pub const COUNT_MEMORIES: &str = "MATCH (m:Memory) RETURN count(m)";
    pub const COUNT_SESSIONS: &str = "MATCH (s:Session) RETURN count(s)";
    pub const COUNT_TOPICS: &str = "MATCH (t:Topic) RETURN count(t)";
    pub const COUNT_RELATIONSHIPS: &str = "MATCH ()-[r:RELATES_TO]->() RETURN count(r)";
}

// ─── Store ───────────────────────────────────────────────────────────────────

/// Graph-backed memory store.
pub struct GraphMemory {
    db: GrafeoDB,
}

impl GraphMemory {
    /// Open (or create) a persistent graph at `path`, stamping the schema
    /// version if it is missing or behind.
    pub fn open(path: &Path) -> Result<Self> {
        let db = GrafeoDB::open(path).map_err(|e| anyhow!("Failed to open graph DB: {e}"))?;
        let me = Self { db };
        me.ensure_schema_version();
        Ok(me)
    }

    /// Open an ephemeral in-memory graph (tests, and the fallback when the
    /// on-disk graph cannot be opened).
    pub fn open_in_memory() -> Result<Self> {
        let me = Self {
            db: GrafeoDB::new_in_memory(),
        };
        me.ensure_schema_version();
        Ok(me)
    }

    /// Stamp `CURRENT_SCHEMA_VERSION` unless the graph already carries it.
    ///
    /// Best-effort by design: a graph written by a *newer* Atlas is left alone
    /// (reads are forward-compatible because grafeo is schema-less), and a
    /// failure here must never stop the engine from opening.
    fn ensure_schema_version(&self) {
        let session = self.db.session();
        let existing: Option<u32> = session
            .execute(gql::READ_VERSION)
            .ok()
            .and_then(|r| {
                r.iter()
                    .next()
                    .and_then(|row| row.first().map(|v| format!("{v}")))
            })
            .and_then(|s| s.trim_matches('"').parse::<u32>().ok());

        if existing.is_some_and(|v| v >= CURRENT_SCHEMA_VERSION) {
            return;
        }

        let now = chrono::Utc::now().to_rfc3339();
        let code_ver = env!("CARGO_PKG_VERSION");
        let _ = session.execute("MATCH (v:SchemaVersion) DELETE v");
        let _ = session.execute(&gql::insert_version(CURRENT_SCHEMA_VERSION, &now, code_ver));
    }

    /// Run a query and collect the first cell of every row as a string.
    ///
    /// This is where the literal-quote wrapping documented at the top of the
    /// module comes from: grafeo's `Display` for a string value includes the
    /// surrounding quotes. Preserved deliberately.
    fn query_first_column(&self, query: &str) -> Vec<String> {
        let session = self.db.session();
        match session.execute(query) {
            Ok(result) => result
                .iter()
                .filter_map(|row| row.first().map(|v| format!("{v}")))
                .collect(),
            Err(_) => Vec::new(),
        }
    }

    // ─── Writes ──────────────────────────────────────────────────────────

    /// Store a memory node. Returns its freshly-minted id.
    pub fn store_memory(
        &self,
        content: &str,
        mem_type: MemoryType,
        confidence: f32,
    ) -> Result<String> {
        let session = self.db.session();
        let mem_type_str = format!("{mem_type:?}");
        let now = chrono::Utc::now().to_rfc3339();
        let id = uuid::Uuid::new_v4().to_string();
        let escaped = gql::escape(content);

        session
            .execute(&gql::insert_memory(
                &id,
                &escaped,
                &mem_type_str,
                confidence,
                &now,
            ))
            .map_err(|e| anyhow!("Graph insert failed: {e}"))?;

        Ok(id)
    }

    /// Link two memories. Unknown ids are a silent no-op, not an error.
    pub fn link_memories(&self, from_id: &str, to_id: &str, relationship: &str) -> Result<()> {
        let session = self.db.session();
        session
            .execute(&gql::link_memories(from_id, to_id, relationship))
            .map_err(|e| anyhow!("Graph link failed: {e}"))?;
        Ok(())
    }

    /// Tag a memory with a topic. An unknown id is a silent no-op, not an error.
    pub fn tag_memory(&self, memory_id: &str, topic: &str) -> Result<()> {
        let session = self.db.session();
        session
            .execute(&gql::tag_memory(memory_id, topic))
            .map_err(|e| anyhow!("Graph tag failed: {e}"))?;
        Ok(())
    }

    /// Record a session node.
    pub fn record_session(&self, session_id: &str, model: Option<&str>, turns: u32) -> Result<()> {
        let session = self.db.session();
        let now = chrono::Utc::now().to_rfc3339();
        session
            .execute(&gql::insert_session(
                session_id,
                &now,
                model.unwrap_or("unknown"),
                turns,
            ))
            .map_err(|e| anyhow!("Graph session record failed: {e}"))?;
        Ok(())
    }

    // ─── Queries ─────────────────────────────────────────────────────────

    /// Memories whose content contains `query_text` **as a whole substring** —
    /// not a word match. Capped by `limit` in the query itself.
    pub fn recall(&self, query_text: &str, limit: usize) -> Vec<String> {
        let escaped = gql::escape(query_text);
        self.query_first_column(&gql::recall(&escaped, limit))
    }

    /// [`recall`](Self::recall) re-ranked by the fraction of query words present.
    ///
    /// Note the ranking is currently inert: candidates come from a whole-phrase
    /// substring match, so each already contains every query word and scores
    /// 1.0. Kept as-is for parity; see the module docs.
    pub fn recall_top_k(&self, query_text: &str, limit: usize) -> Vec<(String, f32)> {
        if limit == 0 || query_text.trim().is_empty() {
            return Vec::new();
        }
        let candidates = self.recall(query_text, limit.saturating_mul(4).max(16));
        let words: Vec<String> = query_text
            .split_whitespace()
            .filter_map(|w| {
                let w = w.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase();
                if w.len() < 2 {
                    None
                } else {
                    Some(w)
                }
            })
            .collect();
        if words.is_empty() {
            return candidates.into_iter().take(limit).map(|c| (c, 1.0)).collect();
        }
        let mut scored: Vec<(String, f32)> = candidates
            .into_iter()
            .map(|c| {
                let lower = c.to_lowercase();
                let hits = words.iter().filter(|w| lower.contains(w.as_str())).count();
                (c, hits as f32 / words.len() as f32)
            })
            .collect();
        // Stable sort → ties keep insertion order, matching the SDK.
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(limit);
        scored
    }

    /// Every memory of one type.
    pub fn by_type(&self, mem_type: MemoryType) -> Vec<String> {
        self.query_first_column(&gql::by_type(&format!("{mem_type:?}")))
    }

    /// Every memory tagged with `topic`.
    pub fn by_topic(&self, topic: &str) -> Vec<String> {
        self.query_first_column(&gql::by_topic(topic))
    }

    /// Node/edge counts.
    pub fn stats(&self) -> GraphStats {
        let count = |q: &str| -> usize {
            self.query_first_column(q)
                .first()
                .and_then(|v| v.trim_matches('"').parse::<usize>().ok())
                .unwrap_or(0)
        };
        GraphStats {
            memory_count: count(gql::COUNT_MEMORIES),
            session_count: count(gql::COUNT_SESSIONS),
            topic_count: count(gql::COUNT_TOPICS),
            relationship_count: count(gql::COUNT_RELATIONSHIPS),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_handles_backslash_before_quote() {
        // Backslash must be doubled first, else the escape for `'` would itself
        // be re-escaped and the literal would break.
        assert_eq!(gql::escape(r"a\b"), r"a\\b");
        assert_eq!(gql::escape("it's"), r"it\'s");
        assert_eq!(gql::escape(r"c:\ 'x'"), r"c:\\ \'x\'");
        assert_eq!(gql::escape("plain"), "plain");
    }

    #[test]
    fn schema_version_is_stamped_once_on_open() {
        let g = GraphMemory::open_in_memory().unwrap();
        let session = g.db.session();
        let rows = session.execute(gql::READ_VERSION).unwrap();
        let versions: Vec<String> = rows
            .iter()
            .filter_map(|r| r.first().map(|v| format!("{v}")))
            .collect();
        assert_eq!(versions.len(), 1, "exactly one SchemaVersion node: {versions:?}");
        assert!(versions[0].contains("2"), "{versions:?}");
    }

    #[test]
    fn stats_counts_nodes_and_edges() {
        let g = GraphMemory::open_in_memory().unwrap();
        let a = g.store_memory("one", MemoryType::User, 0.9).unwrap();
        let b = g.store_memory("two", MemoryType::Project, 0.9).unwrap();
        g.tag_memory(&a, "topic").unwrap();
        g.link_memories(&a, &b, "rel").unwrap();
        g.record_session("s1", Some("m"), 3).unwrap();

        let s = g.stats();
        assert_eq!(s.memory_count, 2);
        assert_eq!(s.topic_count, 1);
        assert_eq!(s.session_count, 1);
        assert_eq!(s.relationship_count, 1);
    }
}
