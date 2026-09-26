//! **Atlas artifacts** — the read half of the Organisation's timeline.
//!
//! The desktop already pushes: `atlas_checkpoint::sync` drains the local
//! outbox to the ingest service, blob-first, with a bisect on rejection. That
//! path is blocking, well tested, and stays exactly where it is. This crate is
//! everything in the other direction — remote Sessions, comments, and the
//! realtime socket — which needs tokio and a WebSocket, and would have dragged
//! async into a crate that is deliberately synchronous.
//!
//! # The invariant that makes a merged board possible
//!
//! `rowId` on the wire is the **local** row id. The desktop mints it, pushes it
//! verbatim, and the server uses it as its primary key. So a Session, a
//! message, a tool call and a Checkpoint keep one identity on both sides, and
//! merging the remote board with the local one is a keyed union rather than a
//! reconciliation. It is also why a comment anchor resolves against a local row
//! with no mapping table in between.
//!
//! # Shape
//!
//! Tauri-free, like `atlas-comms`, with [`TokenSource`] as the only host seam.
//! The host supplies a closure that mints an access JWT and forwards the
//! manager's broadcast onto a window event; nothing here knows what a window
//! is.
//!
//! # Scope of a socket
//!
//! One per connected Project. The server has no org-wide socket — the web board
//! polls — but `session.summary` reaches every socket on a Project, so holding
//! one per bound Project gives the board realtime as a side effect.

mod board;
mod client;
mod error;
mod manager;
mod model;
mod socket;

pub use board::{CloudBoard, OrgBoard, ProjectKey};
pub use client::{
    ArtifactsClient, BoardQuery, CommentTarget, NewComment, BOARD_PAGE_MAX, ENTRY_PAGE_MAX, SEARCH_MAX_CHARS,
};
pub use error::{Error, Result};
pub use manager::{ArtifactsEvent, ArtifactsManager, ManagerConfig};
pub use model::{
    AnchorKind, Comment, EntryPayload, InboxEntry, InboxKind, InboxPage, RemoteEntry, RemoteEntryCounts, RemoteProject,
    RemoteSession, RemoteToolTally, SessionBoardPage, SessionDetailPage,
};
pub use socket::{ClientFrame, ExitReason, Keepalive, ServerFrame};

use std::future::Future;
use std::pin::Pin;

/// How the host mints an access JWT.
///
/// Minted per call rather than cached: the token lives ten minutes and nothing
/// here holds one long enough for that to matter. The host's implementation
/// resolves its state per call, so it stays correct regardless of the order
/// things are registered in during setup.
pub trait TokenSource: Send + Sync + 'static {
    fn mint(&self) -> Pin<Box<dyn Future<Output = Result<String>> + Send + '_>>;
}

/// Default base for the ingest service.
///
/// Deliberately **not** overridable from disk, matching `atlas_checkpoint::sync`
/// and `auth::config`: a file that redirects the endpoint is a phishing
/// foothold. An environment variable and a compile-time override exist for
/// development, and both require someone who already controls the process.
pub const DEFAULT_INGEST_BASE: &str = "https://ingest.tryatlas.cc";

pub fn ingest_base() -> String {
    std::env::var("ATLAS_INGEST_URL")
        .ok()
        .or_else(|| option_env!("ATLAS_INGEST_URL").map(str::to_string))
        .unwrap_or_else(|| DEFAULT_INGEST_BASE.to_string())
        .trim_end_matches('/')
        .to_string()
}

/// `ingest_base()` with the scheme rewritten for a WebSocket dial.
fn ws_base() -> String {
    let base = ingest_base();
    if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        base
    }
}

/// The socket URL for one Project.
pub fn socket_url(org_id: &str, project_id: &str) -> String {
    socket_url_at(&ws_base(), org_id, project_id)
}

/// The same, against an explicit base — what the manager's tests dial.
pub fn socket_url_at(ws_base: &str, org_id: &str, project_id: &str) -> String {
    format!("{}/ws?org={org_id}&workspace={project_id}", ws_base.trim_end_matches('/'))
}

/// Where the web app lives.
///
/// A separate host from the ingest service: `ingest.tryatlas.cc` is an API and
/// has no pages on it. Kept here rather than in the renderer for the same
/// reason every other base is — one place to change, and no endpoint a file on
/// disk can redirect.
pub const DEFAULT_WEB_BASE: &str = "https://app.tryatlas.cc";

pub fn web_base() -> String {
    std::env::var("ATLAS_WEB_URL")
        .ok()
        .or_else(|| option_env!("ATLAS_WEB_URL").map(str::to_string))
        .unwrap_or_else(|| DEFAULT_WEB_BASE.to_string())
        .trim_end_matches('/')
        .to_string()
}

/// The web app's address for one Session — the link a teammate can open.
///
/// All three ids are required by the page: the Organisation scopes it, the
/// Project is what the board fans out over, and the Session is what opens. A
/// link missing any of them lands on an empty timeline rather than an error,
/// which is worse than not offering the link at all.
pub fn session_web_url(org_id: &str, project_id: &str, session_id: &str) -> String {
    format!(
        "{}/timeline?org={org_id}&workspace={project_id}&session={session_id}",
        web_base()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_socket_url_names_both_the_org_and_the_project() {
        // Both are required at the door: a missing `org` is a 400 and so is a
        // missing `workspace`. There is no org-wide socket to fall back to.
        let url = socket_url("org_1", "ws_2");
        assert!(url.contains("org=org_1"), "{url}");
        assert!(url.contains("workspace=ws_2"), "{url}");
    }

    #[test]
    fn the_websocket_scheme_follows_the_http_one() {
        // A dev pointing at a plaintext local ingest must not get `wss://`,
        // and production must never get `ws://`.
        std::env::set_var("ATLAS_INGEST_URL", "http://localhost:8787");
        assert!(ws_base().starts_with("ws://"), "{}", ws_base());
        std::env::set_var("ATLAS_INGEST_URL", "https://ingest.example.invalid");
        assert!(ws_base().starts_with("wss://"), "{}", ws_base());
        std::env::remove_var("ATLAS_INGEST_URL");
    }

    #[test]
    fn a_session_url_carries_all_three_ids_the_page_needs() {
        // The web route reads `org`, `workspace` and `session` from the query.
        // Dropping any one lands the reader on an empty board, which is a worse
        // outcome than not offering a link.
        let url = session_web_url("org_1", "ws_2", "ses_3");
        assert!(url.starts_with("https://app.tryatlas.cc/timeline?"), "{url}");
        assert!(url.contains("org=org_1"), "{url}");
        assert!(url.contains("workspace=ws_2"), "{url}");
        assert!(url.contains("session=ses_3"), "{url}");
    }

    #[test]
    fn the_web_base_is_not_the_ingest_base() {
        // Two different hosts. Pointing a share link at the API would produce a
        // URL that 404s for everyone it is sent to.
        assert_ne!(DEFAULT_WEB_BASE, DEFAULT_INGEST_BASE);
    }

    #[test]
    fn a_trailing_slash_does_not_double_up_in_a_path() {
        std::env::set_var("ATLAS_INGEST_URL", "https://ingest.example.invalid/");
        assert_eq!(ingest_base(), "https://ingest.example.invalid");
        std::env::remove_var("ATLAS_INGEST_URL");
    }
}
