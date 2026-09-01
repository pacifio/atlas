//! The reducer against recorded frames.
//!
//! Everything here is a rule from the wire contract that is invisible until it
//! is embarrassing: an ack that doubles a message, a watermark advanced by a
//! typing hint, a reply pointing at a message that vanished.

use atlas_comms::state::{apply_frame, optimistic_id, ChatState, MemberChange, PendingSend, SendStatus, StateDelta};
use atlas_comms::wire::{self, ServerFrame};
use std::collections::HashMap;

const NOW: i64 = 1_756_300_000_000;

fn frame(json: serde_json::Value) -> ServerFrame {
    serde_json::from_value(json).expect("frame should deserialize")
}

fn hello() -> ServerFrame {
    frame(serde_json::json!({
        "t": "hello",
        "seq": 100,
        "user_id": "u_me",
        "org_id": "org_1",
        "role": "developer",
        "conversations": [conv("c1", "eng", "public_org", "u_other")],
        "discoverable": [conv("c2", "design", "public_org", "u_other")],
        "reads": [{ "conv_id": "c1", "last_read_seq": 90, "unread": 2, "mentions": 1 }],
        "online": ["u_me", "u_other"],
    }))
}

fn conv(id: &str, name: &str, visibility: &str, created_by: &str) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "kind": "channel",
        "name": name,
        "visibility": visibility,
        "workspace_ref_ids": [],
        "created_by": created_by,
        "created_at": NOW,
        "archived_at": null,
        "seq": 1,
        "member_ids": null,
        "last_activity_seq": 1,
    })
}

fn message_new(id: &str, seq: i64, author: &str, body: &str) -> serde_json::Value {
    serde_json::json!({
        "t": "message.new",
        "seq": seq,
        "conv_id": "c1",
        "id": id,
        "author_id": author,
        "body": body,
        "reply_to_id": null,
        "edited_at": null,
        "created_at": NOW,
        "attachments": [],
        "code_refs": [],
        "draft_id": null,
    })
}

fn fresh() -> (ChatState, HashMap<String, PendingSend>) {
    let mut state = ChatState::default();
    let mut pending = HashMap::new();
    apply_frame(&mut state, hello(), &mut pending, NOW);
    (state, pending)
}

#[test]
fn hello_adopts_both_lists_reads_and_presence() {
    let (state, _) = fresh();
    assert_eq!(state.me.as_deref(), Some("u_me"));
    assert_eq!(state.conversations.len(), 1);
    // Two arrays, never merged — the separation is the safety property.
    assert_eq!(state.discoverable.len(), 1);
    assert_eq!(state.reads.get("c1").map(|r| r.unread), Some(2));
    assert_eq!(state.online, vec!["u_me", "u_other"]);
}

#[test]
fn messages_are_ordered_by_seq_not_arrival() {
    let (mut state, mut pending) = fresh();
    for f in [
        message_new("m2", 102, "u_other", "second"),
        message_new("m1", 101, "u_other", "first"),
    ] {
        apply_frame(&mut state, frame(f), &mut pending, NOW);
    }
    let ids: Vec<_> = state
        .messages("c1")
        .iter()
        .map(|m| m.message.id.as_str())
        .collect();
    assert_eq!(ids, vec!["m1", "m2"]);
}

#[test]
fn a_replayed_message_is_not_a_second_message() {
    let (mut state, mut pending) = fresh();
    let f = message_new("m1", 101, "u_other", "hi");
    apply_frame(&mut state, frame(f.clone()), &mut pending, NOW);
    let deltas = apply_frame(&mut state, frame(f), &mut pending, NOW);
    assert_eq!(state.messages("c1").len(), 1);
    assert!(deltas.is_empty(), "a duplicate must produce no delta");
}

