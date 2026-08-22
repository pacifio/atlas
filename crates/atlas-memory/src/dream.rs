//! Idle-time consolidation gates, lock, and state.
//!
//! Ported into Atlas from `cersei_agent::auto_dream`. Only the machinery Atlas
//! uses came over — the SDK's `consolidation_prompt` (an LLM prompt for an agent
//! that reorganises the memory dir) is gone, because `crate::consolidate`
//! implements the prune itself and never asks a model.
//!
//! Three gates, checked cheapest-first:
//! 1. **Time** — ≥24h since the last consolidation.
//! 2. **Session** — ≥5 `*.jsonl` files in the conversations dir newer than that.
//! 3. **Lock** — no other consolidation running (a lock older than 1h is stale).
//!
//! Both filenames below live in the user's memory dir and are already on disk in
//! shipped installs, so they are a compatibility contract, pinned in
//! `tests/cersei_parity.rs`.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

const MIN_HOURS_DEFAULT: f64 = 24.0;
const MIN_SESSIONS_DEFAULT: usize = 5;
/// A lock file older than this is treated as abandoned (crashed run).
const LOCK_STALE_SECS: u64 = 3600;

const STATE_FILE: &str = ".consolidation_state.json";
const LOCK_FILE: &str = ".consolidation_lock";

/// Persisted between runs.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ConsolidationState {
    pub last_consolidated_at: Option<u64>,
    pub lock_etag: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AutoDreamConfig {
    pub min_hours: f64,
    pub min_sessions: usize,
}

impl Default for AutoDreamConfig {
    fn default() -> Self {
        Self {
            min_hours: MIN_HOURS_DEFAULT,
            min_sessions: MIN_SESSIONS_DEFAULT,
        }
    }
}

pub struct AutoDream {
    pub memory_dir: PathBuf,
    pub conversations_dir: PathBuf,
    pub config: AutoDreamConfig,
}

impl AutoDream {
    pub fn new(memory_dir: PathBuf, conversations_dir: PathBuf) -> Self {
        Self {
            memory_dir,
            conversations_dir,
            config: AutoDreamConfig::default(),
        }
    }

    pub fn with_config(mut self, config: AutoDreamConfig) -> Self {
        self.config = config;
        self
    }

    fn state_path(&self) -> PathBuf {
        self.memory_dir.join(STATE_FILE)
    }

    fn lock_path(&self) -> PathBuf {
        self.memory_dir.join(LOCK_FILE)
    }

    // ─── State ───────────────────────────────────────────────────────────

    /// Read the state, falling back to the default for a missing *or corrupt*
    /// file — a half-written state must never stop consolidation from running.
    pub fn load_state(&self) -> ConsolidationState {
        std::fs::read_to_string(self.state_path())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save_state(&self, state: &ConsolidationState) -> std::io::Result<()> {
        let path = self.state_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, serde_json::to_string_pretty(state)?)
    }

    /// Stamp "consolidated just now" and clear any lock etag.
    pub fn update_state(&self) -> std::io::Result<()> {
        self.save_state(&ConsolidationState {
            last_consolidated_at: Some(now_secs()),
            lock_etag: None,
        })
    }

    // ─── Gates ───────────────────────────────────────────────────────────

    /// Gate 1: enough time since the last run? Never-consolidated always passes.
    pub fn time_gate_passes(&self, state: &ConsolidationState) -> bool {
        match state.last_consolidated_at {
            None => true,
            Some(last) => {
                // Saturating: a clock that moved backwards must read as "no time
                // elapsed", not underflow into a huge positive.
                let elapsed = now_secs().saturating_sub(last);
                (elapsed as f64 / 3600.0) >= self.config.min_hours
            }
        }
    }

    /// Gate 2: enough `*.jsonl` sessions newer than the last run?
    ///
    /// A missing/unreadable conversations dir closes the gate.
    pub fn session_gate_passes(&self, state: &ConsolidationState) -> bool {
        let since = state.last_consolidated_at.unwrap_or(0);

        let Ok(entries) = std::fs::read_dir(&self.conversations_dir) else {
            return false;
        };

        let mut count = 0;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            if mtime_secs(&path).unwrap_or(0) > since {
                count += 1;
                if count >= self.config.min_sessions {
                    return true;
                }
            }
        }
        false
    }

    /// Gate 3: no live lock. A lock older than [`LOCK_STALE_SECS`] is ignored.
    pub fn lock_gate_passes(&self) -> bool {
        let lock = self.lock_path();
        if !lock.exists() {
            return true;
        }
        let age = now_secs().saturating_sub(mtime_secs(&lock).unwrap_or(0));
        age > LOCK_STALE_SECS
    }

    /// All three gates, cheapest first.
    pub fn should_consolidate(&self) -> bool {
        let state = self.load_state();
        self.time_gate_passes(&state) && self.session_gate_passes(&state) && self.lock_gate_passes()
    }

    // ─── Lock ────────────────────────────────────────────────────────────

    pub fn acquire_lock(&self) -> std::io::Result<()> {
        let lock = self.lock_path();
        if let Some(parent) = lock.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&lock, now_secs().to_string())
    }

    /// Releasing an unheld lock is a no-op, not an error.
    pub fn release_lock(&self) -> std::io::Result<()> {
        let lock = self.lock_path();
        if lock.exists() {
            std::fs::remove_file(&lock)?;
        }
        Ok(())
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn mtime_secs(path: &std::path::Path) -> Option<u64> {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
}
