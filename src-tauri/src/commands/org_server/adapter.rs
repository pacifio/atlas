//! The production organisation cloud, and the offer's view of the account and
//! the Project's binding, over the state the app already holds.
//!
//! Nothing here mints a token of its own or holds a new client: remote reads
//! go through the artifacts client the Timeline uses (with its 240-second
//! token reuse, so the organisation tools add no pressure on the rate-limited
//! token route), the roster through the auth core the Members modal reads,
//! chat through the one comms manager the chat pane uses (its REST client, and
//! its one socket for a message — no second socket), a Space page through the Spaces manager the canvas uses
//! (its token source and dial, on a short-lived socket of its own), and who
//! the user is comes from the auth core's snapshot.
//! Both are resolved per call rather than held, because this is built during
//! `setup`, where registration order is not guaranteed — the same reason the
//! artifacts module's token source resolves `AuthState` per call.
//!
//! What never happens here: reading the app's active or chat organisation.
//! Every method is told which organisation to act in, by the session's grant.

use tauri::{AppHandle, Manager};

use super::cloud::{
    BoardQuery, Caller, CloudError, CloudFuture, CommentRef, CurrentSessionQuery, InboxQuery, Member, NewMessage, NewPage,
    NewReply, OrgConversation, OrganisationCloud, PayloadRef, RecordedSession, SentMessage, TimelineQuery,
};
use super::offers::SessionOrgs;
use super::OrgScope;
use crate::auth::{AccountOrg, AccountUser, AuthSnapshot};
use crate::commands::artifacts_cloud::{is_cloud_bound, recorded_session_id, ArtifactsCloudState};
use crate::commands::auth::AuthState;

/// The organisation cloud over the app's existing clients.
pub struct AppOrganisationCloud {
    app: AppHandle,
}

impl AppOrganisationCloud {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }

    fn artifacts(&self) -> Result<tauri::State<'_, ArtifactsCloudState>, CloudError> {
        self.app
            .try_state::<ArtifactsCloudState>()
            .ok_or_else(|| CloudError::Unavailable("the Timeline's cloud reader is not ready".into()))
    }
}

/// The signed-in account and its organisations, or why there is none.
fn account(app: &AppHandle) -> Result<(Option<AccountUser>, Vec<AccountOrg>), CloudError> {
    let Some(auth) = app.try_state::<AuthState>() else {
        return Err(CloudError::SignedOut("the account is not ready".into()));
    };
    match auth.core().snapshot() {
        AuthSnapshot::SignedIn { user, orgs, .. } => Ok((user, orgs.unwrap_or_default())),
        _ => Err(CloudError::SignedOut("no account is signed in".into())),
    }
}

/// The captured row a chat is recorded in, and its local title, when the
/// launch directory's Project is bound to the scope's organisation and
/// Workspace. The same join the chat's comment pane uses.
fn captured(query: &CurrentSessionQuery<'_>) -> Result<Option<(String, String, Option<String>)>, String> {
    let Some(workspace_id) = query.scope.workspace_id.clone() else { return Ok(None) };
    let Some(store) = crate::commands::capture::open_reader(query.cwd)? else { return Ok(None) };
    let Ok(Some(binding)) = store.binding() else { return Ok(None) };
    // Still bound where the grant says: a Project rebound elsewhere since the
    // offer is not this session's organisation any more.
    if !is_cloud_bound(&binding, &query.scope.org_id)
        || binding.remote_workspace_id.as_deref() != Some(workspace_id.as_str())
    {
        return Ok(None);
    }
    let Some(row_id) = recorded_session_id(&store, query.cwd, query.native_session_id)? else {
        return Ok(None);
    };
    let title = store.session(&row_id).ok().flatten().and_then(|s| s.title);
    Ok(Some((row_id, workspace_id, title)))
}

impl OrganisationCloud for AppOrganisationCloud {
    fn caller<'a>(&'a self, org_id: &'a str) -> CloudFuture<'a, Caller> {
        Box::pin(async move {
            let (user, orgs) = account(&self.app)?;
            let Some(user) = user else {
                return Err(CloudError::Unavailable("the account's profile has not loaded yet".into()));
            };
            let org = orgs.into_iter().find(|o| o.id == org_id);
            Ok(Caller {
                user_id: user.id,
                name: user.name,
                role: org.as_ref().and_then(|o| o.role),
                organisation_name: org.map(|o| o.name),
            })
        })
    }

