//! Per-turn agent analytics: one rich event per turn, for every agent.
//!
//! Both agent families feed the same `SessionDelta` pipeline — ACP subprocesses
//! (Claude Code, Codex) and the in-process native agent alike — so accumulating
//! here means one implementation covers all of them, and a new agent is measured
//! the day it lands without touching this file.
//!
//! **What this measures and what it refuses to.** Counts, kinds, extensions and
//! line deltas: how much work a turn did and how it ended. Never a path, an
//! argument, a tool's output, or a word of the conversation. `session_ref` is a
//! salted digest rather than the real ACP session id, which for Claude Code
//! appears in on-disk transcript paths. See `TELEMETRY.md`.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::time::Instant;

use dashmap::DashMap;
use serde_json::{json, Value};

use crate::commands::tool_stats;

/// A point-in-time reading of a session's cumulative usage counters.
#[derive(Clone, Copy, Default, Debug, PartialEq)]
pub struct UsageSnap {
    pub input: u64,
    pub output: u64,
    pub cost: f64,
}

/// Everything accumulated for one turn of one session.
pub struct TurnAcc {
    turn_seq: u64,
    started: Instant,
    /// Tool-call ids seen at all. `ToolCallUpserted` fires repeatedly for the
    /// same call as it moves pending → running → completed, so every count in
    /// here has to be keyed by id rather than incremented per delta.
    seen: HashSet<String>,
    /// Ids already counted terminally, so a re-delivered `completed` doesn't
    /// double it.
    terminal: HashSet<String>,
    completed: u32,
    failed: u32,
    kind_counts: BTreeMap<&'static str, u32>,
    tool_names: BTreeSet<String>,
    /// Salted digests, never paths. Only `.len()` is ever reported.
    files_read: HashSet<u64>,
    files_written: HashSet<u64>,
    extensions: BTreeMap<String, u32>,
    /// Line deltas, counted once per tool-call id.
    lines_counted: HashSet<String>,
    lines_added: u64,
    lines_removed: u64,
    permission_requests: u32,
    permissions_resolved: u32,
    retries: u32,
    compactions: u32,
    compression_saved_tokens: u64,
    context_used: u64,
    context_size: u64,
    context_cost: f64,
    /// Latest cumulative usage seen this turn (native agent only).
    usage_latest: Option<UsageSnap>,
    model_id: Option<String>,
    mode_changes: u32,
    assistant_messages: u32,
    plan_updates: u32,
}

impl TurnAcc {
    fn new(turn_seq: u64) -> Self {
        Self {
            turn_seq,
            started: Instant::now(),
            seen: HashSet::new(),
            terminal: HashSet::new(),
            completed: 0,
            failed: 0,
            kind_counts: BTreeMap::new(),
            tool_names: BTreeSet::new(),
            files_read: HashSet::new(),
            files_written: HashSet::new(),
            extensions: BTreeMap::new(),
            lines_counted: HashSet::new(),
            lines_added: 0,
            lines_removed: 0,
            permission_requests: 0,
            permissions_resolved: 0,
            retries: 0,
            compactions: 0,
            compression_saved_tokens: 0,
            context_used: 0,
            context_size: 0,
            context_cost: 0.0,
            usage_latest: None,
            model_id: None,
            mode_changes: 0,
            assistant_messages: 0,
            plan_updates: 0,
        }
    }
}

/// Managed Tauri state behind the analytics middleware.
pub struct AnalyticsState {
    /// One live turn per session. `SessionActor::finalize` runs strictly before
    /// the next `start_turn`, so a session-keyed slot cannot leak accumulators
    /// for turns that never finished.
    turns: DashMap<String, TurnAcc>,
    /// Cumulative usage carried ACROSS turns, so a turn's tokens can be
    /// differenced out of counters that only ever grow.
    session_cum: DashMap<String, UsageSnap>,
    /// Per-process salt for `path_key` and `session_ref`. Never persisted.
    salt: u64,
}

impl Default for AnalyticsState {
    fn default() -> Self {
        Self::new()
    }
}

