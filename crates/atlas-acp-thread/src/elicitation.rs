//! Elicitations — ported from `zed-ref/crates/acp_thread/src/acp_thread.rs:404-752`.
//!
//! An elicitation is the agent asking the user something mid-flight: a form to
//! fill in, or a URL to visit (device-code logins arrive this way). Two scopes
//! exist and the split matters: *request*-scoped elicitations can arrive before
//! any session thread exists — during auth — so they live on the connection,
//! while *session*-scoped ones live in the thread's timeline. Both share this
//! store so the pending/answered bookkeeping is written once.
//!
//! The bookkeeping that is easy to get wrong, and is ported verbatim:
//! - answering is idempotent — only a `Pending` elicitation resolves its
//!   oneshot, so a duplicate response is dropped instead of panicking on a
//!   consumed sender;
//! - a dropped sender still yields a response: the waiter maps `Canceled` to
//!   [`acp::ElicitationAction::Cancel`], so nothing hangs;
//! - an *accepted URL* elicitation stays outstanding (the user has been sent to
//!   a browser and the agent is still waiting on the round trip), which is why
//!   [`ElicitationStore::clear_resolved`] keeps it and cancellation is allowed
//!   to reach it.

use std::mem;
use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::EventSink;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ElicitationEntryId(pub Arc<str>);

impl ElicitationEntryId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug)]
pub struct Elicitation {
    pub id: ElicitationEntryId,
    pub request: acp::CreateElicitationRequest,
    pub status: ElicitationStatus,
}

#[derive(Debug)]
pub enum ElicitationStatus {
    Pending {
        respond_tx: oneshot::Sender<acp::CreateElicitationResponse>,
    },
    Accepted,
    Declined,
    Canceled,
    Completed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ElicitationStoreEvent {
    ElicitationRequested(ElicitationEntryId),
    ElicitationResponded(ElicitationEntryId),
    ElicitationUpdated(ElicitationEntryId),
}

#[derive(Default)]
pub struct ElicitationStore {
    elicitations: Vec<Elicitation>,
    events: Option<EventSink<ElicitationStoreEvent>>,
}

pub(crate) fn elicitation_status_for_response(
    response: &acp::CreateElicitationResponse,
) -> ElicitationStatus {
    match &response.action {
        acp::ElicitationAction::Accept(_) => ElicitationStatus::Accepted,
        acp::ElicitationAction::Decline => ElicitationStatus::Declined,
        acp::ElicitationAction::Cancel => ElicitationStatus::Canceled,
        _ => ElicitationStatus::Canceled,
    }
}

impl ElicitationStore {
    pub fn new(events: EventSink<ElicitationStoreEvent>) -> Self {
        Self {
            elicitations: Vec::new(),
            events: Some(events),
        }
    }

    pub fn elicitations(&self) -> &[Elicitation] {
        &self.elicitations
    }

    fn emit(&self, event: ElicitationStoreEvent) {
        if let Some(events) = &self.events {
            let _ = events.send(event);
        }
    }

    /// Rejects modes this client cannot render, and URLs it must not open.
    ///
    /// The URL check is a security boundary, not validation politeness: the
    /// client is about to hand this to the OS browser, and a `file://` or
    /// `javascript:` URL from an agent must never get that far.
    pub(crate) fn validate_request(
        request: &acp::CreateElicitationRequest,
    ) -> Result<(), acp::Error> {
        match &request.mode {
            acp::ElicitationMode::Form(_) => {}
            acp::ElicitationMode::Url(mode) => {
                let url = url::Url::parse(&mode.url)
                    .map_err(|_| acp::Error::invalid_params().data("invalid elicitation URL"))?;
                if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
                    return Err(acp::Error::invalid_params()
                        .data("elicitation URL must use HTTP or HTTPS and include a host"));
                }
            }
            _ => {
                return Err(acp::Error::invalid_params().data("unsupported elicitation mode"));
            }
        }

        Ok(())
    }

    pub(crate) fn insert_pending_elicitation(
        &mut self,
        request: acp::CreateElicitationRequest,
    ) -> (
        ElicitationEntryId,
        oneshot::Receiver<acp::CreateElicitationResponse>,
    ) {
        let (respond_tx, response_rx) = oneshot::channel();
        let id = ElicitationEntryId(Uuid::new_v4().to_string().into());
        self.elicitations.push(Elicitation {
            id: id.clone(),
            request,
            status: ElicitationStatus::Pending { respond_tx },
        });
        (id, response_rx)
    }

