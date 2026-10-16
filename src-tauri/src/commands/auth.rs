//! Tauri adapters over [`crate::auth::AuthCore`].
//!
//! Thin by design: translate arguments, spawn the poll task, emit events. Every
//! decision worth testing lives in `crate::auth`, except for the asset-scope
//! avatar grant path validation which is tested below.
//!
//! Events emitted to the frontend:
//!   `atlas:auth-changed`    — the full [`AuthSnapshot`], on every transition
//!   `atlas:auth-error`      — `{ message }` when a grant ends without a token
//!   `atlas:auth-signed-out` — `{ message }` when the server ended the session
//!
//! All go out via `app.emit`, which broadcasts to **every** window, so a
//! multi-window install always agrees about who is signed in.
//!
//! `auth-error` and `auth-signed-out` are separate because they are read in
//! different places: a grant failure belongs inside the connect dialog the user
//! is already looking at, while a revoked session arrives with nothing on
//! screen and has to reach them as a toast.

use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::auth::{
    auth_base, AuthCore, AuthSnapshot, CreatedOrg, GrantError, OrgInvitation, OrgMember, Role,
    Validation,
};
use crate::telemetry::TelemetryClient;

/// Shown when the server rejects the stored credential. Deliberately says what
/// happened and what to do about it: a title bar that silently reverts to a
/// signed-out icon reads as a bug.
const SESSION_ENDED: &str = "Your Atlas session ended. Sign in again to reconnect.";

/// Managed handle to the auth core.
pub struct AuthState {
    core: Arc<AuthCore>,
    config_dir: std::path::PathBuf,
}

impl AuthState {
    pub fn new(config_dir: std::path::PathBuf) -> Self {
        Self {
            core: Arc::new(AuthCore::new(
                auth_base(),
                config_dir.clone(),
                reqwest::Client::new(),
            )),
            config_dir,
        }
    }

    pub fn core(&self) -> Arc<AuthCore> {
        Arc::clone(&self.core)
    }

    fn config_dir(&self) -> &std::path::Path {
        &self.config_dir
    }
}

/// Validate and canonicalize a cached avatar path before granting asset protocol access.
///
/// Ensures the path is:
/// - Absolute
/// - Named with the expected avatar prefix (`avatar-`)
/// - Has an allowed image extension (png, jpg, jpeg, webp, gif)
/// - Resolves to an existing regular file
fn resolve_avatar_grant_path(
    path: &str,
    allowed_dir: &std::path::Path,
) -> Option<std::path::PathBuf> {
    let p = std::path::Path::new(path);
    if !p.is_absolute() {
        return None;
    }
    let file_name = p.file_name()?.to_str()?;
    if !file_name.starts_with("avatar-") {
        return None;
    }
    let ext = p.extension()?.to_str()?.to_ascii_lowercase();
    if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif") {
        return None;
    }
    // A symlink named `avatar-*.png` could point anywhere — auth tokens,
    // session state. Canonicalize, then require the *target* to be a regular
    // file directly inside the avatar cache dir, with an avatar-shaped name
    // and an image extension. Both sides are canonicalized so symlinked
    // parents on either side (e.g. /var → /private/var) can't skew the check.
    let canonical_dir = dunce::canonicalize(allowed_dir).ok()?;
    let canonical = dunce::canonicalize(p).ok()?;
    if canonical.parent() != Some(canonical_dir.as_path()) {
        return None;
    }
    let resolved_name = canonical.file_name()?.to_str()?;
    if !resolved_name.starts_with("avatar-") {
        return None;
    }
    let resolved_ext = canonical.extension()?.to_str()?.to_ascii_lowercase();
    if !matches!(
        resolved_ext.as_str(),
        "png" | "jpg" | "jpeg" | "webp" | "gif"
    ) {
        return None;
    }
    if !canonical.is_file() {
        return None;
    }
    Some(canonical)
}