impl AnalyticsState {
    pub fn new() -> Self {
        Self {
            turns: DashMap::new(),
            session_cum: DashMap::new(),
            // A fresh random salt per launch: digests cannot be correlated
            // across runs, and there is nothing to reverse even in principle.
            salt: uuid::Uuid::new_v4().as_u128() as u64,
        }
    }

    /// Start a new accumulator — but only when the turn really is new.
    ///
    /// After a permission prompt is answered the actor re-emits `Status{Running}`
    /// for the *same* turn (see `AgentManager::respond_permission`). Resetting on
    /// every `Running` would silently discard everything that happened before the
    /// prompt, which is precisely the half of a permission-gated turn worth
    /// measuring. Hence the `turn_seq` guard rather than a blind insert.
    pub fn begin_turn(&self, session_id: &str, turn_seq: u64) {
        // The read guard is scoped and dropped BEFORE the insert. A `match` over
        // `self.turns.get(..)` with the insert in its `_` arm holds the shard
        // read lock across a write to the same shard — a deadlock, not a race,
        // and it hangs the whole delta pipeline the first time a turn starts.
        let already = self.has_turn(session_id, turn_seq);
        if !already {
            self.turns
                .insert(session_id.to_string(), TurnAcc::new(turn_seq));
        }
    }

    /// Whether this exact turn is already being accumulated. Lets the caller
    /// emit `agent_turn_started` once per turn rather than once per `Running`
    /// (which fires again after every permission prompt).
    pub fn has_turn(&self, session_id: &str, turn_seq: u64) -> bool {
        self.turns
            .get(session_id)
            .is_some_and(|a| a.turn_seq == turn_seq)
    }

    /// Mutate the live accumulator, if one is running.
    pub fn with_turn(&self, session_id: &str, f: impl FnOnce(&mut TurnAcc)) {
        if let Some(mut acc) = self.turns.get_mut(session_id) {
            f(acc.value_mut());
        }
    }

    /// Drop everything held for a session (tab closed, agent died).
    pub fn forget_session(&self, session_id: &str) {
        self.turns.remove(session_id);
        self.session_cum.remove(session_id);
    }

    /// A salted digest of the session id, stable for the process lifetime.
    /// Joins `agent_turn_started` to `agent_turn_completed` without putting the
    /// agent's real session id (which appears in transcript paths) on the wire.
    pub fn session_ref(&self, session_id: &str) -> String {
        format!("{:016x}", tool_stats::path_key(self.salt, session_id))
    }

    pub fn salt(&self) -> u64 {
        self.salt
    }

