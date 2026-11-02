//! **Universal RC, the desktop half** — remote control of a live agent
//! session from a browser, a phone or another desktop.
//!
//! One RC room per remotely-controlled session, hosted by an
//! `RcRoomDurableObject` in `atlas-ingest`. This desktop owns the room's one
//! **host socket**: it streams the session's seq-stamped `SessionDelta`
//! envelopes up, answers the room's snapshot requests, and runs the steering
//! commands the room relays down — through the same steering entry the window
//! uses, so a remote prompt is captured, transcribed and queued exactly like a
//! typed one.
//!
//! # Shape
//!
//! Tauri-free, like `atlas-artifacts` and `atlas-comms`. Three seams:
//!
//! - [`atlas_artifacts::TokenSource`] mints the bearer (reused, not restated);
//! - [`host::SessionPort`] is the session — snapshot in, commands out;
//! - [`host::StatusSink`] hears every change of the room's state.
//!
//! # Transcribed, not imported
//!
//! The wire protocol is the server's (`packages/contracts/src/rc.ts`). The
//! constants below, the frame codec ([`codec`]) and the control frames
//! ([`wire`]) are transcribed from it, and `tests/contract.rs` holds all three
//! to the server's own fixtures (`rc-wire-v1.json`, `rc-frames-v1.json`, copied
//! into `tests/fixtures/`), so neither side can drift without a test failing
//! on one of them.

pub mod batch;
pub mod codec;
pub mod gate;
pub mod host;
pub mod rest;
pub mod snapshot;
pub mod wire;

pub use gate::Refusal;
pub use host::{
    prepare, spawn, HostConfig, HostStatus, LinkState, RoomHandle, SessionPort, SnapshotDoc,
    StatusSink, Unstarted, HOST_KEEPALIVE,
};
pub use rest::{
    CreateRoomRequest, CreatedRoom, RcClient, RestError, Room, Scope, UpdateRoomRequest,
};

// ---------------------------------------------------------------------------
// Constants, transcribed from `rc.ts` (§13.1). `tests/contract.rs` compares
// each with the fixture's `constants` block.
// ---------------------------------------------------------------------------

const KIB: usize = 1024;
const MIB: usize = 1024 * KIB;

pub const RC_PROTOCOL_VERSION: u8 = 1;
/// Client sockets one room serves at once.
pub const RC_SOCKETS_MAX: usize = 64;
/// Sockets one principal may hold in a room.
pub const RC_SOCKETS_PER_PRINCIPAL: usize = 4;
/// Largest binary frame (any `count`) or snapshot part, header included.
pub const RC_DELTA_MAX_BYTES: usize = 256 * KIB;
/// The longest a frame header can be: three bytes and two 8-byte varints.
pub const RC_FRAME_HEADER_MAX_BYTES: usize = 3 + 8 + 8;
/// The most snapshot bytes one part carries, so the part fits a frame. The
/// server's (a deviation from the plan's flat 256 KiB).
pub const RC_SNAPSHOT_PART_MAX_BYTES: usize = RC_DELTA_MAX_BYTES - RC_FRAME_HEADER_MAX_BYTES;
/// Largest reassembled snapshot.
pub const RC_SNAPSHOT_MAX_BYTES: usize = MIB;
pub const RC_HOST_PING_MS: u64 = 15_000;
pub const RC_HOST_SILENT_MS: u64 = 45_000;
pub const RC_CLIENT_PING_MS: u64 = 25_000;
/// The coalescing window: 33 ms or 8 KiB, whichever first.
pub const RC_COALESCE_MS: u64 = 33;
pub const RC_COALESCE_BYTES: usize = 8 * KIB;
/// A relayed command unanswered this long is `relay_timeout` at the object.
pub const RC_COMMAND_TIMEOUT_MS: u64 = 30_000;
/// Largest `submit` prompt, UTF-8 bytes.
pub const RC_PROMPT_MAX: usize = 32 * KIB;
pub const RC_COMMAND_FRAME_MAX_BYTES: usize = RC_PROMPT_MAX + 4 * KIB;
/// Largest elicitation answer or config value, serialised.
pub const RC_COMMAND_VALUE_MAX_BYTES: usize = 8 * KIB;
/// Largest control frame other than `rc.command`.
pub const RC_CONTROL_MAX_BYTES: usize = 4 * KIB;
pub const RC_REHELLO_MAX: usize = 3;
/// A socket that has not said hello by then is closed (`1001`), on either door.
pub const RC_HELLO_TIMEOUT_MS: u64 = 10_000;
/// How long a kicked principal's redial is refused; the invite itself stands.
pub const RC_KICK_MS: u64 = 10 * 60_000;
/// A request to drive unanswered this long times out.
pub const RC_CONTROL_REQUEST_TIMEOUT_MS: u64 = 60_000;
/// After a decline or time-out, the asker waits this long before asking again.
pub const RC_CONTROL_COOLDOWN_MS: u64 = 30_000;
pub const RC_VIEWER_LAG_BYTES: usize = 2 * MIB;
pub const RC_VIEWER_LAG_MS: u64 = 10_000;

/// Close codes (`RcCloseCode`).
pub mod close_code {
    pub const IDLE: u16 = 1001;
    pub const REVOKED: u16 = 1008;
    pub const TRY_AGAIN_LATER: u16 = 1013;
    pub const PROTOCOL_UNSUPPORTED: u16 = 4400;
    pub const FORBIDDEN: u16 = 4403;
    pub const SUPERSEDED: u16 = 4409;
    pub const ROOM_CLOSED: u16 = 4410;
}

/// The web app's page for one room — the link the owner copies to watch from
/// a phone. The room is the account's, so the link names the room and nothing
/// else: no `?org=` (a solo room has none, and a viewer may not be in it). The
/// web base resolves through the artifacts crate's ladder (`ATLAS_WEB_URL`,
/// else `https://app.tryatlas.cc`).
pub fn viewer_url(room_id: &str) -> String {
    viewer_url_at(&atlas_artifacts::web_base(), room_id)
}

pub fn viewer_url_at(web_base: &str, room_id: &str) -> String {
    format!("{}/rc/rooms/{room_id}", web_base.trim_end_matches('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_viewer_link_names_the_room_and_nothing_else() {
        assert_eq!(
            viewer_url_at("http://localhost:3000/", "01ROOM"),
            "http://localhost:3000/rc/rooms/01ROOM"
        );
    }
}
