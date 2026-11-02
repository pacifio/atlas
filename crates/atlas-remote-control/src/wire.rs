//! The JSON control frames of wire protocol v1, both directions, and the closed
//! enums both sides share — transcribed from `packages/contracts/src/rc.ts`
//! (the Zod schemas), never imported. `tests/contract.rs` round-trips every
//! example in the server's `rc-frames-v1.json` through these types and holds
//! every enum here equal to the server's list, so a field renamed on one side
//! fails a test on one of them.
//!
//! Decoding is tolerant where it can be: an unknown frame `t` from the server
//! decodes to [`FromServer::Unknown`] rather than an error, because the server
//! ships ahead of the desktop. Unknown *fields* are ignored for the same
//! reason (the server's schemas are `.strict()`; these are deliberately not).

use serde::{Deserialize, Serialize};

/// A closed string enum with its wire spelling and the whole list, so the
/// contract test can compare the list with the server's.
macro_rules! wire_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident => $wire:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum $name {
            $(#[serde(rename = $wire)] $variant),+
        }

        impl $name {
            /// Every value, in the server's order.
            pub const ALL: &'static [$name] = &[$($name::$variant),+];

            pub fn as_str(self) -> &'static str {
                match self { $($name::$variant => $wire),+ }
            }
        }
    };
}

/// Words that mark a session mode as one that widens what the agent may do
/// without asking (`RC_WIDENING_MODE_WORDS`): matched on the mode id,
/// case-insensitively. Never settable from a remote surface, the owner
/// included — a phone left unlocked must not be able to un-sandbox the
/// machine; the desktop's own picker is the only way to such a mode. The
/// server's web viewer pre-disables the same rows from the same list, and
/// `tests/contract.rs` holds the two equal. The one list on this side:
/// `gate::mode_widens` reads it from here.
///
/// Known gap, documented in `gate.rs`'s tests: an id with none of these words
/// (Codex's `acceptAll`, say) passes. A denylist on the id can only catch the
/// words it names; the agent's own mode description is not consulted.
pub const WIDENING_MODE_WORDS: &[&str] = &[
    "bypass",
    "full",
    "yolo",
    "danger",
    "unrestricted",
    "auto",
    "trust",
    "skip",
    "unsafe",
    "always",
];

wire_enum!(
    /// What a principal may do in a room (`RC_TIERS`).
    Tier { View => "view", Steer => "steer", SteerApprove => "steer_approve" }
);

wire_enum!(
    /// The tiers an RC link may carry (`RC_LINK_TIERS`).
    LinkTier { View => "view", Steer => "steer" }
);

wire_enum!(
    /// What the host desktop says it will honour (`RC_CAPABILITIES`).
    Capability {
        Steer => "steer",
        Approve => "approve",
        Mode => "mode",
        Model => "model",
        Config => "config",
    }
);

wire_enum!(
    /// Where a client socket is drawn (`RC_SURFACES`).
    Surface { Web => "web", Mobile => "mobile", Desktop => "desktop" }
);

wire_enum!(
    /// What a principal is (`RC_PRINCIPAL_KINDS`).
    PrincipalKind { User => "user", Guest => "guest", Link => "link" }
);

wire_enum!(
    /// A client socket's standing (`RC_CLIENT_ROLES`).
    ClientRole { Owner => "owner", Member => "member", Link => "link" }
);

wire_enum!(
    /// A peer's place in the roster (`RC_ROSTER_ROLES`).
    RosterRole { Owner => "owner", Driver => "driver", Visitor => "visitor" }
);

wire_enum!(
    /// Why a room ended (`RC_END_REASONS`).
    EndReason {
        ClosedByOwner => "closed_by_owner",
        ClosedByAdmin => "closed_by_admin",
        OwnerTimeout => "owner_timeout",
        NeverHosted => "never_hosted",
        Erased => "erased",
        Retention => "retention",
    }
);