/// Grant the asset protocol read access to a specific cached avatar file.
///
/// On Linux, cached avatars are written to `app_config_dir()` (`~/.config/dev.atlas.ide/avatar-<hash>.<ext>`).
/// Because Tauri's Unix glob matcher uses `requireLiteralLeadingDot: true`, `$HOME/**` ignores
/// hidden dot directories such as `~/.config`.
/// Explicitly granting the single file via `allow_file` allows the webview to serve the avatar
/// without broadening scope to the entire config directory (which holds auth tokens and session state).
fn grant_avatar_file(app: &AppHandle, path: &str) {
    let Some(state) = app.try_state::<AuthState>() else {
        return;
    };
    if let Some(canonical) = resolve_avatar_grant_path(path, state.config_dir()) {
        let _ = app.asset_protocol_scope().allow_file(&canonical);
    }
}

fn grant_avatar_for_snapshot(app: &AppHandle, snapshot: &AuthSnapshot) {
    if let AuthSnapshot::SignedIn {
        user: Some(user), ..
    } = snapshot
    {
        if let Some(ref path) = user.avatar_path {
            grant_avatar_file(app, path);
        }
    }
}

fn grant_member_avatars(app: &AppHandle, members: &[OrgMember]) {
    for member in members {
        if let Some(ref path) = member.avatar_path {
            grant_avatar_file(app, path);
        }
    }
}

/// The one funnel every auth transition passes through — including
/// `restore_on_launch`'s initial emit and each revalidation callback. Telemetry
/// identity is synced here rather than at the individual call sites precisely
/// because of that: a signed-in relaunch is covered for free, and no future
/// transition can forget to update who events are attributed to.
fn broadcast(app: &AppHandle, snapshot: AuthSnapshot) {
    grant_avatar_for_snapshot(app, &snapshot);
    sync_identity(
        app,
        &snapshot,
        crate::state::atlas_config::read(app).link_telemetry_to_account,
    );
    // Team chat's socket follows the active Organisation, and every transition
    // that can change it — launch restore, sign-in, sign-out, `set_active_org`
    // — passes through here. Hooking the funnel rather than each call site is
    // what makes "connect" have no separate path that could be forgotten.
    crate::commands::comms::retarget(app, &snapshot);
    let _ = app.emit("atlas:auth-changed", snapshot);
}

/// Map an auth snapshot onto the telemetry identity.
///
/// Idempotent by construction — [`TelemetryClient::identify_account`] refreshes
/// person properties without re-merging when the account is unchanged, which it
/// has to be, since this runs on every revalidation.
///
/// `Connecting`, and `SignedIn` with no profile yet, deliberately leave identity
/// alone: the next successful validation broadcasts a snapshot that has `user`,
/// and resetting in the gap would bounce attribution back to the device for no
/// reason.
/// Re-apply the current auth snapshot to the telemetry identity after
/// `linkTelemetryToAccount` changed.
///
/// [`sync_identity`] only ever runs on an auth transition, but that setting
/// gates it from the settings side and can flip with no transition at all —
/// so `commands::atlas_config::notify_settings_changed` calls this on every
/// committed settings change. The flag is passed in rather than read here
/// because that caller already holds the freshly committed snapshot, and
/// reaching back into the config mutex from a path that may be running under
/// it is how a deadlock gets written.
pub fn resync_telemetry_identity(app: &AppHandle, link_to_account: bool) {
    if let Some(state) = app.try_state::<AuthState>() {
        let snapshot = state.core().snapshot();
        sync_identity(app, &snapshot, link_to_account);
    }
}

fn sync_identity(app: &AppHandle, snapshot: &AuthSnapshot, link_to_account: bool) {
    let tel = telemetry(app);
    match snapshot {
        AuthSnapshot::SignedIn {
            user: Some(user),
            orgs,
            active_org_id,
            ..
        } => {
            // Honour the user's choice to keep analytics off their account.
            if !link_to_account {
                tel.reset_identity();
                return;
            }
            let active = active_org_id.as_ref().and_then(|id| {
                orgs.as_ref()
                    .and_then(|list| list.iter().find(|o| &o.id == id))
            });
            tel.identify_account(&crate::telemetry::AccountIdentity {
                user_id: user.id.clone(),
                email: user.email.clone(),
                name: user.name.clone(),
                org_id: active_org_id.clone(),
                org_name: active.map(|o| o.name.clone()),
                org_role: active
                    .and_then(|o| o.role)
                    .map(|r| format!("{r:?}").to_lowercase()),
                org_count: orgs.as_ref().map(std::vec::Vec::len).unwrap_or(0),
            });
        }
        AuthSnapshot::SignedOut => tel.reset_identity(),
        _ => {}
    }
}

