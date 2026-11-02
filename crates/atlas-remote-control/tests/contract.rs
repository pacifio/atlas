//! The RC wire contract, held to the server's own fixtures.
//!
//! `tests/fixtures/rc-wire-v1.json` and `tests/fixtures/rc-frames-v1.json` are
//! **copies** of `packages/contracts/fixtures/rc-wire-v1.json` and
//! `rc-frames-v1.json` in the server repo (`atlas-server`, generated from
//! `RC_WIRE_FIXTURES` / `RC_FRAME_FIXTURES` in `packages/contracts/src/rc.ts`;
//! the ingest suite holds each file equal to its in-code list). They must be
//! re-copied whenever the server's change — that is the point: the server's
//! test fails if its file and its code disagree, this one fails if the file
//! and this crate disagree, and neither side can drift without one of them
//! going red.
//!
//! What this covers is the *envelope* — the binary header and the control
//! frames. The payload inside a delta batch (`SessionDelta` with `seq`) is
//! held by `crates/atlas-agent-wire/tests/contract.rs` and
//! `tests/wire-shape-contract.test.ts`.

use atlas_remote_control::codec::{
    decode_delta_batch, decode_frame, encode_delta_batch, encode_frame, FRAME_FLAG_MORE,
    FRAME_KIND_DELTA_BATCH, FRAME_KIND_SNAPSHOT,
};
use atlas_remote_control::wire::{
    Capability, ClientRole, CommandKind, EndReason, ErrorCode, FromServer, Gate, LinkTier,
    PrincipalKind, RefusalCode, RosterRole, Surface, Tier, ToServer, WIDENING_MODE_WORDS,
};
use serde_json::Value;

const WIRE: &str = include_str!("fixtures/rc-wire-v1.json");
const FRAMES: &str = include_str!("fixtures/rc-frames-v1.json");

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex"))
        .collect()
}

#[test]
fn every_golden_frame_decodes_and_re_encodes_byte_for_byte() {
    let fixtures: Vec<Value> = serde_json::from_str(WIRE).unwrap();
    assert!(fixtures.len() >= 6, "the fixture file lost frames");
    for fixture in &fixtures {
        let name = fixture["name"].as_str().unwrap();
        let bytes = unhex(fixture["hex"].as_str().unwrap());
        let want = &fixture["frame"];
        let payload: Vec<u8> = want["payload"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b.as_u64().unwrap() as u8)
            .collect();

        let frame = decode_frame(&bytes).unwrap_or_else(|| panic!("{name}: decodes"));
        assert_eq!(
            u64::from(frame.version),
            want["version"].as_u64().unwrap(),
            "{name}"
        );
        assert_eq!(
            u64::from(frame.kind),
            want["kind"].as_u64().unwrap(),
            "{name}"
        );
        assert_eq!(
            u64::from(frame.flags),
            want["flags"].as_u64().unwrap(),
            "{name}"
        );
        assert_eq!(
            frame.seq_first,
            want["seqFirst"].as_u64().unwrap(),
            "{name}"
        );
        assert_eq!(frame.count, want["count"].as_u64().unwrap(), "{name}");
        assert_eq!(frame.payload, payload, "{name}");
        assert_eq!(frame.problem(), None, "{name}: a valid frame");

        let encoded = encode_frame(
            frame.kind,
            frame.flags,
            frame.seq_first,
            frame.count,
            &payload,
        )
        .unwrap();
        assert_eq!(
            hex(&encoded),
            fixture["hex"].as_str().unwrap(),
            "{name}: encodes"
        );

        if let Some(envelopes) = fixture.get("envelopes").and_then(Value::as_array) {
            let envelopes: Vec<&str> = envelopes.iter().map(|e| e.as_str().unwrap()).collect();
            let split = decode_delta_batch(&frame).unwrap_or_else(|| panic!("{name}: splits"));
            let split: Vec<String> = split
                .into_iter()
                .map(|e| String::from_utf8(e).unwrap())
                .collect();
            assert_eq!(split, envelopes, "{name}: envelopes");
            // Each envelope is shaped like a desktop `SessionDeltaEnvelope`
            // (flattened delta, dense seq), as the viewer's reducer reads it.
            for (i, envelope) in envelopes.iter().enumerate() {
                let parsed: Value = serde_json::from_str(envelope).unwrap();
                assert_eq!(
                    parsed["seq"],
                    frame.seq_first + i as u64,
                    "{name}: dense seqs"
                );
                assert!(
                    parsed["session_id"].is_string() && parsed["kind"].is_string(),
                    "{name}"
                );
            }
            let batch = encode_delta_batch(frame.seq_first, &envelopes).unwrap();
            assert_eq!(
                hex(&batch),
                fixture["hex"].as_str().unwrap(),
                "{name}: batch encodes"
            );
        }
    }
}

