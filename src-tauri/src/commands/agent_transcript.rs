//! Atlas-owned session transcripts for agents that keep none of their own.
//!
//! Claude Code writes JSONL under `~/.claude/projects/`, the native agent writes
//! its own JSON, and Kilo has a queryable DB — so all three appear in the
//! session sidebar after a restart. Every OTHER agent (opencode, cursor, and
//! every registry-installed one) is `TranscriptKind::None`: its conversation
//! lived only in the renderer's memory, so the sidebar row vanished the moment
//! the live session stopped matching, and the transcript was gone for good.
//!
//! This module is the missing half. Atlas records the conversation itself, so
//! history works for **every** agent — including ones that don't exist yet —
//! without needing a bespoke reader per agent.
//!
//! Design notes:
//! - **Text only.** Tool calls, plans and thinking are deliberately not stored.
//!   The sidebar needs a title/preview and the reader needs the conversation;
//!   faithfully re-serialising every tool call would multiply the write volume
//!   on the streaming hot path for something replay doesn't render anyway.
//! - **Whole-file writes, atomic via temp+rename.** A session is small (a few
//!   KB of prose) and writes are debounced to turn boundaries, so append-log
//!   complexity buys nothing here.
//! - **Only for `TranscriptKind::None` agents.** Duplicating Claude's or the
//!   native agent's transcript would create two rows for one conversation and
//!   two sources of truth for its title.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

/// One recorded message. Mirrors the subset of `atlas_agent_wire::Message`
/// that replay actually paints.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredMessage {
    /// "user" | "assistant" | "system".
    pub role: String,
    pub content: String,
    pub timestamp: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredTranscript {
    pub id: String,
    /// Which agent produced it — the sidebar's row icon and resume routing.
    pub plugin_id: String,
    pub cwd: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub messages: Vec<StoredMessage>,
}

/// Sidebar row shape. Field-for-field compatible with
/// `claude::ClaudeSessionMeta` so the frontend merges these rows through the
/// path it already has instead of growing a second row type.
///
/// **Deliberately snake_case on the wire** — no `rename_all`, matching
/// `ClaudeSessionMeta` and every other session listing. Getting this wrong is
/// silent and looks exactly like the bug this module was written to fix: the
/// sidebar reads `meta.message_count`, a camelCase payload makes that
/// `undefined`, the row counts as having no content and is filtered out, so
/// history appears broken while the transcripts sit correctly on disk.
#[derive(Debug, Clone, Serialize)]
pub struct AgentSessionMeta {
    pub id: String,
    pub file_path: String,
    pub started_at: Option<String>,
    pub last_modified: Option<String>,
    pub message_count: usize,
    pub preview: String,
    /// Extra vs `ClaudeSessionMeta`: these rows can come from ANY agent, so the
    /// row has to carry which one rather than the caller assuming. snake_case
    /// like its siblings — see the type's note.
    pub plugin_id: String,
}

/// In-memory write-behind buffer, keyed by session id.
///
/// Deltas arrive per streaming chunk; writing the file on each would be
/// hundreds of writes per turn. The buffer accumulates and [`flush`] persists
/// at turn boundaries. It also means a `MessageAppended` for a session whose
/// prompt was recorded earlier still lands in the same file.
pub struct TranscriptState {
    open: Mutex<HashMap<String, StoredTranscript>>,
    /// Where [`save`]/[`read`] put their files. Held so a buffer can be seeded
    /// from the existing transcript — see [`TranscriptState::note_prompt`].
    config_dir: PathBuf,
}

impl TranscriptState {
    pub fn new(config_dir: PathBuf) -> Self {
        Self {
            open: Mutex::new(HashMap::new()),
            config_dir,
        }
    }

