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

pub use board::{CloudBoard, OrgBoard, ProjectKey, SessionKey};
pub use client::{
    ArtifactsClient, BoardQuery, CommentTarget, NewComment, BOARD_PAGE_MAX, ENTRY_PAGE_MAX,
    SEARCH_MAX_CHARS,
};
pub use error::{Error, Result};
pub use manager::{ArtifactsEvent, ArtifactsManager, ManagerConfig};
pub use model::{
    AnchorKind, ArtifactShare, Comment, CommentVotes, EntryPayload, InboxEntry, InboxKind,
    InboxPage, RemoteEntry, RemoteEntryCounts, RemoteProject, RemoteSession, RemoteToolTally,
    SessionBoardPage, SessionDetailPage,
};
pub use socket::{ticket_request, ClientFrame, ExitReason, Keepalive, ServerFrame};

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
    resolve_base(
        std::env::var("ATLAS_INGEST_URL").ok(),
        option_env!("ATLAS_INGEST_URL"),
        DEFAULT_INGEST_BASE,
    )
}

/// The override ladder — runtime, then compile-time, then the default — with
/// the environment already read. Pure so the tests never touch the process
/// environment: `set_var` from parallel test threads races every other read.
///
/// A release build takes a plaintext override (`http://`, `ws://`) only for
/// a loopback host: every bearer this crate and the sockets on its door send
/// rides on the base, and an override that points a shipped binary at a
/// remote plaintext host would send them in the clear. Such an override is
/// refused in favour of the default, and said so. A debug build is
/// permissive: the local dev server is `http://localhost:8787`, and a dev may
/// well run it on another machine on the LAN.
fn resolve_base(runtime: Option<String>, compiled: Option<&str>, default: &str) -> String {
    let base = runtime
        .or_else(|| compiled.map(str::to_string))
        .unwrap_or_else(|| default.to_string())
        .trim_end_matches('/')
        .to_string();
    checked_base(base, default, cfg!(debug_assertions))
}

/// `base`, or `default` when `base` is a plaintext override to a host that is
/// not loopback and the build is not permissive.
fn checked_base(base: String, default: &str, permissive: bool) -> String {
    if permissive || !plaintext_to_remote_host(&base) {
        return base;
    }
    tracing::error!(
        target: "atlas_artifacts",
        %base,
        "a plaintext base is accepted only for a loopback host; using the default"
    );
    default.trim_end_matches('/').to_string()
}

/// Whether `base` is `http://` or `ws://` to a host other than loopback
/// (`127.0.0.0/8`, `::1`, `localhost`).
fn plaintext_to_remote_host(base: &str) -> bool {
    let Some(rest) = base
        .strip_prefix("http://")
        .or_else(|| base.strip_prefix("ws://"))
    else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    // Past any userinfo, then without the port.
    let host = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    let host = match host.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or(""),
        None => host.split(':').next().unwrap_or(""),
    };
    let loopback = host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    !loopback
}

/// `ingest_base()` with the scheme rewritten for a WebSocket dial. Public for
/// the other sockets on the same door (`atlas-remote-control`'s host socket),
/// so every dial resolves the base through one ladder.
pub fn ws_base() -> String {
    ws_base_for(ingest_base())
}

fn ws_base_for(base: String) -> String {
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
    format!(
        "{}/ws?org={org_id}&workspace={project_id}",
        ws_base.trim_end_matches('/')
    )
}

/// Where the web app lives.
///
/// A separate host from the ingest service: `ingest.tryatlas.cc` is an API and
/// has no pages on it. Kept here rather than in the renderer for the same
/// reason every other base is — one place to change, and no endpoint a file on
/// disk can redirect.
pub const DEFAULT_WEB_BASE: &str = "https://app.tryatlas.cc";

pub fn web_base() -> String {
    resolve_base(
        std::env::var("ATLAS_WEB_URL").ok(),
        option_env!("ATLAS_WEB_URL"),
        DEFAULT_WEB_BASE,
    )
}