#[test]
fn ack_promotes_the_optimistic_row_in_place() {
    let (mut state, mut pending) = fresh();
    // What `outbound` does when a send is written.
    pending.insert(
        "cm1".into(),
        PendingSend {
            client_msg_id: "cm1".into(),
            conv_id: "c1".into(),
            body: "hello".into(),
            reply_to_id: None,
            attachments: vec![],
            sent_at: NOW,
        },
    );
    state.messages.insert(
        "c1".into(),
        vec![atlas_comms::state::LocalMessage {
            message: wire::Message {
                id: optimistic_id("cm1"),
                conv_id: "c1".into(),
                seq: 9_999,
                author_id: "u_me".into(),
                body: "hello".into(),
                reply_to_id: None,
                edited_at: None,
                created_at: NOW,
                attachments: vec![],
                code_refs: vec![],
                draft_id: None,
            },
            client_msg_id: Some("cm1".into()),
            status: SendStatus::Sending,
            deleted: false,
        }],
    );

    let deltas = apply_frame(
        &mut state,
        frame(serde_json::json!({ "t": "ack", "client_msg_id": "cm1", "id": "m9", "seq": 105 })),
        &mut pending,
        NOW,
    );

    assert_eq!(state.messages("c1").len(), 1, "the ack must not add a row");
    let row = &state.messages("c1")[0];
    assert_eq!(row.message.id, "m9");
    assert_eq!(row.message.seq, 105);
    assert_eq!(row.status, SendStatus::Settled);
    assert!(pending.is_empty());
    assert_eq!(
        deltas,
        vec![StateDelta::MessageUpdated {
            conv_id: "c1".into(),
            id: "m9".into(),
            replaced_id: Some(optimistic_id("cm1")),
        }]
    );
}

#[test]
fn our_own_send_arriving_from_another_device_does_not_double() {
    // The sender's socket gets `ack`; the author's OTHER sockets get
    // `message.new`. Without the client_msg_id dedupe the message appears twice
    // on the second device.
    let (mut state, mut pending) = fresh();
    pending.insert(
        "cm1".into(),
        PendingSend {
            client_msg_id: "cm1".into(),
            conv_id: "c1".into(),
            body: "hello".into(),
            reply_to_id: None,
            attachments: vec![],
            sent_at: NOW,
        },
    );
    state.messages.insert(
        "c1".into(),
        vec![atlas_comms::state::LocalMessage {
            message: wire::Message {
                id: optimistic_id("cm1"),
                conv_id: "c1".into(),
                seq: 9_999,
                author_id: "u_me".into(),
                body: "hello".into(),
                reply_to_id: None,
                edited_at: None,
                created_at: NOW,
                attachments: vec![],
                code_refs: vec![],
                draft_id: None,
            },
            client_msg_id: Some("cm1".into()),
            status: SendStatus::Sending,
            deleted: false,
        }],
    );

    let mut f = message_new("m9", 105, "u_me", "hello");
    f["client_msg_id"] = serde_json::json!("cm1");
    apply_frame(&mut state, frame(f), &mut pending, NOW);

    assert_eq!(state.messages("c1").len(), 1);
    assert_eq!(state.messages("c1")[0].message.id, "m9");
    assert_eq!(state.messages("c1")[0].status, SendStatus::Settled);
}

#[test]
fn delete_keeps_the_row_and_empties_it() {
    let (mut state, mut pending) = fresh();
    apply_frame(
        &mut state,
        frame(message_new("m1", 101, "u_other", "regrettable")),
        &mut pending,
        NOW,
    );
    apply_frame(
        &mut state,
        frame(serde_json::json!({
            "t": "message.deleted", "seq": 102, "conv_id": "c1", "id": "m1", "deleted_at": NOW
        })),
        &mut pending,
        NOW,
    );

    // The row survives so a reply pointing at it still renders a stub.
    assert_eq!(state.messages("c1").len(), 1);
    let row = &state.messages("c1")[0];
    assert!(row.deleted);
    assert!(row.message.body.is_empty());
}