    /// Take the finished accumulator and turn it into an event body.
    ///
    /// Returns `None` when there is nothing for this turn — a terminal delta
    /// with no matching start (a resumed session's replay, say) should not
    /// invent an empty turn.
    pub fn finish_turn(&self, session_id: &str, turn_seq: u64) -> Option<Value> {
        let (_, acc) = self.turns.remove(session_id)?;
        // A terminal for a superseded turn: the live accumulator belongs to a
        // newer send, so put it back rather than discarding real data.
        if turn_seq != 0 && acc.turn_seq != 0 && acc.turn_seq != turn_seq {
            self.turns.insert(session_id.to_string(), acc);
            return None;
        }

        let mut props = json!({
            "turn_seq": acc.turn_seq,
            "duration_ms": acc.started.elapsed().as_millis() as u64,
            "tool_call_count": acc.seen.len(),
            "tool_calls_completed": acc.completed,
            "tool_calls_failed": acc.failed,
            "distinct_tool_count": acc.tool_names.len(),
            "tool_names": acc.tool_names.iter().collect::<Vec<_>>(),
            "tool_kinds": acc.kind_counts,
            "files_read": acc.files_read.len(),
            "files_written": acc.files_written.len(),
            "file_extensions": acc.extensions,
            "lines_added": acc.lines_added,
            "lines_removed": acc.lines_removed,
            "permission_requests": acc.permission_requests,
            "permissions_resolved": acc.permissions_resolved,
            "retries": acc.retries,
            "compactions": acc.compactions,
            "assistant_messages": acc.assistant_messages,
            "plan_updates": acc.plan_updates,
            "mode_changes": acc.mode_changes,
            "model_id": acc.model_id,
        });
        let map = props.as_object_mut().expect("object");

        if acc.compression_saved_tokens > 0 {
            map.insert(
                "compression_saved_tokens".into(),
                json!(acc.compression_saved_tokens),
            );
        }

        // Two families, two disjoint token signals.
        //
        // The native agent reports a real cumulative input/output/cost split, so
        // a turn's own consumption is the difference against the last reading.
        // ACP agents report only a context-window gauge. Rather than emit zeros
        // for the tokens they cannot know — which would drag every average down
        // with phantom data — those keys are simply absent, and `token_source`
        // makes the distinction queryable instead of guessable.
        match acc.usage_latest {
            Some(latest) => {
                let prev = self
                    .session_cum
                    .get(session_id)
                    .map(|v| *v.value())
                    .unwrap_or_default();
                map.insert(
                    "turn_input_tokens".into(),
                    json!(latest.input.saturating_sub(prev.input)),
                );
                map.insert(
                    "turn_output_tokens".into(),
                    json!(latest.output.saturating_sub(prev.output)),
                );
                map.insert(
                    "turn_cost_usd".into(),
                    json!((latest.cost - prev.cost).max(0.0)),
                );
                map.insert("token_source".into(), json!("usage"));
                self.session_cum.insert(session_id.to_string(), latest);
            }
            None if acc.context_size > 0 => {
                map.insert("context_used".into(), json!(acc.context_used));
                map.insert("context_size".into(), json!(acc.context_size));
                map.insert(
                    "context_pct".into(),
                    json!((acc.context_used as f64 * 100.0 / acc.context_size as f64).round()),
                );
                if acc.context_cost > 0.0 {
                    let prev = self
                        .session_cum
                        .get(session_id)
                        .map(|v| v.cost)
                        .unwrap_or(0.0);
                    map.insert(
                        "turn_cost_usd".into(),
                        json!((acc.context_cost - prev).max(0.0)),
                    );
                    self.session_cum.insert(
                        session_id.to_string(),
                        UsageSnap {
                            cost: acc.context_cost,
                            ..Default::default()
                        },
                    );
                }
                map.insert("token_source".into(), json!("context"));
            }
            None => {
                map.insert("token_source".into(), json!("none"));
            }
        }

        Some(props)
    }
}

impl TurnAcc {
    /// Fold one tool-call snapshot in. Idempotent per tool-call id — the same
    /// call arrives many times as its status advances.
    pub fn note_tool_call(&mut self, salt: u64, tc: &atlas_agent_wire::ToolCall) {
        use atlas_agent_wire::ToolCallStatus;

        let first_sighting = self.seen.insert(tc.id.clone());
        if first_sighting {
            let kind = tool_stats::classify_kind(tc.kind.as_deref(), &tc.tool_name);
            *self.kind_counts.entry(kind).or_insert(0) += 1;
            self.tool_names
                .insert(tool_stats::normalise_tool_name(&tc.tool_name));
        }

        // Terminal state, counted once.
        let terminal = matches!(
            tc.status,
            ToolCallStatus::Completed | ToolCallStatus::Failed
        );
        if terminal && self.terminal.insert(tc.id.clone()) {
            match tc.status {
                ToolCallStatus::Completed => self.completed += 1,
                ToolCallStatus::Failed => self.failed += 1,
                _ => {}
            }
        }

        // Files. Deliberately re-evaluated on updates rather than only on the
        // first sighting: `locations` and `rawInput` often arrive later than the
        // creation event, and the sets dedupe by digest anyway.
        let Some(path) = tool_stats::extract_path(&tc.arguments, &tc.locations) else {
            return;
        };
        let key = tool_stats::path_key(salt, &path);
        let kind = tool_stats::classify_kind(tc.kind.as_deref(), &tc.tool_name);
        let is_write = kind == "edit" || tool_stats::is_edit_tool(&tc.tool_name);
        let newly_touched = if is_write {
            self.files_written.insert(key)
        } else if kind == "read" {
            self.files_read.insert(key)
        } else {
            return; // a search/execute that merely mentions a path isn't a touch
        };
        // Gated on the file being new to this turn: the extension histogram
        // counts files, and a call arriving four times as its status advances
        // would otherwise report four `.rs` files where there is one.
        if newly_touched {
            if let Some(ext) = tool_stats::path_extension(&path) {
                *self.extensions.entry(ext).or_insert(0) += 1;
            }
        }

        // Line counts once per call, and only once its arguments have arrived —
        // an edit's `rawInput` can lag its creation event.
        if is_write && !self.lines_counted.contains(&tc.id) {
            let (added, removed) = tool_stats::count_edit_lines(&tc.tool_name, &tc.arguments);
            if added > 0 || removed > 0 {
                self.lines_counted.insert(tc.id.clone());
                self.lines_added += added;
                self.lines_removed += removed;
            }
        }
    }