/// The managed telemetry client. Every capture through it is a no-op unless the
/// user has opted in, so nothing here needs its own consent check.
fn telemetry(app: &AppHandle) -> Arc<TelemetryClient> {
    Arc::clone(&app.state::<Arc<TelemetryClient>>())
}

/// Current account state. Carries no credential — see [`AuthSnapshot`].
#[tauri::command]
pub fn auth_snapshot(app: AppHandle, state: State<'_, AuthState>) -> AuthSnapshot {
    let snapshot = state.core().snapshot();
    grant_avatar_for_snapshot(&app, &snapshot);
    snapshot
}

/// Begin (or resume) sign-in.
///
/// Opens the approval page in the system browser and polls in the background.
/// Returns immediately with the `connecting` snapshot so the dialog can render
/// while the human is still in the browser.
#[tauri::command]
pub async fn auth_sign_in(
    app: AppHandle,
    state: State<'_, AuthState>,
) -> Result<AuthSnapshot, String> {
    let core = state.core();

    let grant = core.start_grant().await.map_err(|e| e.user_message())?;

    // Never a URL built here — it comes off the wire, so the desktop stays
    // ignorant of the web app's routing. *Which* of the two the server sent is
    // a security decision, so it is `approval_url`'s to make and not this
    // layer's: see the note there before changing it.
    let _ = app
        .opener()
        .open_url(grant.approval_url().to_string(), None::<&str>);

    let snapshot = core.snapshot();
    broadcast(&app, snapshot.clone());

    // Poll off the command so the frontend is not blocked for up to 10 minutes.
    let task_app = app.clone();
    tauri::async_runtime::spawn(async move {
        match core.run_grant(&grant).await {
            Ok(()) => {
                let snap = core.snapshot();
                // Broadcast first: it identifies, so `auth_signed_in` lands on
                // the account person rather than the device one.
                broadcast(&task_app, snap.clone());
                raise(&task_app);
                let (org_count, has_active) = match &snap {
                    AuthSnapshot::SignedIn {
                        orgs,
                        active_org_id,
                        ..
                    } => (
                        orgs.as_ref().map(std::vec::Vec::len).unwrap_or(0),
                        active_org_id.is_some(),
                    ),
                    _ => (0, false),
                };
                telemetry(&task_app).capture_signed_in(org_count, has_active);
            }
            // Cancellation is a deliberate user action; it needs no error toast.
            Err(GrantError::Cancelled) => broadcast(&task_app, core.snapshot()),
            Err(err) => {
                broadcast(&task_app, core.snapshot());
                let _ = task_app.emit(
                    "atlas:auth-error",
                    serde_json::json!({ "message": err.user_message() }),
                );
            }
        }
    });

    Ok(snapshot)
}

/// Abandon an in-flight grant. Idempotent.
#[tauri::command]
pub fn auth_cancel_sign_in(app: AppHandle, state: State<'_, AuthState>) -> AuthSnapshot {
    let core = state.core();
    core.cancel_grant();
    let snapshot = core.snapshot();
    broadcast(&app, snapshot.clone());
    snapshot
}

/// Which organisation the desktop acts for — billing included (#73).
///
/// The org switcher used to be frontend-only: it re-pointed projects and
/// telemetry and told the Rust side nothing, while every gateway request
/// reads the active org from the auth snapshot. So the switch changed what
/// the user SAW and not who they BILLED — an unentitled org appeared to work
/// because its turns were charged to the entitled one. The switcher calls
/// this now; broadcast after writing so every window's auth state agrees.
///
/// `org_id` is the SERVER org id (`remoteId`), or `None` for a local-only
/// org, which clears the desktop's choice and falls back the way the store
/// documents.
#[tauri::command]
pub async fn auth_set_active_org(
    app: AppHandle,
    state: State<'_, AuthState>,
    org_id: Option<String>,
) -> Result<(), String> {
    let core = state.core();
    core.set_active_org(org_id)?;
    broadcast(&app, core.snapshot());
    Ok(())
}