    /// Record the user's prompt, creating the session's buffer on first use.
    /// `cwd`/`plugin_id` are only consulted when creating.
    ///
    /// Creating means **loading the existing transcript from disk**, not
    /// starting empty. [`save`] rewrites the whole file, so a buffer that
    /// started empty would persist only the turns seen since it was created and
    /// destroy every earlier one. That is what happened on every resume: reopen
    /// a session, send one message, and the file was left holding that message
    /// alone. The buffer is only ever dropped by [`TranscriptState::forget`],
    /// so re-seeding here is the one place that can happen.
    pub fn note_prompt(
        &self,
        session_id: &str,
        cwd: &str,
        plugin_id: &str,
        text: &str,
        now: String,
    ) {
        // Read off-lock: this is a filesystem hit, and it only happens on the
        // first prompt of a session.
        let seed = if self.open.lock().contains_key(session_id) {
            None
        } else {
            read(&self.config_dir, cwd, session_id)
        };
        let mut open = self.open.lock();
        let entry = open.entry(session_id.to_string()).or_insert_with(|| {
            seed.unwrap_or_else(|| StoredTranscript {
                id: session_id.to_string(),
                plugin_id: plugin_id.to_string(),
                cwd: cwd.to_string(),
                created_at: now.clone(),
                updated_at: now.clone(),
                messages: Vec::new(),
            })
        });
        entry.updated_at = now.clone();
        entry.messages.push(StoredMessage {
            role: "user".into(),
            content: text.to_string(),
            timestamp: now,
            model: None,
        });
    }

    /// Record an assistant/system message. Dropped when the session has no
    /// buffer yet: without a prompt we have no `cwd` to file it under, and a
    /// transcript that starts mid-answer has no usable title anyway.
    pub fn note_message(
        &self,
        session_id: &str,
        role: &str,
        content: &str,
        model: Option<&str>,
        now: String,
    ) {
        if content.trim().is_empty() {
            return;
        }
        let mut open = self.open.lock();
        let Some(entry) = open.get_mut(session_id) else {
            return;
        };
        entry.updated_at = now.clone();
        entry.messages.push(StoredMessage {
            role: role.to_string(),
            content: content.to_string(),
            timestamp: now,
            model: model.map(str::to_string),
        });
    }

    /// Record a user message that arrived as a delta instead of through
    /// `agents_send` — a queued send firing, or an agent echoing the prompt.
    ///
    /// Deduped against the immediately-preceding message, because the ordinary
    /// case is that `agents_send` already recorded it. Checking only the last
    /// message (not the whole history) is deliberate: a user who genuinely
    /// repeats themselves later in the conversation must still get both turns.
    pub fn note_user_delta(&self, session_id: &str, content: &str, now: String) {
        if content.trim().is_empty() {
            return;
        }
        let mut open = self.open.lock();
        let Some(entry) = open.get_mut(session_id) else {
            return;
        };
        if entry
            .messages
            .last()
            .is_some_and(|m| m.role == "user" && m.content == content)
        {
            return;
        }
        entry.updated_at = now.clone();
        entry.messages.push(StoredMessage {
            role: "user".into(),
            content: content.to_string(),
            timestamp: now,
            model: None,
        });
    }

    /// Snapshot for persisting. Kept in memory afterwards so the next turn
    /// appends rather than starting a new file.
    pub fn snapshot(&self, session_id: &str) -> Option<StoredTranscript> {
        self.open.lock().get(session_id).cloned()
    }

    /// Release a session's buffer (tab closed / session dropped).
    pub fn forget(&self, session_id: &str) {
        self.open.lock().remove(session_id);
    }
}

/// `<config>/agent-transcripts/<cwd-hash>/`.
///
/// Hashed rather than path-encoded: Claude's scheme of replacing separators
/// collides for paths differing only by a `-` vs `/`, and it produces
/// unreadably long names for deep paths. The `cwd` is stored INSIDE each file,
/// so nothing needs to reverse the hash.
pub fn dir_for(config_dir: &Path, cwd: &str) -> PathBuf {
    config_dir.join("agent-transcripts").join(cwd_hash(cwd))
}