wire_enum!(
    /// Every gate a steering command can be refused at (`RC_GATES`). A
    /// desktop refusal names one; a client branches on it, never on the text.
    Gate {
        PlatformFlag => "platform_flag",
        OrgSetting => "org_setting",
        OrgPolicy => "org_policy",
        RoomClosed => "room_closed",
        OwnerOffline => "owner_offline",
        LinkRevoked => "link_revoked",
        LinkExpired => "link_expired",
        MemberRemoved => "member_removed",
        Tier => "tier",
        NotDriver => "not_driver",
        EpochStale => "epoch_stale",
        RateLimited => "rate_limited",
        OwnerOnly => "owner_only",
        OptionStanding => "option_standing",
        Widening => "widening",
        InFlight => "in_flight",
        NotPending => "not_pending",
    }
);

wire_enum!(
    /// Why the object refused one frame (`RC_REFUSAL_CODES`).
    RefusalCode {
        HelloRequired => "hello_required",
        AlreadyHello => "already_hello",
        BadFrame => "bad_frame",
        PayloadTooLarge => "payload_too_large",
        NotHost => "not_host",
        RoomFull => "room_full",
        SeqRegressed => "seq_regressed",
        SnapshotRequired => "snapshot_required",
        SnapshotUnavailable => "snapshot_unavailable",
        Tier => "tier",
        NotDriver => "not_driver",
        EpochStale => "epoch_stale",
        OwnerOffline => "owner_offline",
        IdentityRequired => "identity_required",
        LinkExpired => "link_expired",
        Cooldown => "cooldown",
        RateLimited => "rate_limited",
        RequestUnknown => "request_unknown",
        RequestClosed => "request_closed",
        NotAccepting => "not_accepting",
        RoomClosed => "room_closed",
        CommandUnknown => "command_unknown",
        RelayTimeout => "relay_timeout",
    }
);

wire_enum!(
    /// Protocol-level failures (`RC_ERROR_CODES`); a close always follows.
    ErrorCode { ProtocolUnsupported => "protocol_unsupported" }
);

wire_enum!(
    /// The command kinds (`RC_COMMAND_KINDS`).
    CommandKind {
        Submit => "submit",
        Stop => "stop",
        AnswerPermission => "answer_permission",
        AnswerElicitation => "answer_elicitation",
        SetMode => "set_mode",
        SetModel => "set_model",
        SetConfigOption => "set_config_option",
    }
);

wire_enum!(
    /// Why the object wants a snapshot from the host.
    SnapshotReason { Joiner => "joiner", Gap => "gap", Stale => "stale", Checkpoint => "checkpoint" }
);

wire_enum!(
    /// What the object answers a host's hello with.
    Wants { Snapshot => "snapshot", Nothing => "nothing" }
);

wire_enum!(
    /// Why a client is told to resync.
    ClientResyncReason { Host => "host", Ahead => "ahead", Lagging => "lagging" }
);

wire_enum!(
    /// A control request's state.
    ControlRequestStatus {
        Pending => "pending",
        Approved => "approved",
        Declined => "declined",
        TimedOut => "timed_out",
    }
);

wire_enum!(
    /// A guest's own standing, in the guest roster.
    GuestYou { Visitor => "visitor", Driver => "driver" }
);

impl CommandKind {
    /// The capability a host must have advertised to honour this kind.
    pub fn capability(self) -> Capability {
        match self {
            Self::Submit | Self::Stop => Capability::Steer,
            Self::AnswerPermission | Self::AnswerElicitation => Capability::Approve,
            Self::SetMode => Capability::Mode,
            Self::SetModel => Capability::Model,
            Self::SetConfigOption => Capability::Config,
        }
    }

    /// The least tier the relay requires (`RC_COMMAND_MIN_TIER`).
    pub fn min_tier(self) -> Tier {
        match self {
            Self::AnswerPermission | Self::AnswerElicitation => Tier::SteerApprove,
            _ => Tier::Steer,
        }
    }

    /// Only a signed-in member may send it (`RC_MEMBERS_ONLY_COMMANDS`).
    pub fn members_only(self) -> bool {
        matches!(self, Self::SetConfigOption)
    }
}

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/// Who did something, or is somewhere, in a room. `name` is a display name and
/// nothing more — never an authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrincipalRef {
    pub id: String,
    pub kind: PrincipalKind,
    pub name: Option<String>,
}