/// Sign out (ATL-50).
///
/// Local state is gone and the signed-out snapshot has been broadcast to every
/// window **before** the server is contacted at all, so the UI flips with no
/// spinner and no wait — and sign-out works with the network off, which is when
/// it matters most.
///
/// Resolves to `true` when the server confirmed the session is revoked. The
/// caller is already signed out either way; the value only decides whether they
/// are told the server session may outlive the local one. It is returned rather
/// than emitted because, unlike everything else here, it answers *this* window's
/// click — broadcasting it would put the same caveat in front of two other
/// windows that did nothing.
#[tauri::command]
pub async fn auth_sign_out(app: AppHandle, state: State<'_, AuthState>) -> Result<bool, String> {
    let core = state.core();
    let ticket = core.sign_out();
    // The native agent's connection caches an access JWT that outlives the
    // revoked session token — the JWT verifies statelessly against JWKS — and
    // would keep making org-billed gateway calls until its own expiry, up to
    // ~9 minutes (#62). Signing out locally means the engine's credential goes
    // too, in-flight turn included. `try_state` because sign-out must work
    // even if the agent host never initialised.
    if let Some(host) = app.try_state::<std::sync::Arc<super::agent_host::AgentHost>>() {
        host.drop_native_connection();
    }
    // Capture BEFORE broadcasting. `broadcast` resets the telemetry identity to
    // the device, so the order matters: reversed, the event that describes the
    // account leaving would be filed against the anonymous device person.
    let had_ticket = ticket.is_some();
    if had_ticket {
        // Recorded on the local sign-out, not the revocation: the user has
        // signed out either way, and whether the server could be reached is
        // not what this event counts.
        telemetry(&app).capture_signed_out();
    }
    broadcast(&app, core.snapshot());

    Ok(match ticket {
        Some(ticket) => core.revoke(ticket).await,
        // Nothing was stored, so there is nothing the server could still be
        // holding — no caveat is owed, and nothing happened worth recording.
        None => true,
    })
}

/// Create an organisation server-side and hand back its id (ATL-36).
///
/// The "Turn on sync" action: the frontend keeps the org local and calls this to
/// link it, writing the returned `id` onto the local org as its `remoteId`. On
/// success the refreshed snapshot (now listing the new org) is broadcast to every
/// window; the returned id is what *this* window links against without waiting
/// for that event.
///
/// Carries no token out — only the server id and name (see [`CreatedOrg`]).
/// A failure is surfaced as a user-facing string; only a real 401 inside
/// `create_org` clears the credential, and it does so through the same single
/// path everything else does — never here.
#[tauri::command]
pub async fn auth_create_org(
    name: String,
    slug: String,
    app: AppHandle,
    state: State<'_, AuthState>,
) -> Result<CreatedOrg, String> {
    let core = state.core();
    let created = core
        .create_org(&name, &slug)
        .await
        .map_err(|e| e.user_message())?;
    broadcast(&app, core.snapshot());
    Ok(created)
}

/// Is an organisation handle free? — the create-form typeahead probe (§6.2).
///
/// Advisory only: a `true` here can still lose a race against another create,
/// so the caller must still handle [`auth_create_org`] failing. A taken slug is
/// a plain `false`, not an error — only a real failure (no session, rate limit,
/// unreachable) rejects, carrying the same user-facing string as everything
/// else. Broadcasts nothing: this reads, it does not change state.
#[tauri::command]
pub async fn auth_check_org_slug(
    slug: String,
    state: State<'_, AuthState>,
) -> Result<bool, String> {
    state
        .core()
        .check_slug(&slug)
        .await
        .map_err(|e| e.user_message())
}

/// Force a server re-pull of the account's organisations and broadcast the
/// refreshed snapshot — the manual "refresh" affordance behind the org list.
///
/// Silent about failure like the launch-path refresh it reuses: a flaky pull
/// leaves the last-known list in place rather than emptying the menu, and never
/// touches the credential.
#[tauri::command]
pub async fn auth_refresh(
    app: AppHandle,
    state: State<'_, AuthState>,
) -> Result<AuthSnapshot, String> {
    let core = state.core();
    core.refresh().await;
    let snapshot = core.snapshot();
    broadcast(&app, snapshot.clone());
    Ok(snapshot)
}