/// The web app's address for one Session — the link a teammate can open.
///
/// All three ids are required by the page: the Organisation scopes it, the
/// Project is what the board fans out over, and the Session is what opens. A
/// link missing any of them lands on an empty timeline rather than an error,
/// which is worse than not offering the link at all.
pub fn session_web_url(org_id: &str, project_id: &str, session_id: &str) -> String {
    session_web_url_at(&web_base(), org_id, project_id, session_id)
}

fn session_web_url_at(web_base: &str, org_id: &str, project_id: &str, session_id: &str) -> String {
    format!("{web_base}/timeline?org={org_id}&workspace={project_id}&session={session_id}")
}

/// The public address of a share slug — what a guest opens.
///
/// A short path, not the Session route: a guest has no Organisation and no
/// Project, and the slug IS the credential. Nothing else is in it, so a link
/// handed on discloses only the thing it was created to disclose.
pub fn share_web_url(slug: &str) -> String {
    share_web_url_at(&web_base(), slug)
}

fn share_web_url_at(web_base: &str, slug: &str) -> String {
    format!("{web_base}/s/{slug}")
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
        let plain = ws_base_for("http://localhost:8787".into());
        assert!(plain.starts_with("ws://"), "{plain}");
        let tls = ws_base_for("https://ingest.example.invalid".into());
        assert!(tls.starts_with("wss://"), "{tls}");
    }

    #[test]
    fn a_session_url_carries_all_three_ids_the_page_needs() {
        // The web route reads `org`, `workspace` and `session` from the query.
        // Dropping any one lands the reader on an empty board, which is a worse
        // outcome than not offering a link.
        let url = session_web_url_at(DEFAULT_WEB_BASE, "org_1", "ws_2", "ses_3");
        assert!(
            url.starts_with("https://app.tryatlas.cc/timeline?"),
            "{url}"
        );
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
        let base = resolve_base(
            Some("https://ingest.example.invalid/".into()),
            None,
            DEFAULT_INGEST_BASE,
        );
        assert_eq!(base, "https://ingest.example.invalid");
    }

    /// A release build sends its bearers over plaintext to loopback only: a
    /// remote `http://` override falls back to the default; a debug build
    /// takes it.
    #[test]
    fn a_plaintext_base_is_refused_in_release_unless_loopback() {
        let release = |base: &str| checked_base(base.into(), DEFAULT_INGEST_BASE, false);
        let debug = |base: &str| checked_base(base.into(), DEFAULT_INGEST_BASE, true);
        for ok in [
            "http://localhost:8787",
            "http://LOCALHOST",
            "http://127.0.0.1:8787",
            "http://127.0.0.2",
            "http://[::1]:8787",
            "ws://127.0.0.1:8788/",
            "http://user:pw@localhost:8787/path",
            "https://ingest.example.invalid",
            "wss://ingest.example.invalid",
        ] {
            assert_eq!(release(ok), ok, "{ok} is fine in release");
        }
        for bad in [
            "http://ingest.example.invalid",
            "http://10.0.0.5:8787",
            "ws://192.168.1.20:8788",
            "http://[2001:db8::1]:8787",
            "http://localhost.evil.invalid",
            "http://user:pw@10.0.0.5",
        ] {
            assert_eq!(
                release(bad),
                DEFAULT_INGEST_BASE,
                "{bad} must fall back in release"
            );
            assert_eq!(debug(bad), bad, "{bad} is a dev's business in debug");
        }
        // Through the ladder, so the check is not a function nobody calls.
        let base = resolve_base(
            Some("http://10.0.0.5:8787".into()),
            None,
            DEFAULT_INGEST_BASE,
        );
        if cfg!(debug_assertions) {
            assert_eq!(base, "http://10.0.0.5:8787");
        } else {
            assert_eq!(base, DEFAULT_INGEST_BASE);
        }
    }

    #[test]
    fn the_runtime_override_wins_over_the_compiled_one() {
        let base = resolve_base(
            Some("http://localhost:8787".into()),
            Some("https://compiled.example.invalid"),
            DEFAULT_INGEST_BASE,
        );
        assert_eq!(base, "http://localhost:8787");
        let base = resolve_base(None, None, DEFAULT_INGEST_BASE);
        assert_eq!(base, DEFAULT_INGEST_BASE);
    }
}