/// The driver, as the full roster names it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DriverRef {
    pub id: String,
    pub kind: PrincipalKind,
    pub name: Option<String>,
    /// The seat is waiting out a driver's reconnect.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lost: Option<bool>,
}

/// The driver, as a link visitor is told: no id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GuestDriverRef {
    pub kind: PrincipalKind,
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lost: Option<bool>,
}

/// One connected client socket. The host socket is never a peer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub peer_id: String,
    pub id: String,
    pub kind: PrincipalKind,
    pub name: Option<String>,
    pub surface: Surface,
    pub role: RosterRole,
    pub tier: Tier,
    pub since: u64,
}

/// A control request (§9.2). Arbitration is a later slice; the host only has
/// to read one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlRequest {
    pub request_id: String,
    pub from: PrincipalRef,
    pub status: ControlRequestStatus,
    pub requested_at: u64,
    pub expires_at: u64,
    pub answered_at: Option<u64>,
    pub reason: Option<String>,
}

/// One steering command (§7.7). The object looks at `kind` and size only.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Command {
    Submit {
        content: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        client_message_id: Option<String>,
    },
    Stop,
    AnswerPermission {
        request_id: String,
        option_id: String,
    },
    AnswerElicitation {
        request_id: String,
        answer: serde_json::Value,
    },
    SetMode {
        mode_id: String,
    },
    SetModel {
        model_id: String,
    },
    SetConfigOption {
        key: String,
        value: serde_json::Value,
    },
}

impl Command {
    pub fn kind(&self) -> CommandKind {
        match self {
            Self::Submit { .. } => CommandKind::Submit,
            Self::Stop => CommandKind::Stop,
            Self::AnswerPermission { .. } => CommandKind::AnswerPermission,
            Self::AnswerElicitation { .. } => CommandKind::AnswerElicitation,
            Self::SetMode { .. } => CommandKind::SetMode,
            Self::SetModel { .. } => CommandKind::SetModel,
            Self::SetConfigOption { .. } => CommandKind::SetConfigOption,
        }
    }
}

// ---------------------------------------------------------------------------
// To the server
// ---------------------------------------------------------------------------

/// The host's first frame. `host_secret` is the 64-hex secret the create door
/// returned once — compared against the stored hash and discarded by the
/// object, and never logged here.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostHello {
    pub protocol: u8,
    pub client_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_secret: Option<String>,
    /// The session's current seq, as far as the room has been told; `0`
    /// before its first delta.
    #[serde(rename = "as_of_seq")]
    pub as_of_seq: u64,
    pub capabilities: Vec<Capability>,
    pub agent: String,
    pub model: Option<String>,
}

/// Hand-written so the secret can never reach a log line by `{:?}`.
impl std::fmt::Debug for HostHello {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostHello")
            .field("protocol", &self.protocol)
            .field("client_id", &self.client_id)
            .field(
                "host_secret",
                &self.host_secret.as_ref().map(|_| "<redacted>"),
            )
            .field("as_of_seq", &self.as_of_seq)
            .field("capabilities", &self.capabilities)
            .field("agent", &self.agent)
            .field("model", &self.model)
            .finish()
    }
}

/// A client's first frame. The desktop never sends one (it hosts); typed so
/// the fixture round-trips.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientHello {
    pub protocol: u8,
    pub client_id: String,
    pub since: u64,
    pub surface: Surface,
}

/// `rc.hello`, discriminated on `role`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "snake_case")]
pub enum Hello {
    Host(HostHello),
    Client(ClientHello),
}

/// A client's steering command. No `from`: the object stamps who sent it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientCommand {
    pub command_id: String,
    pub driver_epoch: u64,
    pub command: Command,
}

/// The host's answer to one relayed command. `from_id` echoes the relayed
/// command's `from.id` — commands are keyed `(from, commandId)` server-side
/// (a server deviation from the plan, which had no `fromId`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostCommandResult {
    pub command_id: String,
    pub from_id: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refused_by: Option<RefusedBy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gate: Option<Gate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Longest `message` the object accepts on a host refusal.
pub const HOST_RESULT_MESSAGE_MAX: usize = 500;
/// Longest `code` on a refusal.
pub const RESULT_CODE_MAX: usize = 64;