/// Delete a synced organisation server-side (ATL-36).
///
/// Best-effort from the frontend's side: the local purge happens whether this
/// resolves or rejects (deleting is admin-only, so a member gets a 403 here yet
/// still wants the org gone locally). On success the refreshed snapshot — now
/// without the org — is broadcast so no window re-merges it.
#[tauri::command]
pub async fn auth_delete_org(
    remote_id: String,
    app: AppHandle,
    state: State<'_, AuthState>,
) -> Result<(), String> {
    let core = state.core();
    core.delete_org(&remote_id)
        .await
        .map_err(|e| e.user_message())?;
    broadcast(&app, core.snapshot());
    Ok(())
}

// ── Organisation members (ATL-36) ───────────────────────────────────────────
//
// `Denied` collapses 403 and 400, and its default message names the org-CREATE
// case ("that name or handle may already be taken"), which would be nonsense
// here — so every member command supplies its own wording via
// `user_message_denied`. As everywhere in this module, only a real 401 inside
// `AuthCore` clears the credential; nothing below ever touches it.

/// The org's members. Grants asset scope for cached member avatars; broadcasts nothing.
#[tauri::command]
pub async fn auth_list_members(
    app: AppHandle,
    org_id: String,
    state: State<'_, AuthState>,
) -> Result<Vec<OrgMember>, String> {
    let members = state.core().list_members(&org_id).await.map_err(|e| {
        e.user_message_denied("You don't have access to this organization's members.")
    })?;
    grant_member_avatars(&app, &members);
    Ok(members)
}

/// Pending + past invitations. Admin-scoped server-side, so a non-admin's call
/// comes back `Denied` and the caller shows an empty tab. Read-only.
#[tauri::command]
pub async fn auth_list_invitations(
    org_id: String,
    state: State<'_, AuthState>,
) -> Result<Vec<OrgInvitation>, String> {
    state
        .core()
        .list_invitations(&org_id)
        .await
        .map_err(|e| e.user_message_denied("Only an admin can see this organization's invites."))
}

/// Invite someone by email. The server emails the invitee; the returned
/// `acceptUrl` is the same link, for the inviter to copy too. Changes server
/// state only; the snapshot holds no members, so
/// there is nothing to broadcast.
#[tauri::command]
pub async fn auth_invite_member(
    org_id: String,
    email: String,
    role: Role,
    state: State<'_, AuthState>,
) -> Result<OrgInvitation, String> {
    state
        .core()
        .invite_member(&org_id, &email, role)
        .await
        .map_err(|e| {
            e.user_message_denied(
                "Couldn't invite them — you may not be an admin, or they're already in.",
            )
        })
}

/// Revoke a pending invitation. Broadcasts nothing (see above).
#[tauri::command]
pub async fn auth_cancel_invitation(
    invitation_id: String,
    state: State<'_, AuthState>,
) -> Result<(), String> {
    state
        .core()
        .cancel_invitation(&invitation_id)
        .await
        .map_err(|e| e.user_message_denied("Only an admin can cancel an invite."))
}

/// Change a member's role. Takes effect in their NEXT minted token — tokens
/// already issued stay valid until they expire. Broadcasts nothing.
#[tauri::command]
pub async fn auth_update_member_role(
    org_id: String,
    member_id: String,
    role: Role,
    state: State<'_, AuthState>,
) -> Result<(), String> {
    state
        .core()
        .update_member_role(&org_id, &member_id, role)
        .await
        .map_err(|e| e.user_message_denied("Only an admin can change a member's role."))
}

/// Remove a member. **This one does broadcast**: it is the only member op that
/// can change the caller's own org set (you may be removing yourself), and
/// `remove_member` re-pulls the identity, so the account menu would otherwise
/// keep listing an org the user just left.
#[tauri::command]
pub async fn auth_remove_member(
    org_id: String,
    member_id_or_email: String,
    app: AppHandle,
    state: State<'_, AuthState>,
) -> Result<(), String> {
    let core = state.core();
    core.remove_member(&org_id, &member_id_or_email)
        .await
        .map_err(|e| e.user_message_denied("Only an admin can remove a member."))?;
    broadcast(&app, core.snapshot());
    Ok(())
}