    fn current_session<'a>(&'a self, query: CurrentSessionQuery<'a>) -> CloudFuture<'a, Option<RecordedSession>> {
        Box::pin(async move {
            let owned = (query.scope.clone(), query.native_session_id.to_string(), query.cwd.to_string());
            let found = tauri::async_runtime::spawn_blocking(move || {
                let (scope, native_session_id, cwd) = owned;
                captured(&CurrentSessionQuery { scope: &scope, native_session_id: &native_session_id, cwd: &cwd })
            })
            .await
            .map_err(|e| CloudError::Unavailable(e.to_string()))?
            .map_err(CloudError::Unavailable)?;
            let Some((id, workspace_id, local_title)) = found else { return Ok(None) };

            // Liveness is the server's to derive. The board the Timeline keeps
            // fresh answers without a request when this organisation is the
            // one it shows; otherwise ask for the session itself.
            let artifacts = self.artifacts()?;
            let org_id = &query.scope.org_id;
            let summary = match artifacts.board.snapshot(org_id).sessions.get(&id).cloned() {
                Some(summary) => summary,
                None => match artifacts.client.session_detail(org_id, &workspace_id, &id).await {
                    Ok(page) => page.summary,
                    // Captured here, not synced yet: the Workspace does not
                    // hold it, so it is not recorded there yet.
                    Err(atlas_artifacts::Error::NotFound(_)) => return Ok(None),
                    Err(e) => return Err(e.into()),
                },
            };
            Ok(Some(RecordedSession {
                id,
                workspace_id,
                title: summary.title.filter(|t| !t.is_empty()).or(local_title),
                live: summary.live,
            }))
        })
    }

    fn members<'a>(&'a self, org_id: &'a str) -> CloudFuture<'a, Vec<Member>> {
        Box::pin(async move {
            let Some(auth) = self.app.try_state::<AuthState>() else {
                return Err(CloudError::SignedOut("the account is not ready".into()));
            };
            let core = auth.core();
            let roster = core.list_members(org_id).await?;
            Ok(roster
                .into_iter()
                .map(|m| Member { user_id: m.user_id, name: m.name, email: m.email, role: m.role })
                .collect())
        })
    }

    fn conversations<'a>(&'a self, org_id: &'a str) -> CloudFuture<'a, Vec<OrgConversation>> {
        Box::pin(async move {
            let comms = crate::commands::comms::manager(&self.app).map_err(CloudError::Unavailable)?;
            // Chat's one socket is on the organisation the window chose for
            // it. A chat tool acts there only when that is the grant's.
            let chat_org = comms.org_id();
            if chat_org.as_deref() != Some(org_id) {
                return Err(CloudError::ChatElsewhere { grant_org: org_id.to_string(), chat_org });
            }
            let list = comms.rest().conversations(org_id).await?;
            let listed = |c: atlas_comms::wire::Conversation, caller_is_member: bool| OrgConversation {
                id: c.id,
                kind: c.kind,
                name: c.name,
                member_ids: c.member_ids,
                caller_is_member,
            };
            Ok(list
                .conversations
                .into_iter()
                .filter(|c| c.archived_at.is_none())
                .map(|c| listed(c, true))
                .chain(list.discoverable.into_iter().filter(|c| c.archived_at.is_none()).map(|c| listed(c, false)))
                .collect())
        })
    }