#[test]
fn the_golden_set_covers_a_single_a_batch_and_a_two_part_snapshot() {
    let fixtures: Vec<Value> = serde_json::from_str(WIRE).unwrap();
    let frames: Vec<_> = fixtures
        .iter()
        .map(|f| decode_frame(&unhex(f["hex"].as_str().unwrap())).unwrap())
        .collect();
    assert!(frames
        .iter()
        .any(|f| f.kind == FRAME_KIND_DELTA_BATCH && f.count == 1));
    assert!(frames
        .iter()
        .any(|f| f.kind == FRAME_KIND_DELTA_BATCH && f.count == 3));
    let parts: Vec<_> = frames
        .iter()
        .filter(|f| f.kind == FRAME_KIND_SNAPSHOT)
        .collect();
    assert_eq!(parts.len(), 2);
    assert_eq!(parts[0].flags & FRAME_FLAG_MORE, FRAME_FLAG_MORE);
    assert_eq!(parts[1].flags & FRAME_FLAG_MORE, 0);
    let whole: Vec<u8> = parts.iter().flat_map(|p| p.payload.clone()).collect();
    let snapshot: Value = serde_json::from_slice(&whole).expect("the parts reassemble to JSON");
    assert_eq!(snapshot["as_of_seq"], parts[0].seq_first);
}

fn frames() -> Value {
    serde_json::from_str(FRAMES).unwrap()
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect()
}

macro_rules! same_enum {
    ($fixture:expr, $ty:ty) => {{
        let ours: Vec<String> = <$ty>::ALL.iter().map(|v| v.as_str().to_string()).collect();
        assert_eq!(ours, strings(&$fixture), stringify!($ty));
        // And serde spells them the same way.
        for value in <$ty>::ALL {
            assert_eq!(
                serde_json::to_value(value).unwrap(),
                Value::from(value.as_str())
            );
        }
    }};
}

#[test]
fn every_closed_enum_matches_the_servers_list_in_order() {
    let f = frames();
    let e = &f["enums"];
    same_enum!(e["tiers"], Tier);
    same_enum!(e["linkTiers"], LinkTier);
    same_enum!(e["capabilities"], Capability);
    same_enum!(e["surfaces"], Surface);
    same_enum!(e["principalKinds"], PrincipalKind);
    same_enum!(e["clientRoles"], ClientRole);
    same_enum!(e["rosterRoles"], RosterRole);
    same_enum!(e["endReasons"], EndReason);
    same_enum!(e["gates"], Gate);
    same_enum!(e["refusals"], RefusalCode);
    same_enum!(e["errors"], ErrorCode);
    same_enum!(e["commandKinds"], CommandKind);
}

#[test]
fn the_tier_table_and_the_members_only_list_agree() {
    let f = frames();
    for kind in CommandKind::ALL {
        assert_eq!(
            f["commandMinTier"][kind.as_str()],
            Value::from(kind.min_tier().as_str()),
            "{}",
            kind.as_str()
        );
    }
    let members_only: Vec<String> = CommandKind::ALL
        .iter()
        .filter(|k| k.members_only())
        .map(|k| k.as_str().to_string())
        .collect();
    assert_eq!(members_only, strings(&f["membersOnlyCommands"]));
}