impl HostCommandResult {
    pub fn accepted(command_id: &str, from_id: &str) -> Self {
        Self {
            command_id: command_id.to_owned(),
            from_id: from_id.to_owned(),
            ok: true,
            refused_by: None,
            gate: None,
            code: None,
            message: None,
        }
    }

    /// A desktop refusal. `code` and `message` are cut to what the object's
    /// schema accepts, so an over-long agent error is never the reason a
    /// result is dropped.
    pub fn refused(command_id: &str, from_id: &str, gate: Gate, code: &str, message: &str) -> Self {
        let code = if code.is_empty() { gate.as_str() } else { code };
        Self {
            command_id: command_id.to_owned(),
            from_id: from_id.to_owned(),
            ok: false,
            refused_by: Some(RefusedBy::Desktop),
            gate: Some(gate),
            code: Some(cut(code, RESULT_CODE_MAX)),
            message: Some(cut(message, HOST_RESULT_MESSAGE_MAX)),
        }
    }
}

fn cut(text: &str, max_chars: usize) -> String {
    text.chars().take(max_chars).collect()
}

/// Which side refused a command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RefusedBy {
    Relay,
    Desktop,
}

/// Every control frame a socket may send the object.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t")]
pub enum ToServer {
    #[serde(rename = "rc.hello")]
    Hello(Hello),
    #[serde(rename = "rc.ack")]
    Ack { seq: u64 },
    /// From the host: everything at or below `as_of_seq` is stale; a snapshot
    /// follows.
    #[serde(rename = "rc.resync")]
    Resync { as_of_seq: u64 },
    #[serde(rename = "rc.command")]
    Command(ClientCommand),
    #[serde(rename = "rc.command_result")]
    CommandResult(HostCommandResult),
    #[serde(rename = "rc.request_control")]
    RequestControl,
    #[serde(rename = "rc.control_answer")]
    ControlAnswer {
        #[serde(rename = "requestId")]
        request_id: String,
        approve: bool,
    },
    #[serde(rename = "rc.release_control")]
    ReleaseControl,
    #[serde(rename = "rc.kick")]
    Kick { target: String },
    #[serde(rename = "rc.take_over")]
    TakeOver,
    /// Owner: hand the seat to a connected principal without a request.
    #[serde(rename = "rc.grant_control")]
    GrantControl { target: String },
    #[serde(rename = "rc.close")]
    Close,
}

// ---------------------------------------------------------------------------
// From the server
// ---------------------------------------------------------------------------

/// The answer to a host's hello.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostWelcome {
    pub protocol: u8,
    pub room_id: String,
    /// The room's scope, when it has one; `None` for a solo room. Read with a
    /// default so a server that sends neither key is still a welcome.
    #[serde(default)]
    pub org_id: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// The newest seq the room holds; `0` when none.
    pub head: u64,
    pub driver_epoch: u64,
    pub driver: PrincipalRef,
    pub snapshot_as_of: Option<u64>,
    pub wants: Wants,
}

/// The answer to a client's hello.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientWelcome {
    pub protocol: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub room_id: Option<String>,
    pub principal: PrincipalRef,
    pub tier: Tier,
    pub driver_epoch: u64,
    pub driver: PrincipalRef,
    pub owner_online: bool,
    pub head: u64,
    pub tail_floor: u64,
    pub pending: Vec<ControlRequest>,
}

/// `rc.welcome`, discriminated on `role` — `host` for this desktop, a client
/// role otherwise.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "snake_case")]
pub enum Welcome {
    Host(HostWelcome),
    Owner(ClientWelcome),
    Member(ClientWelcome),
    Link(ClientWelcome),
}

/// The whole roster, as members, the owner and the host get it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RosterFull {
    pub driver_epoch: u64,
    pub owner_online: bool,
    /// The tier every invited member connects under. On the roster so a
    /// change made on any surface reaches this desktop on the same frame that
    /// re-badges the members; absent from a room server that predates it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member_tier: Option<Tier>,
    pub driver: DriverRef,
    pub peers: Vec<Peer>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RosterCounts {
    pub members: u64,
    pub visitors: u64,
}

