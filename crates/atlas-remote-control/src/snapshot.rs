//! Preparing a session snapshot for the room: redacted, and inside the
//! object's reassembled-snapshot cap.
//!
//! The snapshot is the desktop's `SessionSnapshot` JSON as it is — the web
//! viewer reads `messages`, `status`, `current_mode`, `current_model`,
//! `available_modes`, `available_models`, `available_commands`,
//! `config_options`, `plan`, `pending_permissions`, `pending_elicitation` and
//! `queue` off it — with one change when it has to: a long session's
//! transcript is past the 1 MiB [`RC_SNAPSHOT_MAX_BYTES`] (a mobile
//! time-to-first-paint budget the object enforces, refusing anything larger),
//! so the oldest messages are dropped until it fits, and
//! `rc_trimmed_messages` says how many. A joiner sees the recent conversation
//! and the live turn, which is what remote control is for; the whole
//! transcript stays on the desktop.
//!
//! The lists a viewer *picks from* — the slash commands, the config-option
//! knobs, the modes, the models — are not expendable: they are a few KiB,
//! bounded by what one agent advertises, and the join snapshot is the one
//! place the viewer learns them (a late joiner on a long session would
//! otherwise lose the picker exactly when the transcript is trimmed). They go
//! only in the last resort, with the messages, when four passes could not fit
//! the document.

use serde_json::Value;

use crate::RC_SNAPSHOT_MAX_BYTES;

/// Fields a viewer can live without, dropped before any message is. The
/// queue is one: it is bounded and its items' text is cut on the desktop, but
/// the next `queue_changed` delta restates it whole, so a snapshot that is
/// over budget loses nothing by leaving it out.
const EXPENDABLE: &[&str] = &["subagents", "queue"];

/// Fields a viewer picks from: kept through every trim, cleared only with
/// the messages in the final fallback.
const LAST_RESORT: &[&str] = &["available_commands", "config_options"];

/// What a redaction pass may grow a document by (a placeholder can be longer
/// than the secret it replaces); trimmed for up front.
const REDACTION_HEADROOM: usize = 32 * 1024;

/// Redact `snapshot` and fit it under the cap. Blocking work on a large
/// transcript — call it from a blocking thread.
pub fn prepare(snapshot: Value) -> Vec<u8> {
    prepare_within(snapshot, RC_SNAPSHOT_MAX_BYTES)
}

fn prepare_within(mut snapshot: Value, cap: usize) -> Vec<u8> {
    let mut budget = cap.saturating_sub(REDACTION_HEADROOM);
    for _ in 0..4 {
        fit(&mut snapshot, budget);
        let text = serde_json::to_string(&snapshot).unwrap_or_else(|_| "{}".into());
        let redacted = atlas_redact::redact_json(&text).text;
        if redacted.len() <= cap {
            return redacted.into_bytes();
        }
        budget = budget.saturating_sub(redacted.len() - cap + REDACTION_HEADROOM);
    }
    // Still over after four passes: send the metadata alone rather than a
    // snapshot the object will refuse.
    if let Some(object) = snapshot.as_object_mut() {
        for key in LAST_RESORT.iter().chain(["messages"].iter()) {
            if let Some(field) = object.get_mut(*key) {
                *field = Value::Array(Vec::new());
            }
        }
    }
    atlas_redact::redact_json(&serde_json::to_string(&snapshot).unwrap_or_else(|_| "{}".into()))
        .text
        .into_bytes()
}