    fn comments<'a>(
        &'a self,
        org_id: &'a str,
        workspace_id: &'a str,
        session_id: &'a str,
    ) -> CloudFuture<'a, Vec<atlas_artifacts::Comment>> {
        Box::pin(async move {
            let artifacts = self.artifacts()?;
            Ok(artifacts.client.comments(org_id, workspace_id, session_id).await?)
        })
    }

    /// The comment route's update half through the Timeline's artifacts
    /// client, with only `resolved` in the patch: the body is the author's
    /// and never touched here.
    fn set_resolved<'a>(&'a self, comment: CommentRef<'a>, resolved: bool) -> CloudFuture<'a, atlas_artifacts::Comment> {
        Box::pin(async move {
            let artifacts = self.artifacts()?;
            Ok(artifacts
                .client
                .update_comment(
                    comment.org_id,
                    comment.workspace_id,
                    comment.session_id,
                    comment.comment_id,
                    None,
                    Some(resolved),
                )
                .await?)
        })
    }

    /// The comment route's create half through the Timeline's artifacts
    /// client: `parent_id` the thread's root, the root's anchor, the body as
    /// given. The server derives the author and the mentions.
    fn reply<'a>(&'a self, reply: NewReply<'a>) -> CloudFuture<'a, atlas_artifacts::Comment> {
        Box::pin(async move {
            let artifacts = self.artifacts()?;
            let at = atlas_artifacts::CommentTarget {
                org_id: reply.root.org_id,
                project_id: reply.root.workspace_id,
                session_id: reply.root.session_id,
            };
            let new = atlas_artifacts::NewComment {
                anchor_kind: reply.anchor_kind,
                anchor_id: reply.anchor_id,
                parent_id: Some(reply.root.comment_id),
                body: reply.body,
            };
            Ok(artifacts.client.create_comment(at, new).await?)
        })
    }

    /// One board page through the Timeline's artifacts client, in the
    /// grant's Workspace, at the server's largest page so a scan spends as
    /// few requests (and minted tokens) as it can.
    fn board_page<'a>(&'a self, org_id: &'a str, query: BoardQuery<'a>) -> CloudFuture<'a, atlas_artifacts::SessionBoardPage> {
        Box::pin(async move {
            let artifacts = self.artifacts()?;
            let query = atlas_artifacts::BoardQuery {
                workspace_id: Some(query.workspace_id),
                q: query.q,
                cursor: query.cursor,
                limit: Some(atlas_artifacts::BOARD_PAGE_MAX),
            };
            Ok(artifacts.client.board_page(org_id, query).await?)
        })
    }

    fn timeline<'a>(&'a self, query: TimelineQuery<'a>) -> CloudFuture<'a, atlas_artifacts::SessionDetailPage> {
        Box::pin(async move {
            let artifacts = self.artifacts()?;
            Ok(artifacts
                .client
                .session_page(query.org_id, query.workspace_id, query.session_id, query.cursor, query.limit)
                .await?)
        })
    }

    fn entry_payload<'a>(&'a self, entry: PayloadRef<'a>) -> CloudFuture<'a, atlas_artifacts::EntryPayload> {
        Box::pin(async move {
            let artifacts = self.artifacts()?;
            Ok(artifacts
                .client
                .entry_payload(entry.org_id, entry.workspace_id, entry.session_id, entry.row_id, entry.part)
                .await?)
        })
    }

    /// The inbox route's read half through the Timeline's artifacts client.
    /// The client has no mark-read call, so this cannot reach one.
    fn inbox<'a>(&'a self, org_id: &'a str, query: InboxQuery<'a>) -> CloudFuture<'a, atlas_artifacts::InboxPage> {
        Box::pin(async move {
            let artifacts = self.artifacts()?;
            Ok(artifacts.client.inbox(org_id, query.unread_only, query.cursor, query.limit).await?)
        })
    }

    /// One `page.create` through the Spaces manager the canvas uses, on a
    /// socket of its own for this one frame ([`SpacesManager::create_page`]):
    /// the server answers `page.created` only to the socket that asked, so a
    /// private socket makes the answer this call's, and the tree broadcast
    /// still reaches a canvas open in the window. Held to chat's organisation
    /// like every chat call, though the socket names its own: chat's is the
    /// organisation the user has chat open in, and a Space is part of chat.
    ///
    /// [`SpacesManager::create_page`]: atlas_comms::spaces::SpacesManager::create_page
    fn create_page<'a>(&'a self, page: NewPage<'a>) -> CloudFuture<'a, String> {
        Box::pin(async move {
            let comms = crate::commands::comms::manager(&self.app).map_err(CloudError::Unavailable)?;
            let chat_org = comms.org_id();
            if chat_org.as_deref() != Some(page.org_id) {
                return Err(CloudError::ChatElsewhere { grant_org: page.org_id.to_string(), chat_org });
            }
            let Some(spaces) = self.app.try_state::<crate::commands::spaces::SpacesState>() else {
                return Err(CloudError::Unavailable("Spaces is not ready".into()));
            };
            let spaces = spaces.0.clone();
            let frame = atlas_comms::spaces::PageCreate::root_page(page.name);
            Ok(spaces.create_page(page.org_id, page.conversation_id, &frame).await?)
        })
    }

    fn dm_with<'a>(&'a self, org_id: &'a str, user_id: &'a str) -> CloudFuture<'a, (OrgConversation, bool)> {
        self.open_dm(org_id, user_id)
    }

    fn referenceable_workspaces<'a>(&'a self, org_id: &'a str) -> CloudFuture<'a, Vec<String>> {
        Box::pin(async move {
            let comms = self.chat_in(org_id)?;
            let list = comms.rest().workspaces(org_id).await?;
            Ok(list.workspaces.into_iter().map(|w| w.id).collect())
        })
    }

    fn send<'a>(&'a self, message: NewMessage<'a>) -> CloudFuture<'a, SentMessage> {
        self.post(message)
    }
}