    pub fn note_usage(&mut self, usage: &atlas_agent_wire::Usage) {
        self.usage_latest = Some(UsageSnap {
            input: usage.input_tokens,
            output: usage.output_tokens,
            cost: usage.cost,
        });
    }

    pub fn note_context(&mut self, used: u64, size: u64, cost: f64) {
        self.context_used = used;
        self.context_size = size;
        self.context_cost = cost;
    }

    pub fn note_permission_request(&mut self) {
        self.permission_requests += 1;
    }
    pub fn note_permission_resolved(&mut self) {
        self.permissions_resolved += 1;
    }
    pub fn note_retry(&mut self) {
        self.retries += 1;
    }
    pub fn note_compaction(&mut self) {
        self.compactions += 1;
    }
    pub fn note_compression_saved(&mut self, tokens: u64) {
        self.compression_saved_tokens += tokens;
    }
    pub fn note_model(&mut self, model_id: &str) {
        self.model_id = Some(model_id.to_string());
    }
    pub fn note_mode_change(&mut self) {
        self.mode_changes += 1;
    }
    pub fn note_assistant_message(&mut self) {
        self.assistant_messages += 1;
    }
    pub fn note_plan_update(&mut self) {
        self.plan_updates += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use atlas_agent_wire::{ToolCall, ToolCallStatus, Usage};

    fn tool(id: &str, name: &str, kind: &str, status: ToolCallStatus, args: Value) -> ToolCall {
        ToolCall {
            id: id.into(),
            tool_name: name.into(),
            title: Some(name.into()),
            kind: Some(kind.into()),
            status,
            arguments: args,
            result: None,
            raw_output: None,
            content_blocks: Vec::new(),
            locations: Vec::new(),
        }
    }

    /// The hazard this whole design exists for: after the user answers a
    /// permission prompt the actor re-emits `Status{Running}` for the SAME turn.
    /// A naive "new Running → new accumulator" would throw away everything the
    /// agent did before it asked.
    #[test]
    fn permission_resume_does_not_reset_the_accumulator() {
        let st = AnalyticsState::new();
        st.begin_turn("s1", 7);
        for i in 0..3 {
            st.with_turn("s1", |a| {
                a.note_tool_call(
                    st.salt(),
                    &tool(
                        &format!("t{i}"),
                        "Read",
                        "read",
                        ToolCallStatus::Completed,
                        json!({ "file_path": format!("/p/{i}.rs") }),
                    ),
                )
            });
        }
        // The prompt is answered; Running arrives again for turn 7.
        st.begin_turn("s1", 7);
        st.with_turn("s1", super::TurnAcc::note_permission_resolved);

        let props = st.finish_turn("s1", 7).expect("event");
        assert_eq!(props["tool_call_count"], json!(3));
        assert_eq!(props["files_read"], json!(3));
        assert_eq!(props["permissions_resolved"], json!(1));
    }

    #[test]
    fn a_genuinely_new_turn_starts_clean() {
        let st = AnalyticsState::new();
        st.begin_turn("s1", 7);
        st.with_turn("s1", |a| {
            a.note_tool_call(
                st.salt(),
                &tool("t1", "Read", "read", ToolCallStatus::Completed, json!({})),
            )
        });
        st.begin_turn("s1", 8);
        let props = st.finish_turn("s1", 8).expect("event");
        assert_eq!(props["tool_call_count"], json!(0));
        assert_eq!(props["turn_seq"], json!(8));
    }

    /// The same call arrives pending → running → completed. Counting per delta
    /// instead of per id would triple every number on this event.
    #[test]
    fn tool_call_upserts_count_once_per_id() {
        let st = AnalyticsState::new();
        st.begin_turn("s1", 1);
        for status in [
            ToolCallStatus::Pending,
            ToolCallStatus::Running,
            ToolCallStatus::Completed,
            ToolCallStatus::Completed,
        ] {
            st.with_turn("s1", |a| {
                a.note_tool_call(
                    st.salt(),
                    &tool(
                        "t1",
                        "Write",
                        "edit",
                        status,
                        json!({ "file_path": "/a/b.rs", "content": "x\ny" }),
                    ),
                )
            });
        }
        let props = st.finish_turn("s1", 1).expect("event");
        assert_eq!(props["tool_call_count"], json!(1));
        assert_eq!(props["tool_calls_completed"], json!(1));
        assert_eq!(props["files_written"], json!(1));
        assert_eq!(props["lines_added"], json!(2));
        assert_eq!(props["file_extensions"]["rs"], json!(1));
        assert_eq!(props["tool_names"], json!(["write"]));
    }

    /// Native usage counters only ever grow, so a turn's own consumption is the
    /// difference — otherwise turn 2 would report turn 1 + turn 2.
    #[test]
    fn cumulative_usage_is_differenced_across_turns() {
        let st = AnalyticsState::new();

        st.begin_turn("s1", 1);
        st.with_turn("s1", |a| {
            a.note_usage(&Usage {
                input_tokens: 100,
                output_tokens: 20,
                cost: 0.5,
                ..Default::default()
            })
        });
        let p1 = st.finish_turn("s1", 1).expect("turn 1");
        assert_eq!(p1["turn_input_tokens"], json!(100));
        assert_eq!(p1["token_source"], json!("usage"));

        st.begin_turn("s1", 2);
        st.with_turn("s1", |a| {
            a.note_usage(&Usage {
                input_tokens: 250,
                output_tokens: 60,
                cost: 1.25,
                ..Default::default()
            })
        });
        let p2 = st.finish_turn("s1", 2).expect("turn 2");
        assert_eq!(p2["turn_input_tokens"], json!(150));
        assert_eq!(p2["turn_output_tokens"], json!(40));
    }

    /// ACP agents can't give a token split. Emitting zeros would poison every
    /// average, so the keys are absent and `token_source` says why.
    #[test]
    fn acp_turns_report_context_and_omit_token_counts() {
        let st = AnalyticsState::new();
        st.begin_turn("s1", 1);
        st.with_turn("s1", |a| a.note_context(30_000, 200_000, 0.0));
        let props = st.finish_turn("s1", 1).expect("event");
        assert_eq!(props["token_source"], json!("context"));
        assert_eq!(props["context_pct"], json!(15.0));
        assert!(props.get("turn_input_tokens").is_none());
    }

    #[test]
    fn forget_session_drops_state() {
        let st = AnalyticsState::new();
        st.begin_turn("s1", 1);
        st.forget_session("s1");
        assert!(st.finish_turn("s1", 1).is_none());
    }

    /// A terminal for a superseded turn must not consume the live accumulator
    /// belonging to the newer send.
    #[test]
    fn stale_terminal_leaves_the_live_turn_alone() {
        let st = AnalyticsState::new();
        st.begin_turn("s1", 9);
        assert!(st.finish_turn("s1", 8).is_none(), "stale terminal ignored");
        assert!(st.finish_turn("s1", 9).is_some(), "live turn still there");
    }

    #[test]
    fn session_ref_is_stable_and_not_the_session_id() {
        let st = AnalyticsState::new();
        let r = st.session_ref("acp-session-abc");
        assert_eq!(r, st.session_ref("acp-session-abc"));
        assert!(!r.contains("acp"));
        assert_eq!(r.len(), 16);
    }
}