#[test]
fn deleting_a_pinned_message_clears_the_rail() {
    let (mut state, mut pending) = fresh();
    apply_frame(&mut state, frame(message_new("m1", 101, "u_o", "x")), &mut pending, NOW);
    apply_frame(
        &mut state,
        frame(serde_json::json!({
            "t": "pin.added", "seq": 102, "conv_id": "c1", "message_id": "m1",
            "pinned_by": "u_o", "at": NOW
        })),
        &mut pending,
        NOW,
    );
    assert_eq!(state.pins.get("c1").map(Vec::len), Some(1));

    apply_frame(
        &mut state,
        frame(serde_json::json!({
            "t": "message.deleted", "seq": 103, "conv_id": "c1", "id": "m1", "deleted_at": NOW
        })),
        &mut pending,
        NOW,
    );
    // A rail must never point at something that is gone.
    assert_eq!(state.pins.get("c1").map(Vec::len), Some(0));
}

#[test]
fn reactions_are_rows_and_dedupe_per_person_per_emoji() {
    let (mut state, mut pending) = fresh();
    let add = |user: &str, emoji: &str| {
        serde_json::json!({
            "t": "reaction.added", "seq": 102, "conv_id": "c1",
            "message_id": "m1", "user_id": user, "emoji": emoji
        })
    };
    apply_frame(&mut state, frame(add("u_a", "\u{1F525}")), &mut pending, NOW);
    apply_frame(&mut state, frame(add("u_b", "\u{1F525}")), &mut pending, NOW);
    // A repeat writes nothing and announces nothing.
    let deltas = apply_frame(&mut state, frame(add("u_a", "\u{1F525}")), &mut pending, NOW);
    assert!(deltas.is_empty());
    assert_eq!(state.reactions.get("m1").map(Vec::len), Some(2));

    apply_frame(
        &mut state,
        frame(serde_json::json!({
            "t": "reaction.removed", "seq": 103, "conv_id": "c1",
            "message_id": "m1", "user_id": "u_a", "emoji": "\u{1F525}"
        })),
        &mut pending,
        NOW,
    );
    assert_eq!(state.reactions.get("m1").map(Vec::len), Some(1));
}

#[test]
fn presence_is_an_assignment_not_a_delta() {
    let (mut state, mut pending) = fresh();
    apply_frame(
        &mut state,
        frame(serde_json::json!({ "t": "presence", "online": ["u_z"] })),
        &mut pending,
        NOW,
    );
    assert_eq!(state.online, vec!["u_z"], "the whole set replaces the old one");
}

#[test]
fn a_new_message_clears_that_authors_typing_hint() {
    let (mut state, mut pending) = fresh();
    apply_frame(
        &mut state,
        frame(serde_json::json!({ "t": "typing", "conv_id": "c1", "user_id": "u_other" })),
        &mut pending,
        NOW,
    );
    assert!(state.typing["c1"].contains_key("u_other"));

    apply_frame(&mut state, frame(message_new("m1", 101, "u_other", "done")), &mut pending, NOW);
    // Better than a timeout: this is exactly when the hint stopped being true.
    assert!(!state.typing["c1"].contains_key("u_other"));
}

#[test]
fn joining_moves_a_channel_from_discoverable_to_membership() {
    let (mut state, mut pending) = fresh();
    apply_frame(
        &mut state,
        frame(serde_json::json!({
            "t": "member.joined", "seq": 102, "conv_id": "c2", "user_id": "u_me"
        })),
        &mut pending,
        NOW,
    );
    assert!(state.conversations.iter().any(|c| c.id == "c2"));
    assert!(state.discoverable.is_empty());
}

#[test]
fn somebody_elses_join_moves_nothing() {
    let (mut state, mut pending) = fresh();
    apply_frame(
        &mut state,
        frame(serde_json::json!({
            "t": "member.joined", "seq": 102, "conv_id": "c2", "user_id": "u_other"
        })),
        &mut pending,
        NOW,
    );
    assert!(state.discoverable.iter().any(|c| c.id == "c2"));
    assert_eq!(state.conversations.len(), 1);
}

#[test]
fn eviction_is_distinct_from_leaving() {
    let (mut state, mut pending) = fresh();
    let deltas = apply_frame(
        &mut state,
        frame(serde_json::json!({
            "t": "member.evicted", "seq": 102, "conv_id": "c1", "user_id": "u_me"
        })),
        &mut pending,
        NOW,
    );
    assert_eq!(
        deltas,
        vec![StateDelta::MemberChanged {
            conv_id: "c1".into(),
            user_id: "u_me".into(),
            change: MemberChange::Evicted,
        }]
    );
}