fn cwd_hash(cwd: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    cwd.trim_end_matches('/').hash(&mut h);
    format!("{:016x}", h.finish())
}

/// Persist one transcript. Atomic: temp file + rename, so a crash mid-write
/// leaves the previous good copy rather than a truncated one.
pub fn save(config_dir: &Path, t: &StoredTranscript) -> std::io::Result<()> {
    let dir = dir_for(config_dir, &t.cwd);
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{}.json", sanitize_id(&t.id)));
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(t)?)?;
    std::fs::rename(&tmp, &path)
}

/// Session ids come from the agent, so they are not guaranteed to be safe as a
/// filename — `..` or a separator would escape the directory.
fn sanitize_id(id: &str) -> String {
    id.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

/// Every Atlas-recorded session for `cwd`, newest first.
pub fn list(config_dir: &Path, cwd: &str) -> Vec<AgentSessionMeta> {
    let dir = dir_for(config_dir, cwd);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out: Vec<AgentSessionMeta> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| {
            let bytes = std::fs::read(e.path()).ok()?;
            let t: StoredTranscript = serde_json::from_slice(&bytes).ok()?;
            // A transcript with no user message has no title and nothing worth
            // reopening — never list it (this is the "empty chat I can't
            // remove" failure mode the Claude sidebar already guards against).
            let preview = t.messages.iter().find(|m| m.role == "user")?.content.clone();
            Some(AgentSessionMeta {
                id: t.id,
                file_path: e.path().to_string_lossy().into_owned(),
                started_at: Some(t.created_at),
                last_modified: Some(t.updated_at.clone()),
                message_count: t.messages.len(),
                preview,
                plugin_id: t.plugin_id,
            })
        })
        .collect();
    out.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
    out
}

