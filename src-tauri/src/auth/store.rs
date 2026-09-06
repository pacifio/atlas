//! On-disk credential storage.
//!
//! The session token lives in `atlas-session.json` in the app's private config
//! directory, mode `0600`, in **its own file**
//! so that signing out is a single unlink.
//!
//! ## Why not the OS keychain
//!
//! `atlas-auth-api.md` §12.5 says to put this in the keychain. We knowingly do
//! not, for the same reason `commands::byok` does not: on macOS an unsigned,
//! frequently-rebuilt binary prompts for keychain permission on *every* access.
//! `tauri.conf.json` sets no signing identity, and the auto-updater replaces the
//! binary on every release — which invalidates the keychain ACL and would
//! re-prompt every user after every update. Keychain is therefore *worse* in
//! release than in development here.
//!
//! To be precise about the failure, because it is not the obvious one: the
//! keychain item is never lost and stays readable. A keychain ACL binds to the
//! *code signature*, so with no signing identity it pins to that exact binary;
//! after an update macOS sees a different application asking for another app's
//! secret. What dies is the **silent** read — every user gets a login-password
//! dialog after every release. Training users to expect that dialog is itself a
//! hazard in an auth flow.
//!
//! Revisit once a real Developer ID signing identity is configured; that also
//! fixes the auto-update ACL problem, and makes the keychain strictly better.
//!
//! **Ratified as a recorded exception (#41, 2026-08-28)** rather than left as a
//! silent deviation: the port spec's D14 carries the decision, and the ticket's
//! "no credential outside secure storage" criterion was reworded to match. The
//! cited §12.5 is in `atlas-auth-api.md`, which is **not in this repo** — the
//! in-repo `docs/reference/atlas-ai-api.md` is the AI gateway doc and its §12
//! ends at 12.3, so this citation cannot be followed here.
//!
//! The access JWT is never written here — it is minted on demand and held in
//! memory only.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// File name inside the app config directory.
const SESSION_FILE: &str = "atlas-session.json";

/// A role in an organisation (API doc §6), highest privilege first.
///
/// A closed set rather than a `String` because it reaches the UI as a label: an
/// unrecognised value has no label to render, and the server's own contract
/// (`packages/contracts`) defines exactly these four. Anything else is dropped
/// at the boundary by [`Role::from_claim`] rather than carried inward.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Admin,
    ProductOwner,
    Developer,
    Member,
}

impl Role {
    /// Read one value of the access token's `orgs` claim.
    ///
    /// `None` for anything unrecognised — a role added server-side after this
    /// build shipped. The organisation is still listed, just without a role:
    /// omitting a name we know is worse than omitting a label we do not.
    ///
    /// Routed through the `serde` attribute above rather than a second
    /// hand-written table of the same four strings. That attribute already
    /// decides how a role is spelled on disk, and a table that drifted from it
    /// would read back a role this file had just written.
    pub(crate) fn from_claim(raw: &str) -> Option<Self> {
        serde_json::from_value(serde_json::Value::String(raw.to_string())).ok()
    }
}

/// One organisation the user belongs to, as of the last successful refresh.
///
/// Assembled from two sources because neither is sufficient alone: the name
/// comes from `/organization/list`, the role from the access token's `orgs`
/// claim, which carries `{ organisationId: role }` and no names at all.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredOrg {
    pub id: String,
    pub name: String,
    /// `None` when the claim did not mention this organisation, or named a role
    /// this build does not know. Membership can change between the mint and the
    /// list, and the two calls are not atomic with respect to each other.
    #[serde(default)]
    pub role: Option<Role>,
}

/// Who the credential belongs to, as of the last successful profile fetch.
///
/// This is what makes an offline launch render a *complete* signed-in state —
/// a face, a name, and the organisation this device is acting for — rather than
/// a half-populated one. Refreshed on every successful validation, so a name,
/// photo, or role changed on the web reaches the desktop on the next launch.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredIdentity {
    pub id: String,
    pub name: String,
    pub email: String,
    /// The remote photo URL last seen on the profile. Kept **only** to decide
    /// whether the cache is stale: a URL that still matches means the bytes on
    /// disk are still the right bytes, so a launch costs no request to Google
    /// or GitHub. It is never handed to the frontend — that would put the
    /// per-launch request back, one `<img src>` away.
    pub avatar_url: Option<String>,
    /// Absolute path to the cached photo. `None` when the user has no photo or
    /// the fetch failed; the UI falls back to initials either way.
    pub avatar_path: Option<String>,
    /// Every organisation the user belongs to.
    ///
    /// Three states, and the menu renders each differently, so collapsing any
    /// two would make it state something untrue:
    ///
    /// - `Some(non-empty)` — known, and rendered.
    /// - `Some([])` — **known to be none.** A real answer about a real user,
    ///   and the one the deliberate empty state is for.
    /// - `None` — **not known yet.** A credential file written before this
    ///   field existed (`#[serde(default)]`, so an ATL-47 build's file still
    ///   loads instead of signing the user out), or one whose every list call
    ///   has failed. Offline, that state can last indefinitely — so telling
    ///   such a user they belong to no organisation would be a lie with no
    ///   expiry. The section is omitted instead, exactly as the identity header
    ///   is omitted when there is no profile yet.
    #[serde(default)]
    pub orgs: Option<Vec<StoredOrg>>,
    /// The organisation the user last made active — **on the web**, or, since
    /// #73, from the desktop's own org switcher (`AuthCore::set_active_org`).
    /// The desktop write is local-only; `/organization/set-active` stays
    /// ATL-36's. This stopped being read-only the moment the field became the
    /// org every gateway request bills.
    ///
    /// Kept separate from "which one to display" — see [`Self::active_org`],
    /// which resolves that and has to cope with this being `None`, the common
    /// case for a device-granted session.
    #[serde(default)]
    pub active_org_id: Option<String>,
}