/// What a link visitor is told.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RosterGuest {
    pub driver_epoch: u64,
    pub owner_online: bool,
    pub driver: GuestDriverRef,
    pub you: GuestYou,
    pub counts: RosterCounts,
}

/// `rc.roster`, discriminated on `scope`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "scope", rename_all = "snake_case")]
pub enum Roster {
    Full(RosterFull),
    Guest(RosterGuest),
}

/// To the host: a command that passed every relay gate. `from` is the
/// object's, never the sender's.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostCommand {
    pub command_id: String,
    pub driver_epoch: u64,
    pub from: PrincipalRef,
    pub command: Command,
}

/// To a command's sender.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientCommandResult {
    pub command_id: String,
    /// `null` with `status: "pending"` answers a resend still in flight.
    pub ok: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refused_by: Option<RefusedBy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gate: Option<Gate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// With gate `not_driver` to the owner: the seat is theirs to take back.
    #[serde(rename = "takeOver", default, skip_serializing_if = "Option::is_none")]
    pub take_over: Option<bool>,
}

/// Every control frame the object sends, to a host or a client.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t")]
pub enum FromServer {
    #[serde(rename = "rc.welcome")]
    Welcome(Welcome),
    #[serde(rename = "rc.roster")]
    Roster(Roster),
    #[serde(rename = "rc.synced")]
    Synced { head: u64 },
    #[serde(rename = "rc.owner")]
    Owner {
        online: bool,
        #[serde(
            rename = "graceEndsAt",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        grace_ends_at: Option<u64>,
    },
    #[serde(rename = "rc.control_request")]
    ControlRequest { request: ControlRequest },
    #[serde(rename = "rc.command")]
    Command(HostCommand),
    #[serde(rename = "rc.command_result")]
    CommandResult(ClientCommandResult),
    #[serde(rename = "rc.snapshot_request")]
    SnapshotRequest { reason: SnapshotReason },
    /// To a client only; the host never receives one.
    #[serde(rename = "rc.resync")]
    Resync {
        as_of_seq: u64,
        reason: ClientResyncReason,
    },
    #[serde(rename = "rc.closed")]
    Closed { reason: EndReason },
    #[serde(rename = "rc.refused")]
    Refused {
        #[serde(rename = "ref", default, skip_serializing_if = "Option::is_none")]
        reference: Option<String>,
        code: RefusalCode,
        message: String,
        #[serde(rename = "retryAt", default, skip_serializing_if = "Option::is_none")]
        retry_at: Option<u64>,
    },
    #[serde(rename = "rc.error")]
    Error { code: ErrorCode, message: String },
    /// A frame this build does not know. The server ships ahead of the
    /// desktop; a new `t` must not take the socket down.
    #[serde(other, skip_serializing)]
    Unknown,
}

impl FromServer {
    /// Decode a text frame. A frame that names a known `t` but does not parse
    /// (an enum value this build has no variant for) is an error the caller
    /// logs and skips — never one that ends the socket.
    pub fn decode(text: &str) -> Result<Self, String> {
        serde_json::from_str(text).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unknown_frame_type_decodes_rather_than_failing() {
        let frame = FromServer::decode(r#"{"t":"rc.something_new","x":1}"#).unwrap();
        assert_eq!(frame, FromServer::Unknown);
    }

    #[test]
    fn a_hello_never_prints_its_secret() {
        let hello = HostHello {
            protocol: 1,
            client_id: "desk-0000".into(),
            host_secret: Some("ab".repeat(32)),
            as_of_seq: 0,
            capabilities: vec![],
            agent: "atlas-agent".into(),
            model: None,
        };
        let printed = format!("{hello:?}");
        assert!(!printed.contains(&"ab".repeat(32)), "{printed}");
    }

    #[test]
    fn a_refusal_is_cut_to_what_the_object_accepts() {
        let long = "x".repeat(2000);
        let result = HostCommandResult::refused("c", "u", Gate::InFlight, &long, &long);
        assert_eq!(
            result.message.unwrap().chars().count(),
            HOST_RESULT_MESSAGE_MAX
        );
        assert_eq!(result.code.unwrap().chars().count(), RESULT_CODE_MAX);
    }
}