#[test]
fn the_constants_and_codes_agree() {
    use atlas_remote_control as rc;
    let f = frames();
    assert_eq!(f["protocol"], u64::from(rc::RC_PROTOCOL_VERSION));
    let c = &f["constants"];
    let pairs: &[(&str, u64)] = &[
        ("RC_SOCKETS_MAX", rc::RC_SOCKETS_MAX as u64),
        (
            "RC_SOCKETS_PER_PRINCIPAL",
            rc::RC_SOCKETS_PER_PRINCIPAL as u64,
        ),
        ("RC_DELTA_MAX_BYTES", rc::RC_DELTA_MAX_BYTES as u64),
        (
            "RC_FRAME_HEADER_MAX_BYTES",
            rc::RC_FRAME_HEADER_MAX_BYTES as u64,
        ),
        (
            "RC_SNAPSHOT_PART_MAX_BYTES",
            rc::RC_SNAPSHOT_PART_MAX_BYTES as u64,
        ),
        ("RC_SNAPSHOT_MAX_BYTES", rc::RC_SNAPSHOT_MAX_BYTES as u64),
        ("RC_HOST_PING_MS", rc::RC_HOST_PING_MS),
        ("RC_HOST_SILENT_MS", rc::RC_HOST_SILENT_MS),
        ("RC_CLIENT_PING_MS", rc::RC_CLIENT_PING_MS),
        ("RC_COALESCE_MS", rc::RC_COALESCE_MS),
        ("RC_COALESCE_BYTES", rc::RC_COALESCE_BYTES as u64),
        ("RC_COMMAND_TIMEOUT_MS", rc::RC_COMMAND_TIMEOUT_MS),
        ("RC_PROMPT_MAX", rc::RC_PROMPT_MAX as u64),
        (
            "RC_COMMAND_FRAME_MAX_BYTES",
            rc::RC_COMMAND_FRAME_MAX_BYTES as u64,
        ),
        (
            "RC_COMMAND_VALUE_MAX_BYTES",
            rc::RC_COMMAND_VALUE_MAX_BYTES as u64,
        ),
        ("RC_CONTROL_MAX_BYTES", rc::RC_CONTROL_MAX_BYTES as u64),
        ("RC_REHELLO_MAX", rc::RC_REHELLO_MAX as u64),
        ("RC_HELLO_TIMEOUT_MS", rc::RC_HELLO_TIMEOUT_MS),
        ("RC_KICK_MS", rc::RC_KICK_MS),
        (
            "RC_CONTROL_REQUEST_TIMEOUT_MS",
            rc::RC_CONTROL_REQUEST_TIMEOUT_MS,
        ),
        ("RC_CONTROL_COOLDOWN_MS", rc::RC_CONTROL_COOLDOWN_MS),
        ("RC_VIEWER_LAG_BYTES", rc::RC_VIEWER_LAG_BYTES as u64),
        ("RC_VIEWER_LAG_MS", rc::RC_VIEWER_LAG_MS),
    ];
    let mut named: Vec<&str> = pairs.iter().map(|(n, _)| *n).collect();
    // The one constant that is a list, not a number: the words that mark a
    // mode as widening, which the desktop gate refuses from every remote
    // origin and the web viewer pre-disables. Held equal, in order, so the
    // viewer never offers a row the desktop will refuse.
    named.push("RC_WIDENING_MODE_WORDS");
    let mut theirs: Vec<&str> = c.as_object().unwrap().keys().map(String::as_str).collect();
    theirs.sort_unstable();
    let mut ours = named.clone();
    ours.sort_unstable();
    assert_eq!(ours, theirs, "a constant was added or removed on one side");
    for (name, value) in pairs {
        assert_eq!(c[*name], *value, "{name}");
    }
    let ours: Vec<String> = WIDENING_MODE_WORDS
        .iter()
        .map(|w| (*w).to_string())
        .collect();
    assert_eq!(
        ours,
        strings(&c["RC_WIDENING_MODE_WORDS"]),
        "the widening-mode words differ from the server's"
    );

    let codes = &f["closeCodes"];
    use rc::close_code::*;
    assert_eq!(codes["Idle"], IDLE);
    assert_eq!(codes["Revoked"], REVOKED);
    assert_eq!(codes["TryAgainLater"], TRY_AGAIN_LATER);
    assert_eq!(codes["ProtocolUnsupported"], PROTOCOL_UNSUPPORTED);
    assert_eq!(codes["Forbidden"], FORBIDDEN);
    assert_eq!(codes["Superseded"], SUPERSEDED);
    assert_eq!(codes["RoomClosed"], ROOM_CLOSED);
    assert_eq!(codes.as_object().unwrap().len(), 7);
    assert_eq!(
        f["frameKinds"]["DeltaBatch"],
        u64::from(FRAME_KIND_DELTA_BATCH)
    );
    assert_eq!(f["frameKinds"]["Snapshot"], u64::from(FRAME_KIND_SNAPSHOT));
    assert_eq!(f["flagMore"], u64::from(FRAME_FLAG_MORE));
}