    /// The waiter handed back to the caller.
    ///
    /// Zed spawns this as a GPUI `Task` that emits on completion; here it is a
    /// plain future the caller awaits. A dropped sender resolves to `Cancel`
    /// rather than an error, so an agent waiting on `elicitation/create` is
    /// never left hanging by a store that went away.
    pub(crate) async fn response_future<E: Send + 'static>(
        id: ElicitationEntryId,
        response_rx: oneshot::Receiver<acp::CreateElicitationResponse>,
        events: Option<EventSink<E>>,
        responded: impl FnOnce(ElicitationEntryId) -> E + Send + 'static,
    ) -> acp::CreateElicitationResponse {
        let response = response_rx
            .await
            .unwrap_or_else(|_| acp::CreateElicitationResponse::new(acp::ElicitationAction::Cancel));
        if let Some(events) = events {
            let _ = events.send(responded(id));
        }
        response
    }

    pub(crate) fn respond_to_elicitation_entry(
        elicitation: &mut Elicitation,
        response: acp::CreateElicitationResponse,
    ) -> bool {
        if !matches!(elicitation.status, ElicitationStatus::Pending { .. }) {
            return false;
        }
        let ElicitationStatus::Pending { respond_tx } = mem::replace(
            &mut elicitation.status,
            elicitation_status_for_response(&response),
        ) else {
            return false;
        };
        respond_tx.send(response).ok();
        true
    }

    pub(crate) fn complete_url_elicitation_entry(elicitation: &mut Elicitation) -> bool {
        let previous_status = mem::replace(&mut elicitation.status, ElicitationStatus::Completed);
        match previous_status {
            ElicitationStatus::Accepted => true,
            previous_status @ (ElicitationStatus::Pending { .. }
            | ElicitationStatus::Declined
            | ElicitationStatus::Canceled
            | ElicitationStatus::Completed) => {
                elicitation.status = previous_status;
                false
            }
        }
    }

    pub(crate) fn cancel_elicitation_entry(
        elicitation: &mut Elicitation,
        cancel_accepted_url_elicitations: bool,
    ) -> bool {
        match mem::replace(&mut elicitation.status, ElicitationStatus::Canceled) {
            ElicitationStatus::Pending { respond_tx } => {
                respond_tx
                    .send(acp::CreateElicitationResponse::new(
                        acp::ElicitationAction::Cancel,
                    ))
                    .ok();
                true
            }
            ElicitationStatus::Accepted
                if cancel_accepted_url_elicitations
                    && matches!(&elicitation.request.mode, acp::ElicitationMode::Url(_)) =>
            {
                true
            }
            previous_status => {
                elicitation.status = previous_status;
                false
            }
        }
    }

    pub(crate) fn respond_to_elicitation_by_id(
        &mut self,
        id: &ElicitationEntryId,
        response: acp::CreateElicitationResponse,
    ) -> bool {
        let Some((_, elicitation)) = self.elicitation_mut(id) else {
            return false;
        };
        Self::respond_to_elicitation_entry(elicitation, response)
    }

    pub(crate) fn complete_url_elicitation_by_id(&mut self, id: &ElicitationEntryId) -> bool {
        let Some((_, elicitation)) = self.elicitation_mut(id) else {
            return false;
        };
        Self::complete_url_elicitation_entry(elicitation)
    }

    pub(crate) fn cancel_elicitation_by_id(
        &mut self,
        id: &ElicitationEntryId,
        cancel_accepted_url_elicitations: bool,
    ) -> bool {
        let Some((_, elicitation)) = self.elicitation_mut(id) else {
            return false;
        };
        Self::cancel_elicitation_entry(elicitation, cancel_accepted_url_elicitations)
    }

    pub fn request_elicitation(
        &mut self,
        request: acp::CreateElicitationRequest,
    ) -> Result<
        (
            ElicitationEntryId,
            impl std::future::Future<Output = acp::CreateElicitationResponse> + Send,
        ),
        acp::Error,
    > {
        Self::validate_request(&request)?;
        self.reject_duplicate_url_elicitation(&request)?;
        let (id, response_rx) = self.insert_pending_elicitation(request);
        self.emit(ElicitationStoreEvent::ElicitationRequested(id.clone()));

        let future = Self::response_future(
            id.clone(),
            response_rx,
            self.events.clone(),
            ElicitationStoreEvent::ElicitationResponded,
        );

        Ok((id, future))
    }

    pub fn respond_to_elicitation(
        &mut self,
        id: &ElicitationEntryId,
        response: acp::CreateElicitationResponse,
    ) {
        if !self.respond_to_elicitation_by_id(id, response) {
            return;
        }
        self.emit(ElicitationStoreEvent::ElicitationUpdated(id.clone()));
    }

    pub fn complete_url_elicitation(&mut self, elicitation_id: &acp::ElicitationId) {
        let Some(entry_id) = self.entry_id_for_url_elicitation(elicitation_id) else {
            return;
        };
        if !self.complete_url_elicitation_by_id(&entry_id) {
            return;
        }
        self.emit(ElicitationStoreEvent::ElicitationUpdated(entry_id));
    }

    pub fn cancel_elicitation(&mut self, id: &ElicitationEntryId) {
        if !self.cancel_elicitation_by_id(id, true) {
            return;
        }
        self.emit(ElicitationStoreEvent::ElicitationUpdated(id.clone()));
    }

    pub fn cancel_all(&mut self) {
        for id in self.cancel_pending(|_| true) {
            self.emit(ElicitationStoreEvent::ElicitationUpdated(id));
        }
    }

    pub fn clear(&mut self) {
        let canceled_ids = self.cancel_pending(|_| true);
        self.elicitations.clear();
        for id in canceled_ids {
            self.emit(ElicitationStoreEvent::ElicitationUpdated(id));
        }
    }

    /// Drops answered entries, keeping anything still outstanding.
    ///
    /// An *accepted URL* elicitation counts as outstanding: the user has been
    /// sent to a browser and the agent has not seen the round trip finish yet.
    pub fn clear_resolved(&mut self) -> Vec<ElicitationEntryId> {
        let mut cleared_ids = Vec::new();
        self.elicitations.retain(|elicitation| {
            let keep = matches!(
                (&elicitation.status, &elicitation.request.mode),
                (ElicitationStatus::Pending { .. }, _)
                    | (ElicitationStatus::Accepted, acp::ElicitationMode::Url(_))
            );
            if !keep {
                cleared_ids.push(elicitation.id.clone());
            }
            keep
        });

        for id in &cleared_ids {
            self.emit(ElicitationStoreEvent::ElicitationUpdated(id.clone()));
        }

        cleared_ids
    }

    /// Cancels every elicitation scoped to one in-flight JSON-RPC request —
    /// what happens when an auth attempt is abandoned.
    pub fn cancel_request(&mut self, request_id: &acp::RequestId) {
        let canceled_ids = self.cancel_pending(|elicitation| {
            matches!(
                elicitation.request.scope(),
                acp::ElicitationScope::Request(scope) if &scope.request_id == request_id
            )
        });
        for id in canceled_ids {
            self.emit(ElicitationStoreEvent::ElicitationUpdated(id));
        }
    }

    pub fn elicitation(&self, id: &ElicitationEntryId) -> Option<(usize, &Elicitation)> {
        self.elicitations
            .iter()
            .enumerate()
            .rev()
            .find_map(|(index, elicitation)| {
                (&elicitation.id == id).then_some((index, elicitation))
            })
    }

    /// A URL elicitation id the agent is already using for an outstanding
    /// elicitation is refused rather than accepted as a second entry.
    ///
    /// [`Self::entry_id_for_url_elicitation`] resolves an agent-supplied
    /// `elicitation_id` by reverse-scanning, so with a duplicate the newest
    /// entry wins every lookup and the older one can never be completed — it is
    /// stuck `Accepted`, which [`Self::clear_resolved`] deliberately keeps, so
    /// the stale row stays on screen for the life of the session. The schema
    /// documents the field as unique; nothing enforced it.
    ///
    /// Scoped to entries that are still outstanding on purpose. A device-code
    /// login legitimately reuses an id after the previous attempt was canceled
    /// or completed, and refusing that would break the retry.
    fn reject_duplicate_url_elicitation(
        &self,
        request: &acp::CreateElicitationRequest,
    ) -> Result<(), acp::Error> {
        let acp::ElicitationMode::Url(mode) = &request.mode else {
            return Ok(());
        };
        let clashes = self.elicitations.iter().any(|elicitation| {
            matches!(
                (&elicitation.status, &elicitation.request.mode),
                (
                    ElicitationStatus::Pending { .. } | ElicitationStatus::Accepted,
                    acp::ElicitationMode::Url(existing),
                ) if existing.elicitation_id == mode.elicitation_id
            )
        });
        if clashes {
            return Err(acp::Error::invalid_params()
                .data("elicitationId is already outstanding for another URL elicitation"));
        }
        Ok(())
    }

    pub(crate) fn entry_id_for_url_elicitation(
        &self,
        elicitation_id: &acp::ElicitationId,
    ) -> Option<ElicitationEntryId> {
        self.elicitations.iter().rev().find_map(|elicitation| {
            if let acp::ElicitationMode::Url(mode) = &elicitation.request.mode {
                if &mode.elicitation_id == elicitation_id {
                    return Some(elicitation.id.clone());
                }
            }
            None
        })
    }

    fn elicitation_mut(&mut self, id: &ElicitationEntryId) -> Option<(usize, &mut Elicitation)> {
        self.elicitations
            .iter_mut()
            .enumerate()
            .rev()
            .find_map(|(index, elicitation)| {
                (&elicitation.id == id).then_some((index, elicitation))
            })
    }

    pub(crate) fn cancel_pending(
        &mut self,
        mut should_cancel: impl FnMut(&Elicitation) -> bool,
    ) -> Vec<ElicitationEntryId> {
        let mut canceled_ids = Vec::new();
        for elicitation in &mut self.elicitations {
            if should_cancel(elicitation) && Self::cancel_elicitation_entry(elicitation, true) {
                canceled_ids.push(elicitation.id.clone());
            }
        }
        canceled_ids
    }
}
