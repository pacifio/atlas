//! Atlas account authentication (ATL-35).
//!
//! The desktop is an untrusted OAuth client: it has no cookie and no redirect
//! URI, so it connects via the **OAuth 2.0 Device Authorization Grant**
//! (RFC 8628) — show a code, let the human approve it in a real browser, poll
//! for the result. See `docs/api/atlas-auth-api.md` §7 in the server repo.
//!
//! Everything here is deliberately free of Tauri types. The whole module is
//! driven through [`AuthCore`], constructed from an auth base URL, a config
//! directory, and an HTTP client — which is what lets the tests point it at a
//! stub server on loopback with a temporary directory and exercise the real
//! client, the real poll loop, and the real file I/O. The Tauri commands in
//! `commands::auth` are thin adapters that translate and emit events.
//!
//! Every authenticated call is classified before anything acts on it — see
//! [`AuthFailure`](core::AuthFailure) for the rule and [`backoff`] for what
//! happens to the failures that told us nothing. The short version: a 401 is
//! the only thing in this module that may ever destroy a credential.
//!
//! **Token material never leaves this module.** The session token is the user's
//! whole account, and the renderer runs with no CSP while displaying
//! agent-authored markdown, so neither the session token nor the access JWT is
//! ever handed across the IPC boundary — the frontend receives [`AuthSnapshot`],
//! which carries no credentials. Nothing here logs a token or a device code.

mod avatar;
mod backoff;
mod config;
mod core;
mod store;

pub use config::auth_base;
pub use core::{
    AuthCore, CreatedOrg, GrantError, OrgInvitation, OrgMember, Validation,
};
pub use store::Role;

use serde::Serialize;

use store::{StoredIdentity, StoredOrg};

/// Who is signed in, as the frontend sees them.
///
/// Notice what is missing: the remote avatar URL. Handing it over would let one
/// `<img src>` reinstate the per-launch request to Google or GitHub that the
/// avatar cache exists to avoid, so the frontend only ever learns a local path.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountUser {
    pub id: String,
    pub name: String,
    pub email: String,
    /// Absolute path to the cached photo, or `None` — no photo set, or the
    /// fetch failed. Both render as initials; the UI draws no distinction
    /// because the user cannot act on one.
    pub avatar_path: Option<String>,
}

impl From<StoredIdentity> for AccountUser {
    fn from(id: StoredIdentity) -> Self {
        Self {
            id: id.id,
            name: id.name,
            email: id.email,
            avatar_path: id.avatar_path,
        }
    }
}

/// One organisation the account belongs to, as the frontend sees it (ATL-51).
///
/// Read-only here by design: switching and creating belong to ATL-36, which
/// owns the whole organisation data layer. This carries what is already true.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountOrg {
    pub id: String,
    pub name: String,
    /// `None` when the access token's `orgs` claim did not place the user in
    /// this organisation, or named a role this build does not know.
    pub role: Option<Role>,
}

impl From<StoredOrg> for AccountOrg {
    fn from(org: StoredOrg) -> Self {
        Self {
            id: org.id,
            name: org.name,
            role: org.role,
        }
    }
}

/// What the frontend is allowed to know about the account.
///
/// Deliberately carries no credential. There is also no "verifying" variant:
/// whether the stored session has been revalidated against the server is an
/// implementation concern, and surfacing it would put a spinner in the title
/// bar every time a laptop lid opens, which only teaches people to ignore it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum AuthSnapshot {
    /// No credential stored.
    SignedOut,
    /// A device grant is in flight and awaiting approval in the browser.
    #[serde(rename_all = "camelCase")]
    Connecting {
        /// Shown only behind the dialog's "enter the code manually" disclosure.
        /// A display string, not a secret — the `device_code` is the secret and
        /// never leaves Rust.
        user_code: String,
        /// The *plain* approval URL, for the manual fallback. The pre-filled
        /// variant stays in Rust: the browser is opened from there, so the
        /// frontend never needs it.
        verification_uri: String,
        /// ISO-8601. The dialog uses this to stop offering a dead code.
        expires_at: String,
    },
    /// A credential is held.
    #[serde(rename_all = "camelCase")]
    SignedIn {
        /// `None` only in the gap between holding a credential and the first
        /// successful profile fetch — a blip between approval and the profile
        /// call, or an upgrade from a build that stored no identity. The next
        /// successful validation fills it in. Signed-in-but-nameless is a far
        /// better outcome than discarding a valid credential over a photo.
        user: Option<AccountUser>,
        /// Every organisation the user belongs to (ATL-51).
        ///
        /// Alongside `user` rather than inside it, matching the spec's
        /// `AuthState`: the two are refreshed together but neither implies the
        /// other, and nesting would make the no-profile window lose the
        /// organisations as well.
        ///
        /// `Some([])` is "belongs to none" and gets the deliberate empty state.
        /// `None` is "not known yet" and gets no section at all — see
        /// [`StoredIdentity::orgs`] for why the two must not be collapsed.
        orgs: Option<Vec<AccountOrg>>,
        /// Which of `orgs` this device is acting for, already resolved — see
        /// [`StoredIdentity::active_org`]. `None` whenever `orgs` is empty or
        /// not yet known.
        active_org_id: Option<String>,
        /// The organisation team chat should connect to.
        ///
        /// Unlike `active_org_id` this honours an explicit desktop choice of
        /// "none" (a local-only organisation has nothing to dial) and never
        /// falls back to list order once a choice has been made — see
        /// [`crate::auth::store::PinnedOrg`]. Deliberately NOT filtered by
        /// membership: a pinned org the user was removed from lands the
        /// socket on a visible `unavailable (not a member)` that the next
        /// refresh retries, rather than silently turning chat off.
        comms_org_id: Option<String>,
    },
}

#[cfg(test)]
mod tests;