#[test]
fn every_frame_to_the_server_round_trips_through_the_serde_types() {
    let f = frames();
    let examples = f["toServer"].as_array().unwrap();
    assert!(examples.len() >= 19, "the fixture file lost frames");
    for example in examples {
        let name = example["name"].as_str().unwrap();
        let frame = &example["frame"];
        let decoded: ToServer = serde_json::from_value(frame.clone())
            .unwrap_or_else(|e| panic!("{name}: decodes: {e}"));
        let encoded = serde_json::to_value(&decoded).unwrap();
        assert_eq!(&encoded, frame, "{name}: round-trips");
    }
}

/// A frame with every `null`-valued key removed, recursively. The desktop only
/// *reads* server frames, and reads an optional field the server spells
/// `null` the same as one it omits — so the round trip compares shapes, not
/// the spelling of absence. A renamed or dropped field still fails: it is
/// absent on one side with a value on the other.
fn without_nulls(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(_, v)| !v.is_null())
                .map(|(k, v)| (k.clone(), without_nulls(v)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(without_nulls).collect()),
        other => other.clone(),
    }
}

#[test]
fn every_frame_from_the_server_round_trips_through_the_serde_types() {
    let f = frames();
    let examples = f["fromServer"].as_array().unwrap();
    assert!(examples.len() >= 23, "the fixture file lost frames");
    for example in examples {
        let name = example["name"].as_str().unwrap();
        let frame = &example["frame"];
        let decoded = FromServer::decode(&frame.to_string())
            .unwrap_or_else(|e| panic!("{name}: decodes: {e}"));
        assert_ne!(decoded, FromServer::Unknown, "{name}: a known frame");
        let encoded = serde_json::to_value(&decoded).unwrap();
        assert_eq!(
            without_nulls(&encoded),
            without_nulls(frame),
            "{name}: round-trips"
        );
    }
}

#[test]
fn the_host_welcome_reads_with_and_without_a_scope() {
    let f = frames();
    let welcome = f["fromServer"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| &e["frame"])
        .find(|frame| frame["t"] == "rc.welcome" && frame["role"] == "host")
        .expect("a host welcome in the fixture");
    // The fixture's own spelling decodes.
    let decoded = FromServer::decode(&welcome.to_string()).unwrap();
    let FromServer::Welcome(atlas_remote_control::wire::Welcome::Host(host)) = decoded else {
        panic!("a host welcome");
    };
    assert_eq!(host.org_id.as_deref(), welcome["orgId"].as_str());
    // A solo room's welcome — `orgId: null`, or the key missing — reads too.
    let mut solo = welcome.clone();
    solo["orgId"] = Value::Null;
    solo["workspaceId"] = Value::Null;
    let FromServer::Welcome(atlas_remote_control::wire::Welcome::Host(host)) =
        FromServer::decode(&solo.to_string()).unwrap()
    else {
        panic!("a host welcome");
    };
    assert_eq!(host.org_id, None);
    assert_eq!(host.workspace_id, None);
    solo.as_object_mut().unwrap().remove("orgId");
    solo.as_object_mut().unwrap().remove("workspaceId");
    assert!(matches!(
        FromServer::decode(&solo.to_string()).unwrap(),
        FromServer::Welcome(atlas_remote_control::wire::Welcome::Host(_))
    ));
}

#[test]
fn the_host_sends_its_result_with_from_id_as_the_server_requires() {
    // `fromId` is the server's deviation from the plan: commands are keyed
    // `(from, commandId)`, so a result without it is unmatched and dropped.
    let f = frames();
    let results: Vec<&Value> = f["toServer"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["frame"]["t"] == "rc.command_result")
        .map(|e| &e["frame"])
        .collect();
    assert_eq!(results.len(), 2);
    let ok = atlas_remote_control::wire::HostCommandResult::accepted(
        results[0]["commandId"].as_str().unwrap(),
        results[0]["fromId"].as_str().unwrap(),
    );
    let mut ok_json = serde_json::to_value(ToServer::CommandResult(ok)).unwrap();
    ok_json.as_object_mut().unwrap().remove("t");
    let mut want = results[0].clone();
    want.as_object_mut().unwrap().remove("t");
    assert_eq!(ok_json, want);
}