/// Read one transcript back for replay.
pub fn read(config_dir: &Path, cwd: &str, session_id: &str) -> Option<StoredTranscript> {
    let path = dir_for(config_dir, cwd).join(format!("{}.json", sanitize_id(session_id)));
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Delete a session's transcript (sidebar delete).
pub fn remove(config_dir: &Path, cwd: &str, session_id: &str) -> std::io::Result<()> {
    let path = dir_for(config_dir, cwd).join(format!("{}.json", sanitize_id(session_id)));
    match std::fs::remove_file(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A directory unique to each call. Tests run in parallel, so a shared
    /// path (plus the `remove_dir_all` this used to do) had them deleting each
    /// other's fixtures.
    fn tmp() -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let d = std::env::temp_dir().join(format!(
            "atlas-transcript-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn state_with_turn() -> (TranscriptState, StoredTranscript) {
        let st = TranscriptState::new(tmp());
        st.note_prompt("ses_1", "/w", "opencode", "hello there", "2026-01-01T00:00:00Z".into());
        st.note_message("ses_1", "assistant", "hi back", Some("gpt-x"), "2026-01-01T00:00:01Z".into());
        let t = st.snapshot("ses_1").unwrap();
        (st, t)
    }

    #[test]
    fn a_turn_round_trips_through_disk() {
        let dir = tmp();
        let (_st, t) = state_with_turn();
        save(&dir, &t).unwrap();
        let back = read(&dir, "/w", "ses_1").unwrap();
        assert_eq!(back.plugin_id, "opencode");
        assert_eq!(back.messages.len(), 2);
        assert_eq!(back.messages[0].content, "hello there");
        assert_eq!(back.messages[1].model.as_deref(), Some("gpt-x"));
    }

    #[test]
    fn listing_surfaces_the_row_the_sidebar_needs() {
        // The whole point: after a restart this is what makes an opencode /
        // gemini session still appear in history.
        let dir = tmp();
        let (_st, t) = state_with_turn();
        save(&dir, &t).unwrap();
        let rows = list(&dir, "/w");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "ses_1");
        assert_eq!(rows[0].plugin_id, "opencode");
        assert_eq!(rows[0].preview, "hello there", "title comes from the user's words");
        assert_eq!(rows[0].message_count, 2);
    }

    #[test]
    fn a_session_with_no_user_message_is_never_listed() {
        // Would be an untitled row the user cannot meaningfully reopen.
        let dir = tmp();
        let st = TranscriptState::new(tmp());
        st.note_prompt("ses_2", "/w", "opencode", "q", "2026-01-01T00:00:00Z".into());
        let mut t = st.snapshot("ses_2").unwrap();
        t.messages.clear();
        save(&dir, &t).unwrap();
        assert!(list(&dir, "/w").is_empty());
    }

    #[test]
    fn an_assistant_message_without_a_prompt_is_dropped() {
        // No prompt means no cwd to file it under, and no usable title.
        let st = TranscriptState::new(tmp());
        st.note_message("ghost", "assistant", "orphan", None, "t".into());
        assert!(st.snapshot("ghost").is_none());
    }

    #[test]
    fn empty_content_is_not_recorded() {
        let st = TranscriptState::new(tmp());
        st.note_prompt("s", "/w", "opencode", "q", "t".into());
        st.note_message("s", "assistant", "   ", None, "t".into());
        assert_eq!(st.snapshot("s").unwrap().messages.len(), 1);
    }

    #[test]
    fn listing_is_newest_first_and_scoped_to_its_project() {
        let dir = tmp();
        for (id, when) in [("old", "2026-01-01T00:00:00Z"), ("new", "2026-06-01T00:00:00Z")] {
            let st = TranscriptState::new(tmp());
            st.note_prompt(id, "/w", "opencode", "q", when.to_string());
            save(&dir, &st.snapshot(id).unwrap()).unwrap();
        }
        let st = TranscriptState::new(tmp());
        st.note_prompt("other", "/elsewhere", "opencode", "q", "2026-07-01T00:00:00Z".into());
        save(&dir, &st.snapshot("other").unwrap()).unwrap();

        let rows = list(&dir, "/w");
        assert_eq!(rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["new", "old"]);
        assert_eq!(list(&dir, "/elsewhere").len(), 1, "other project is separate");
    }

    #[test]
    fn a_hostile_session_id_cannot_escape_its_directory() {
        let dir = tmp();
        let st = TranscriptState::new(tmp());
        st.note_prompt("../../etc/passwd", "/w", "opencode", "q", "t".into());
        save(&dir, &st.snapshot("../../etc/passwd").unwrap()).unwrap();
        // Landed inside the project dir under a sanitized name.
        assert_eq!(list(&dir, "/w").len(), 1);
        assert!(!dir.join("etc").exists());
    }

    #[test]
    fn resuming_a_session_keeps_the_turns_already_on_disk() {
        // The buffer is in-memory, `save` rewrites the whole file, and a
        // restart/resume starts with an empty map. Without seeding from disk
        // the first flush after a resume replaced a long conversation with the
        // single turn this process had seen.
        let dir = tmp();
        let (_st, t) = state_with_turn();
        save(&dir, &t).unwrap();

        // A NEW state over the same directory — this is a resume.
        let fresh = TranscriptState::new(dir.clone());
        fresh.note_prompt("ses_1", "/w", "opencode", "much later", "2026-02-01T00:00:00Z".into());
        save(&dir, &fresh.snapshot("ses_1").unwrap()).unwrap();

        let back = read(&dir, "/w", "ses_1").unwrap();
        assert_eq!(
            back.messages.iter().map(|m| m.content.as_str()).collect::<Vec<_>>(),
            ["hello there", "hi back", "much later"],
            "the original turns must survive the resume"
        );
        assert_eq!(back.created_at, "2026-01-01T00:00:00Z", "creation time is the original");
    }

    #[test]
    fn a_queued_user_message_is_recorded_but_an_echo_is_not() {
        // User deltas used to be dropped outright, so a queued send left the
        // agent's answer in the transcript with no question above it.
        let st = TranscriptState::new(tmp());
        st.note_prompt("s", "/w", "opencode", "first", "t".into());
        // The agent echoes the prompt we just recorded — already there.
        st.note_user_delta("s", "first", "t".into());
        assert_eq!(st.snapshot("s").unwrap().messages.len(), 1, "echo is deduped");

        // A queued send that never passed through `agents_send`.
        st.note_user_delta("s", "queued", "t".into());
        let msgs = st.snapshot("s").unwrap().messages;
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[1].content, "queued");
        assert_eq!(msgs[1].role, "user");
    }

    #[test]
    fn the_same_question_asked_twice_is_kept_twice() {
        // Dedup looks only at the LAST message, so a user genuinely repeating
        // themselves later still gets both turns.
        let st = TranscriptState::new(tmp());
        st.note_prompt("s", "/w", "opencode", "why", "t".into());
        st.note_message("s", "assistant", "because", None, "t".into());
        st.note_user_delta("s", "why", "t".into());
        assert_eq!(st.snapshot("s").unwrap().messages.len(), 3);
    }

    #[test]
    fn a_second_turn_appends_to_the_same_session() {
        let dir = tmp();
        let (st, t) = state_with_turn();
        save(&dir, &t).unwrap();
        st.note_prompt("ses_1", "/w", "opencode", "follow up", "2026-01-01T00:01:00Z".into());
        save(&dir, &st.snapshot("ses_1").unwrap()).unwrap();
        assert_eq!(read(&dir, "/w", "ses_1").unwrap().messages.len(), 3);
        assert_eq!(list(&dir, "/w").len(), 1, "still one session, not two");
    }

    #[test]
    fn removing_is_idempotent() {
        let dir = tmp();
        let (_st, t) = state_with_turn();
        save(&dir, &t).unwrap();
        remove(&dir, "/w", "ses_1").unwrap();
        assert!(list(&dir, "/w").is_empty());
        remove(&dir, "/w", "ses_1").expect("second remove must not error");
    }

    #[test]
    fn paths_that_differ_only_by_separator_do_not_collide() {
        // The flaw in Claude's separator-replacing scheme.
        assert_ne!(cwd_hash("/a/b"), cwd_hash("/a-b"));
        // …and a trailing slash is the same project.
        assert_eq!(cwd_hash("/a/b"), cwd_hash("/a/b/"));
    }

    /// The sidebar reads these field names off the payload directly, and
    /// TypeScript cannot see across the IPC boundary — so a `rename_all` here
    /// is invisible at compile time and silently drops every row: `undefined`
    /// `message_count` makes the row count as empty and it is filtered out,
    /// while the transcripts sit perfectly fine on disk. That exact mistake
    /// shipped once; this is the guard.
    #[test]
    fn the_wire_shape_is_snake_case_like_every_other_session_listing() {
        let dir = tmp();
        let (_st, t) = state_with_turn();
        save(&dir, &t).unwrap();
        let row = &list(&dir, "/w")[0];
        let v = serde_json::to_value(row).unwrap();
        let obj = v.as_object().unwrap();
        for key in [
            "id",
            "file_path",
            "started_at",
            "last_modified",
            "message_count",
            "preview",
            "plugin_id",
        ] {
            assert!(obj.contains_key(key), "missing `{key}` — the sidebar reads it");
        }
        // …and no camelCase twin snuck in.
        for key in ["filePath", "startedAt", "lastModified", "messageCount", "pluginId"] {
            assert!(!obj.contains_key(key), "`{key}` must be snake_case on the wire");
        }
        assert_eq!(obj.len(), 7, "unexpected field — update the frontend interface too");
    }

    #[test]
    fn a_corrupt_file_is_skipped_rather_than_failing_the_listing() {
        let dir = tmp();
        let (_st, t) = state_with_turn();
        save(&dir, &t).unwrap();
        std::fs::write(dir_for(&dir, "/w").join("garbage.json"), b"{not json").unwrap();
        assert_eq!(list(&dir, "/w").len(), 1);
    }
}