/// Leave an organisation (`org_id` is the SERVER id). Open to every member but
/// the Owner; the last admin is refused too. Re-broadcasts the snapshot so the
/// account menu drops the org at once.
#[tauri::command]
pub async fn auth_leave_org(
    org_id: String,
    app: AppHandle,
    state: State<'_, AuthState>,
) -> Result<(), String> {
    let core = state.core();
    core.leave_org(&org_id).await.map_err(|e| {
        e.user_message_denied(
            "Couldn't leave. The owner can't leave their organization, and an organization's \
             last admin has to make someone else an admin first.",
        )
    })?;
    broadcast(&app, core.snapshot());
    Ok(())
}

/// Bring Atlas forward once approval lands, so the human does not have to hunt
/// for the window they left behind in the browser.
fn raise(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Render the stored credential immediately, then validate it in the
/// background for as long as it takes (ATL-48).
///
/// The first broadcast is the whole offline story: a launch with no network
/// shows a complete signed-in title bar — name and photo — from the stored
/// snapshot, rather than waiting on a call that is going to time out.
///
/// The validation behind it runs unbounded, so a machine that boots offline
/// reconnects on its own. Only a 401 ends it in a sign-out, and only then does
/// the user hear about it.
pub fn restore_on_launch(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let core = app.state::<AuthState>().core();
        broadcast(&app, core.snapshot());

        let settled = {
            let app = app.clone();
            core.revalidate(move |snapshot| broadcast(&app, snapshot))
                .await
        };

        if settled == Validation::Rejected {
            let _ = app.emit(
                "atlas:auth-signed-out",
                serde_json::json!({ "message": SESSION_ENDED }),
            );
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_avatar_grant_path_validates_path() {
        let temp_dir = tempfile::tempdir().unwrap();
        let cache_dir = temp_dir.path();
        let valid_file = temp_dir.path().join("avatar-1234abcd5678ef01.png");
        std::fs::write(&valid_file, b"png data").unwrap();

        // Valid cached avatar
        let resolved = resolve_avatar_grant_path(valid_file.to_str().unwrap(), cache_dir);
        assert!(resolved.is_some());
        assert_eq!(resolved.unwrap(), dunce::canonicalize(&valid_file).unwrap());

        // Relative path rejected
        assert!(resolve_avatar_grant_path("avatar-1234.png", cache_dir).is_none());

        // Missing file rejected
        let missing = temp_dir.path().join("avatar-missing.png");
        assert!(resolve_avatar_grant_path(missing.to_str().unwrap(), cache_dir).is_none());

        // Wrong filename prefix rejected
        let non_avatar = temp_dir.path().join("photo-1234.png");
        std::fs::write(&non_avatar, b"png").unwrap();
        assert!(resolve_avatar_grant_path(non_avatar.to_str().unwrap(), cache_dir).is_none());

        // Disallowed extension rejected
        let non_image = temp_dir.path().join("avatar-session.json");
        std::fs::write(&non_image, b"{}").unwrap();
        assert!(resolve_avatar_grant_path(non_image.to_str().unwrap(), cache_dir).is_none());

        // Directory rejected
        let dir = temp_dir.path().join("avatar-dir.png");
        std::fs::create_dir(&dir).unwrap();
        assert!(resolve_avatar_grant_path(dir.to_str().unwrap(), cache_dir).is_none());

        // Path outside the cache dir rejected even with an avatar-shaped name
        let outside_dir = tempfile::tempdir().unwrap();
        let outside = outside_dir.path().join("avatar-e1060a0e8bfc7d4e.png");
        std::fs::write(&outside, b"png").unwrap();
        assert!(resolve_avatar_grant_path(outside.to_str().unwrap(), cache_dir).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn resolve_avatar_grant_path_rejects_symlink_escape() {
        let cache_dir = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let secret = elsewhere.path().join("auth.json");
        std::fs::write(&secret, b"{}").unwrap();
        let link = cache_dir.path().join("avatar-evil.png");
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        assert!(resolve_avatar_grant_path(link.to_str().unwrap(), cache_dir.path()).is_none());

        // Symlink to a non-avatar name inside the cache dir is also rejected
        let other = cache_dir.path().join("session.json");
        std::fs::write(&other, b"{}").unwrap();
        let link2 = cache_dir.path().join("avatar-link2.png");
        std::os::unix::fs::symlink(&other, &link2).unwrap();
        assert!(resolve_avatar_grant_path(link2.to_str().unwrap(), cache_dir.path()).is_none());
    }
}