impl StoredIdentity {
    /// Which organisation the desktop is acting for.
    ///
    /// Prefers the one the user made active **on the web**, and falls back to
    /// the first they belong to. The fallback is not a nicety:
    /// `/organization/set-active` is the only thing that sets the stored value,
    /// the desktop never calls it (ATL-36 owns switching), and a device-granted
    /// session starts with it unset — so without the fallback almost every
    /// desktop user would see an empty section while plainly belonging to an
    /// organisation. The web dashboard defaults the same way, so the two
    /// surfaces agree.
    ///
    /// A stored id that is no longer in the list — membership removed on the
    /// web — falls through to the fallback rather than resolving to nothing.
    pub(crate) fn active_org(&self) -> Option<String> {
        let orgs = self.orgs.as_ref()?;
        self.active_org_id
            .as_ref()
            .filter(|id| orgs.iter().any(|org| &org.id == *id))
            .cloned()
            .or_else(|| orgs.first().map(|org| org.id.clone()))
    }

    /// The role last known for one organisation, if any.
    ///
    /// The fallback for a refresh that could not read the `orgs` claim: a
    /// label we already have beats one we just failed to fetch.
    pub(crate) fn role_of(&self, id: &str) -> Option<Role> {
        self.orgs
            .as_ref()?
            .iter()
            .find(|org| org.id == id)
            .and_then(|org| org.role)
    }
}

/// The desktop's explicit organisation choice, recorded even when the choice
/// is "a local-only org" — `org_id: None`.
///
/// Distinct from [`StoredIdentity::active_org_id`] because that field cannot
/// say "chose none": `None` there means *never chose*, and [`StoredIdentity::
/// active_org`] resolves it to the first membership. That is right for billing
/// and display, and wrong for the chat socket — a user on a local-only org
/// has nothing to dial, and a socket pointed at "whichever org the server
/// listed first" was the seed of the org-switch failures. A refresh honours a
/// pin over the web's seed, so an explicit choice survives revalidation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PinnedOrg {
    pub org_id: Option<String>,
}

/// The persisted credential, plus who it belongs to.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredSession {
    /// Better Auth session token. The long-lived credential — 7-day rolling,
    /// and able to mint access tokens for every organisation the user is in.
    pub session_token: String,
    /// ISO-8601, for diagnostics only. Expiry is the server's business.
    pub saved_at: String,
    /// Absent until the first profile fetch succeeds. That window is real: a
    /// connectivity blip between approval and the profile call leaves a valid
    /// credential with nobody's name attached, and losing the credential over
    /// that would be far worse than showing a generic icon until the next
    /// launch refreshes it.
    #[serde(default)]
    pub identity: Option<StoredIdentity>,
    /// The desktop's explicit organisation choice, if one has been made this
    /// session. Session-level rather than inside `identity` so a switch can
    /// pin before the first profile fetch lands (the boot-reconciliation
    /// window), and so `refresh_identity`'s `..current` carries it for free.
    /// A fresh grant writes `None`: a new grant may be a different person.
    #[serde(default)]
    pub pinned_org: Option<PinnedOrg>,
}

pub(crate) fn session_path(dir: &Path) -> PathBuf {
    dir.join(SESSION_FILE)
}

/// Read the stored credential. `None` when absent or unreadable — a corrupt
/// file is treated as "signed out" rather than an error, since the recovery is
/// the same either way and there is nothing useful to tell the user.
pub(crate) fn load(dir: &Path) -> Option<StoredSession> {
    let raw = fs::read_to_string(session_path(dir)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Write the credential, owner-only FROM THE FIRST BYTE.
///
/// The old order — `fs::write` then chmod — left two gaps: the file existed
/// at umask permissions for the window between the two calls, and rewriting
/// a pre-existing file never resets its mode at all. Creating the temp file
/// with 0600 in `OpenOptions` and renaming it into place closes both, and
/// the rename keeps the update atomic.
pub(crate) fn save(dir: &Path, session: &StoredSession) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("create config dir: {e}"))?;
    let path = session_path(dir);
    let json = serde_json::to_string_pretty(session).map_err(|e| e.to_string())?;

    let tmp = path.with_extension("tmp");
    {
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        use std::io::Write;
        let mut f = opts.open(&tmp).map_err(|e| format!("write session: {e}"))?;
        f.write_all(json.as_bytes())
            .map_err(|e| format!("write session: {e}"))?;
    }
    fs::rename(&tmp, &path).map_err(|e| format!("write session: {e}"))?;
    // Belt-and-braces for a file that predates this change and kept its old
    // wider mode across the rename target's replacement.
    restrict(&path);
    Ok(())
}

/// Remove the credential. Absent is success — sign-out must be idempotent and
/// must never fail on a machine that was already signed out.
pub(crate) fn clear(dir: &Path) -> Result<(), String> {
    match fs::remove_file(session_path(dir)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("clear session: {e}")),
    }
}

/// Best-effort owner-only permissions.
#[cfg(unix)]
fn restrict(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict(_path: &Path) {}