/// How long a send waits for the server's `ack` before answering with the
/// client's id alone. The socket keeps the message and resends it until the
/// server takes it, so a slow `ack` is not a failed send.
const ACK_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

impl AppOrganisationCloud {
    /// Chat's one manager, when it is connected to `org_id` — the
    /// organisation the user has chat open in — and why not otherwise.
    fn chat_in(&self, org_id: &str) -> Result<atlas_comms::CommsManager, CloudError> {
        let comms = crate::commands::comms::manager(&self.app).map_err(CloudError::Unavailable)?;
        let chat_org = comms.org_id();
        if chat_org.as_deref() != Some(org_id) {
            return Err(CloudError::ChatElsewhere { grant_org: org_id.to_string(), chat_org });
        }
        Ok(comms)
    }

    /// `POST /conversations {kind: "dm", user_id}` through chat's REST client,
    /// as the chat pane's "Message" does (`comms_create_dm`): the server
    /// answers the DM that exists (200) or the one it just made (201).
    fn open_dm<'a>(&'a self, org_id: &'a str, user_id: &'a str) -> CloudFuture<'a, (OrgConversation, bool)> {
        Box::pin(async move {
            let comms = self.chat_in(org_id)?;
            let dm = comms.rest().create_dm(org_id, user_id).await?;
            let c = dm.conversation;
            let conversation = OrgConversation {
                id: c.id,
                kind: c.kind,
                name: c.name,
                member_ids: c.member_ids,
                caller_is_member: true,
            };
            Ok((conversation, dm.created))
        })
    }

    /// One `send` frame on chat's own socket, through the manager the chat
    /// pane sends with (`comms_send`), so the message shows in the window as
    /// the user's own and is resent across a reconnect like theirs — never a
    /// second socket. There is no REST send. The `ack` names only the
    /// client's id, the server's id and the sequence; the manager turns it
    /// into the optimistic row's update, which is what this waits for, at
    /// most [`ACK_WAIT`].
    fn post<'a>(&'a self, message: NewMessage<'a>) -> CloudFuture<'a, SentMessage> {
        Box::pin(async move {
            let comms = self.chat_in(message.org_id)?;
            // Subscribed before the frame is written, so the ack cannot be
            // missed between the two.
            let mut events = comms.subscribe();
            let client_msg_id = comms.send(
                message.conversation_id,
                message.body.to_string(),
                None,
                Vec::new(),
                message.artifact_refs.to_vec(),
            )?;
            let optimistic = atlas_comms::state::optimistic_id(&client_msg_id);
            let acked = tokio::time::timeout(ACK_WAIT, async {
                loop {
                    match events.recv().await {
                        Ok(envelope) => {
                            if let atlas_comms::CommsEvent::MessageUpdated {
                                replaced_id: Some(replaced),
                                message,
                                ..
                            } = envelope.ev
                            {
                                if replaced == optimistic {
                                    return Some(message.id);
                                }
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
                    }
                }
            })
            .await
            .ok()
            .flatten();
            Ok(SentMessage { client_msg_id, message_id: acked })
        })
    }
}

/// The offer's view of the account and the Project's binding, over the auth
/// core and the capture store.
pub struct AppSessionOrgs {
    app: AppHandle,
}

impl AppSessionOrgs {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl SessionOrgs for AppSessionOrgs {
    fn signed_in(&self) -> bool {
        account(&self.app).is_ok()
    }

    fn bound_to(&self, cwd: &str) -> Option<OrgScope> {
        let store = crate::commands::capture::open_reader(cwd).ok().flatten()?;
        let binding = store.binding().ok().flatten()?;
        scope_of(&binding)
    }
}

/// The organisation a Project's binding places it in: its own organisation,
/// while it is bound to the cloud and still recording. Never the window's.
pub(super) fn scope_of(binding: &atlas_checkpoint::Binding) -> Option<OrgScope> {
    let org_id = binding.org_id.clone()?;
    if !is_cloud_bound(binding, &org_id) {
        return None;
    }
    Some(OrgScope { org_id, workspace_id: binding.remote_workspace_id.clone() })
}