/// Drop what a viewer can spare, then the oldest messages, until the
/// serialised document is at most `budget` bytes.
fn fit(snapshot: &mut Value, budget: usize) {
    let size = |v: &Value| serde_json::to_vec(v).map_or(0, |b| b.len());
    if size(snapshot) <= budget {
        return;
    }
    let Some(object) = snapshot.as_object_mut() else {
        return;
    };
    for key in EXPENDABLE {
        if let Some(field) = object.get_mut(*key) {
            *field = Value::Array(Vec::new());
        }
    }
    if size(snapshot) <= budget {
        return;
    }
    let total = size(snapshot);
    let Some(messages) = snapshot.get_mut("messages").and_then(Value::as_array_mut) else {
        return;
    };
    let mut excess = total.saturating_sub(budget);
    let mut drop = 0;
    for message in messages.iter() {
        if excess == 0 {
            break;
        }
        excess = excess.saturating_sub(size(message) + 1);
        drop += 1;
    }
    let drop = drop.min(messages.len());
    messages.drain(..drop);
    if let Some(object) = snapshot.as_object_mut() {
        let already = object
            .get("rc_trimmed_messages")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        object.insert(
            "rc_trimmed_messages".into(),
            Value::from(already + drop as u64),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_small_snapshot_passes_through_whole() {
        let snapshot = json!({ "as_of_seq": 4, "messages": [{ "id": "m1", "content": "hi" }] });
        let out: Value = serde_json::from_slice(&prepare(snapshot.clone())).unwrap();
        assert_eq!(out, snapshot);
    }

    #[test]
    fn a_long_transcript_keeps_its_newest_messages_and_says_how_many_went() {
        let messages: Vec<Value> = (0..200)
            .map(|i| json!({ "id": format!("m{i}"), "content": "word ".repeat(200) }))
            .collect();
        let snapshot = json!({ "as_of_seq": 9, "messages": messages, "status": "running" });
        let cap = 64 * 1024;
        let out = prepare_within(snapshot, cap);
        assert!(out.len() <= cap, "{} > {cap}", out.len());
        let out: Value = serde_json::from_slice(&out).unwrap();
        let kept = out["messages"].as_array().unwrap();
        assert_eq!(kept.last().unwrap()["id"], "m199", "the newest stays");
        assert_eq!(
            out["rc_trimmed_messages"].as_u64().unwrap() as usize + kept.len(),
            200
        );
        assert_eq!(out["status"], "running");
        assert_eq!(out["as_of_seq"], 9);
    }

    /// The slash commands and the config-option knobs are what the viewer's
    /// pickers draw; a long session trims messages around them, never them.
    #[test]
    fn a_trimmed_snapshot_keeps_the_lists_a_viewer_picks_from() {
        let messages: Vec<Value> = (0..200)
            .map(|i| json!({ "id": format!("m{i}"), "content": "word ".repeat(200) }))
            .collect();
        let commands: Vec<Value> = (0..20)
            .map(|i| json!({ "name": format!("command-{i}"), "description": "does a thing" }))
            .collect();
        let options: Vec<Value> = (0..4)
            .map(|i| {
                json!({
                    "id": format!("knob-{i}"),
                    "name": "Knob",
                    "category": "thought_level",
                    "type": "select",
                    "currentValue": "high",
                    "options": [{ "value": "low", "name": "Low" }, { "value": "high", "name": "High" }],
                })
            })
            .collect();
        let snapshot = json!({
            "as_of_seq": 9,
            "messages": messages,
            "status": "running",
            "available_commands": commands,
            "config_options": options,
            "available_modes": [{ "id": "plan", "name": "Plan" }],
            "available_models": [{ "id": "m1", "name": "One" }],
            "subagents": [{ "tool_call_id": "c1" }],
        });
        let cap = 64 * 1024;
        let out = prepare_within(snapshot, cap);
        assert!(out.len() <= cap, "{} > {cap}", out.len());
        let out: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(out["available_commands"].as_array().unwrap().len(), 20);
        assert_eq!(out["config_options"].as_array().unwrap().len(), 4);
        assert_eq!(out["available_modes"].as_array().unwrap().len(), 1);
        assert_eq!(out["available_models"].as_array().unwrap().len(), 1);
        assert!(
            out["rc_trimmed_messages"].as_u64().unwrap() > 0,
            "messages went instead"
        );
        assert!(
            out["subagents"].as_array().unwrap().is_empty(),
            "subagents are still expendable"
        );
    }

    /// When nothing else fits, the lists go with the messages — the object
    /// refuses an oversized snapshot outright, which is worse than no picker.
    #[test]
    fn the_final_fallback_sends_the_metadata_alone() {
        let big = "x".repeat(128 * 1024);
        let snapshot = json!({
            "as_of_seq": 1,
            "status": "running",
            "messages": [{ "id": "m1", "content": big }],
            "available_commands": [{ "name": "huge", "description": big }],
            "config_options": [{ "id": "huge", "description": big }],
        });
        let cap = 64 * 1024;
        let out = prepare_within(snapshot, cap);
        assert!(out.len() <= cap, "{} > {cap}", out.len());
        let out: Value = serde_json::from_slice(&out).unwrap();
        assert!(out["messages"].as_array().unwrap().is_empty());
        assert!(out["available_commands"].as_array().unwrap().is_empty());
        assert!(out["config_options"].as_array().unwrap().is_empty());
        assert_eq!(out["status"], "running");
        assert_eq!(out["as_of_seq"], 1);
    }

    /// The queue goes before any message does: the next `queue_changed`
    /// restates it, the messages have no second chance.
    #[test]
    fn an_over_budget_snapshot_drops_the_queue_before_a_message() {
        let messages: Vec<Value> = (0..4)
            .map(|i| json!({ "id": format!("m{i}"), "content": "word ".repeat(100) }))
            .collect();
        let queue: Vec<Value> = (0..16)
            .map(|i| json!({ "id": format!("q{i}"), "text": "x".repeat(2048), "origin": "local" }))
            .collect();
        let snapshot = json!({
            "as_of_seq": 3,
            "status": "running",
            "messages": messages,
            "queue": queue,
            "subagents": [],
        });
        // Fits once the queue is gone; the messages would have had to go too
        // if the queue stayed.
        let cap = 40 * 1024;
        let out = prepare_within(snapshot, cap);
        assert!(out.len() <= cap, "{} > {cap}", out.len());
        let out: Value = serde_json::from_slice(&out).unwrap();
        assert!(
            out["queue"].as_array().unwrap().is_empty(),
            "the queue went"
        );
        assert_eq!(
            out["messages"].as_array().unwrap().len(),
            4,
            "every message stayed"
        );
        assert!(out.get("rc_trimmed_messages").is_none());
    }

    #[test]
    fn a_secret_never_leaves_in_a_snapshot() {
        let key = "sk-ant-api03-".to_string() + &"a1B2c3D4".repeat(10);
        let snapshot =
            json!({ "messages": [{ "id": "m1", "content": format!("my key is {key}") }] });
        let out = String::from_utf8(prepare(snapshot)).unwrap();
        assert!(!out.contains(&key), "{out}");
    }
}