#[test]
fn an_unknown_frame_is_ignored_not_an_error() {
    // The server ships ahead of us; every not-yet-built slice lands here.
    let parsed: ServerFrame = serde_json::from_value(serde_json::json!({
        "t": "call.started", "seq": 900, "call": { "id": "call_1" }
    }))
    .expect("an unknown `t` must still deserialize");
    assert_eq!(parsed, ServerFrame::Unknown);

    let (mut state, mut pending) = fresh();
    let deltas = apply_frame(&mut state, parsed, &mut pending, NOW);
    assert!(deltas.is_empty());
}

#[test]
fn only_journaled_frames_carry_a_watermark() {
    // Advancing from an ephemeral frame would skip real history on the next
    // resume — silently, and permanently.
    let ephemeral = [
        serde_json::json!({ "t": "typing", "conv_id": "c1", "user_id": "u" }),
        serde_json::json!({ "t": "presence", "online": [] }),
        serde_json::json!({
            "t": "read.updated", "conv_id": "c1", "last_read_seq": 1, "unread": 0, "mentions": 0
        }),
        serde_json::json!({ "t": "ack", "client_msg_id": "c", "id": "m", "seq": 5 }),
    ];
    for f in ephemeral {
        let parsed = frame(f);
        assert!(!wire::is_journaled(&parsed), "{parsed:?} must not advance the watermark");
        assert_eq!(wire::frame_seq(&parsed), None);
    }

    let durable = frame(message_new("m1", 101, "u", "x"));
    assert!(wire::is_journaled(&durable));
    assert_eq!(wire::frame_seq(&durable), Some(101));
}

#[test]
fn applying_a_replay_twice_is_a_no_op() {
    // Replayed frames are byte-identical to live ones, so one handler covers
    // both and the second application must change nothing.
    let sequence = vec![
        message_new("m1", 101, "u_other", "one"),
        message_new("m2", 102, "u_other", "two"),
        serde_json::json!({
            "t": "reaction.added", "seq": 103, "conv_id": "c1",
            "message_id": "m1", "user_id": "u_a", "emoji": "\u{1F525}"
        }),
        serde_json::json!({
            "t": "pin.added", "seq": 104, "conv_id": "c1", "message_id": "m2",
            "pinned_by": "u_a", "at": NOW
        }),
        serde_json::json!({
            "t": "message.edited", "seq": 105, "conv_id": "c1", "id": "m1",
            "body": "one (edited)", "edited_at": NOW
        }),
    ];

    let (mut once, mut p1) = fresh();
    for f in &sequence {
        apply_frame(&mut once, frame(f.clone()), &mut p1, NOW);
    }

    let (mut twice, mut p2) = fresh();
    for _ in 0..2 {
        for f in &sequence {
            apply_frame(&mut twice, frame(f.clone()), &mut p2, NOW);
        }
    }

    assert_eq!(once.messages("c1").len(), twice.messages("c1").len());
    assert_eq!(once.reactions.get("m1").map(Vec::len), twice.reactions.get("m1").map(Vec::len));
    assert_eq!(once.pins.get("c1"), twice.pins.get("c1"));
    assert_eq!(
        once.messages("c1")[0].message.body,
        twice.messages("c1")[0].message.body
    );
}

#[test]
fn the_reaction_allowlist_matches_the_contract() {
    assert_eq!(wire::CHAT_REACTION_EMOJI.len(), 20);
    assert!(wire::is_allowed_reaction("\u{1F44D}"));
    assert!(wire::is_allowed_reaction("\u{2764}\u{FE0F}"), "the heart carries a variation selector");
    // Drifted entries the mock UI used to offer, which the server refuses.
    assert!(!wire::is_allowed_reaction("\u{1F604}"));
    assert!(!wire::is_allowed_reaction("\u{2615}"));
}
