//! Team chat against the `atlas-chat` API.
//!
//! One WebSocket per active Organisation, owned here rather than by the
//! renderer, for two independent reasons that are both hard:
//!
//! 1. **The WS ticket *is* the access JWT.** The renderer runs with no CSP and
//!    renders agent-authored markdown; a token in that heap is one injection
//!    away from exfiltration. So the renderer never holds one, which means it
//!    can neither open the socket nor make a REST call.
//! 2. **The socket is the notification transport.** The server's email digest
//!    deliberately skips anyone holding a live socket — "the app has told
//!    them". A socket that opened when a panel did would mean: panel closed,
//!    no notification, an email instead.
//!
//! The renderer is therefore a projection: it applies [`events::CommsEvent`]s
//! and invokes commands, and it decides nothing.
//!
//! Layering, innermost first:
//!
//! * [`wire`] — the frames, and the journaled/ephemeral split.
//! * [`state`] — the authoritative state and a pure reducer over it.
//! * [`store`] — the `seq` watermark and the paint-before-connect snapshot.
//! * [`events`] — what crosses the bridge.
//!
//! Nothing here depends on Tauri. The host supplies a [`TokenSource`]; that is
//! the whole seam.

pub mod conn;
pub mod spaces;
pub mod error;
pub mod events;
pub mod manager;
pub mod rest;
pub mod state;
pub mod store;
pub mod wire;

pub use error::{CommsError, Result};
pub use events::{CommsEnvelope, CommsEvent, ConnReason, ConnectionState};
pub use state::{apply_frame, ChatState, LocalMessage, PendingMap, PendingSend, SendStatus};
pub use manager::{CommsManager, ConnectionInfo, Session};
pub use rest::{ConversationPatch, DmResult, MessagePage, RestClient};
pub use store::{db_path, CommsStore, OrgSnapshot};
pub use wire::{ClientFrame, Conversation, Message, ServerFrame};

use std::future::Future;
use std::pin::Pin;

/// How the host mints an access JWT.
///
/// Minted per connection attempt and per REST call rather than cached: the
/// token lives ten minutes, and nothing here holds one long enough for that to
/// matter. The host's implementation resolves Tauri state per call, so it stays
/// correct regardless of the order things are registered in during setup.
pub trait TokenSource: Send + Sync + 'static {
    fn mint(&self) -> Pin<Box<dyn Future<Output = Result<String>> + Send + '_>>;
}

/// Which Organisation the socket should be attached to, if any.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrgTarget {
    /// The **server** org id (an Organisation's `remoteId`), which is what
    /// `?org=` and the socket both name. A local-only org has none, and has
    /// nothing to connect to.
    pub org_id: String,
}

/// Default base for the chat service. Deliberately not overridable from disk —
/// the same reasoning as `auth::config`: a file that redirects the endpoint is
/// a phishing foothold. A compile-time override exists for development.
pub const DEFAULT_CHAT_BASE: &str = "https://chat.tryatlas.cc";

pub fn chat_base() -> String {
    std::env::var("ATLAS_CHAT_URL")
        .ok()
        .or_else(|| option_env!("ATLAS_CHAT_URL").map(str::to_string))
        .unwrap_or_else(|| DEFAULT_CHAT_BASE.to_string())
        .trim_end_matches('/')
        .to_string()
}

/// `chat_base()` with the scheme rewritten for a WebSocket dial.
fn ws_base() -> String {
    let base = chat_base();
    if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        base
    }
}

/// The socket URL for an Organisation.
pub fn socket_url(org_id: &str) -> String {
    format!("{}/ws?org={org_id}", ws_base())
}

/// The Spaces socket for one conversation's realtime canvas. A second, separate
/// socket per open Space — the chat socket stays one-per-org.
pub fn spaces_socket_url(org_id: &str, conv_id: &str) -> String {
    format!("{}/spaces/ws?org={org_id}&conv={conv_id}", ws_base())
}
