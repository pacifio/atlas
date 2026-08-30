// Modified by Atlas from upstream OpenAI Codex (Apache-2.0). See CONTEXT.md.
use crate::events::AppServerRpcTransport;
use crate::events::GuardianReviewAnalyticsResult;
use crate::events::GuardianReviewTrackContext;
use crate::events::current_runtime_metadata;
use crate::facts::AnalyticsFact;
use crate::facts::AnalyticsJsonRpcError;
use crate::facts::AppInvocation;
use crate::facts::AppMentionedInput;
use crate::facts::AppUsedInput;
use crate::facts::ArtifactOperation;
use crate::facts::ArtifactOperationInput;
use crate::facts::CodexGoalEvent;
use crate::facts::CustomAnalyticsFact;
use crate::facts::ExternalAgentConfigImportCompletedInput;
use crate::facts::ExternalAgentConfigImportFailureInput;
use crate::facts::HookRunFact;
use crate::facts::HookRunInput;
use crate::facts::ImagePreparationFact;
use crate::facts::PluginInstallFailedInput;
use crate::facts::PluginInstallRequested;
use crate::facts::PluginInstallRequestedInput;
use crate::facts::PluginInstallSource;
use crate::facts::PluginMeasurementsInput;
use crate::facts::PluginState;
use crate::facts::PluginStateChangedInput;
use crate::facts::SkillInvocation;
use crate::facts::SkillInvokedInput;
use crate::facts::SubAgentThreadStartedInput;
use crate::facts::TrackEventsContext;
use crate::facts::TurnCodexErrorFact;
use crate::facts::TurnProfileFact;
use crate::facts::TurnResolvedConfigFact;
use crate::facts::TurnTokenUsageFact;
use crate::now_unix_millis;
use crate::reducer::AnalyticsReducer;
use crate::reducer::MAX_PLUGIN_MEASUREMENTS_PER_BATCH;
use crate::reducer::valid_plugin_measurement_identifier;
use crate::reducer::valid_plugin_measurement_row;
use codex_app_server_protocol::ClientRequest;
use codex_app_server_protocol::ClientResponsePayload;
use codex_app_server_protocol::InitializeParams;
use codex_app_server_protocol::JSONRPCErrorError;
use codex_app_server_protocol::RequestId;
use codex_app_server_protocol::ServerNotification;
use codex_app_server_protocol::ServerRequest;
use codex_app_server_protocol::ServerResponse;
use codex_login::AuthManager;
use codex_plugin::PluginId;
use codex_plugin::PluginTelemetryMetadata;
use codex_protocol::request_permissions::RequestPermissionsResponse;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::sync::oneshot;

const ANALYTICS_EVENTS_QUEUE_SIZE: usize = 256;
// Covers two sequential POSTs plus queue/barrier scheduling; additional queued sends remain best-effort.
const ANALYTICS_EVENTS_FLUSH_TIMEOUT: Duration = Duration::from_secs(25);
const ANALYTICS_EVENT_DEDUPE_MAX_KEYS: usize = 4096;

pub(crate) enum AnalyticsEventsQueueMessage {
    Fact(Box<AnalyticsFact>),
    Flush(oneshot::Sender<()>),
}

#[derive(Clone)]
pub(crate) struct AnalyticsEventsQueue {
    pub(crate) sender: mpsc::Sender<AnalyticsEventsQueueMessage>,
    pub(crate) app_used_emitted_keys: Arc<Mutex<HashSet<(String, String)>>>,
    pub(crate) plugin_used_emitted_keys: Arc<Mutex<HashSet<(String, String)>>>,
}

#[derive(Clone)]
pub struct AnalyticsEventsClient {
    queue: Option<AnalyticsEventsQueue>,
}

// Upstream put an `AnalyticsEventsDestination` here, resolving a ChatGPT-backend
// analytics ingestion path off `chatgpt_base_url` — constructed for every
// session, on unless config turned it off, and sending a subset of events even
// under plain API-key auth. That destination, the POST that used it, the batch
// splitter, and the debug capture-file sink are all removed (#43, spec D2).
//
// The queue below is kept and still reduces facts, because the reduction logic
// is what the 79 tests in `analytics_client_tests.rs` cover and it is local,
// cheap, and harmless. What changed is that its output is dropped instead of
// uploaded: there is no sink, no URL, and no HTTP client left in this crate.
// Deleting the reduction pipeline itself is Phase 5 slimming, not D2.

impl AnalyticsEventsQueue {
    fn new() -> Self {
        let (sender, mut receiver) = mpsc::channel(ANALYTICS_EVENTS_QUEUE_SIZE);
        tokio::spawn(async move {
            let mut reducer = AnalyticsReducer::default();
            while let Some(input) = receiver.recv().await {
                let input = match input {
                    AnalyticsEventsQueueMessage::Fact(input) => *input,
                    AnalyticsEventsQueueMessage::Flush(done_tx) => {
                        let mut events = Vec::new();
                        reducer.flush(&mut events);
                        drop(events);
                        let _ = done_tx.send(());
                        continue;
                    }
                };
                let mut events = Vec::new();
                reducer.ingest(input, &mut events).await;
                // Reduced and dropped. This is where the upload used to be.
                drop(events);
            }
        });
        Self {
            sender,
            app_used_emitted_keys: Arc::new(Mutex::new(HashSet::new())),
            plugin_used_emitted_keys: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    fn try_send(&self, input: AnalyticsFact) {
        if self
            .sender
            .try_send(AnalyticsEventsQueueMessage::Fact(Box::new(input)))
            .is_err()
        {
            //TODO: add a metric for this
            tracing::warn!("dropping analytics events: queue is full");
        }
    }

    pub(crate) fn should_enqueue_app_used(
        &self,
        tracking: &TrackEventsContext,
        app: &AppInvocation,
    ) -> bool {
        let Some(connector_id) = app.connector_id.as_ref() else {
            return true;
        };
        let mut emitted = self
            .app_used_emitted_keys
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if emitted.len() >= ANALYTICS_EVENT_DEDUPE_MAX_KEYS {
            emitted.clear();
        }
        emitted.insert((tracking.turn_id.clone(), connector_id.clone()))
    }

    pub(crate) fn should_enqueue_plugin_used(
        &self,
        tracking: &TrackEventsContext,
        plugin: &PluginTelemetryMetadata,
    ) -> bool {
        let mut emitted = self
            .plugin_used_emitted_keys
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if emitted.len() >= ANALYTICS_EVENT_DEDUPE_MAX_KEYS {
            emitted.clear();
        }
        let Some(plugin_id) = plugin
            .plugin_id
            .as_ref()
            .map(PluginId::as_key)
            .or_else(|| plugin.remote_plugin_id.clone())
        else {
            return true;
        };
        emitted.insert((tracking.turn_id.clone(), plugin_id))
    }
}

impl AnalyticsEventsClient {
    /// Signature preserved so `codex-core` compiles unchanged; the auth manager
    /// and base URL are now unused, because nothing is uploaded (#43, spec D2).
    pub fn new(
        _auth_manager: Arc<AuthManager>,
        _base_url: String,
        analytics_enabled: Option<bool>,
    ) -> Self {
        Self {
            queue: (analytics_enabled != Some(false)).then(AnalyticsEventsQueue::new),
        }
    }

    pub fn disabled() -> Self {
        Self { queue: None }
    }

    pub async fn flush(&self) {
        let Some(queue) = self.queue.as_ref() else {
            return;
        };
        let (done_tx, done_rx) = oneshot::channel();
        let flushed = tokio::time::timeout(ANALYTICS_EVENTS_FLUSH_TIMEOUT, async {
            if queue
                .sender
                .send(AnalyticsEventsQueueMessage::Flush(done_tx))
                .await
                .is_err()
            {
                return false;
            }
            done_rx.await.is_ok()
        })
        .await;

        if !matches!(flushed, Ok(true)) {
            tracing::warn!("timed out or failed while flushing analytics events");
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.queue.is_some()
    }

    pub fn track_plugin_measurements(&self, mut input: PluginMeasurementsInput) {
        if input.rows.is_empty()
            || input.rows.len() > MAX_PLUGIN_MEASUREMENTS_PER_BATCH
            || !valid_plugin_measurement_identifier(&input.operation)
        {
            return;
        }
        input.rows.retain(valid_plugin_measurement_row);
        if input.rows.is_empty() {
            return;
        }
        self.record_fact(AnalyticsFact::Custom(
            CustomAnalyticsFact::PluginMeasurements(input),
        ));
    }

    pub fn track_skill_invocations(
        &self,
        tracking: TrackEventsContext,
        invocations: Vec<SkillInvocation>,
    ) {
        if invocations.is_empty() {
            return;
        }
        self.record_fact(AnalyticsFact::Custom(CustomAnalyticsFact::SkillInvoked(
            SkillInvokedInput {
                tracking,
                invocations,
            },
        )));
    }

    pub fn track_artifact_operation(
        &self,
        tracking: TrackEventsContext,
        operation: ArtifactOperation,
    ) {
        self.record_fact(AnalyticsFact::Custom(
            CustomAnalyticsFact::ArtifactOperation(ArtifactOperationInput {
                tracking,
                operation,
            }),
        ));
    }

    pub fn track_initialize(
        &self,
        connection_id: u64,
        params: InitializeParams,
        product_client_id: String,
        rpc_transport: AppServerRpcTransport,
    ) {
        self.record_fact(AnalyticsFact::Initialize {
            connection_id,
            params,
            product_client_id,
            runtime: current_runtime_metadata(),
            rpc_transport,
        });
    }

    pub fn track_subagent_thread_started(&self, input: SubAgentThreadStartedInput) {
        self.record_fact(AnalyticsFact::Custom(
            CustomAnalyticsFact::SubAgentThreadStarted(input),
        ));
    }

    pub fn track_code_mode_tool_call(&self, input: crate::facts::CodeModeToolCallFact) {
        self.record_fact(AnalyticsFact::Custom(
            CustomAnalyticsFact::CodeModeToolCall(input),
        ));
    }

    pub fn track_guardian_review(
        &self,
        tracking: &GuardianReviewTrackContext,
        result: GuardianReviewAnalyticsResult,
        completed_at_ms: u64,
    ) {
        self.record_fact(AnalyticsFact::Custom(CustomAnalyticsFact::GuardianReview(
            Box::new(tracking.event_params(result, completed_at_ms)),
        )));
    }

    pub fn track_app_mentioned(&self, tracking: TrackEventsContext, mentions: Vec<AppInvocation>) {
        if mentions.is_empty() {
            return;
        }
        self.record_fact(AnalyticsFact::Custom(CustomAnalyticsFact::AppMentioned(
            AppMentionedInput { tracking, mentions },
        )));
    }

    pub fn track_request(
        &self,
        connection_id: u64,
        request_id: RequestId,
        request: &ClientRequest,
    ) {
        if let ClientRequest::TurnInterrupt { params, .. } = request {
            if params.turn_id.is_empty() {
                return;
            }
            self.record_fact(AnalyticsFact::ExplicitClientInterruptRequest {
                connection_id,
                request_id,
                turn_id: params.turn_id.clone(),
                requested_at_ms: now_unix_millis(),
            });
            return;
        }
        if !matches!(
            request,
            ClientRequest::TurnStart { .. } | ClientRequest::TurnSteer { .. }
        ) {
            return;
        }
        self.record_fact(AnalyticsFact::ClientRequest {
            connection_id,
            request_id,
            request: Box::new(request.clone()),
        });
    }

    pub fn track_app_used(&self, tracking: TrackEventsContext, app: AppInvocation) {
        let Some(queue) = self.queue.as_ref() else {
            return;
        };
        if !queue.should_enqueue_app_used(&tracking, &app) {
            return;
        }
        self.record_fact(AnalyticsFact::Custom(CustomAnalyticsFact::AppUsed(
            AppUsedInput { tracking, app },
        )));
    }

    pub fn track_hook_run(&self, tracking: TrackEventsContext, hook: HookRunFact) {
        self.record_fact(AnalyticsFact::Custom(CustomAnalyticsFact::HookRun(
            HookRunInput { tracking, hook },
        )));
    }

    pub fn track_plugin_used(&self, tracking: TrackEventsContext, plugin: PluginTelemetryMetadata) {
        let Some(queue) = self.queue.as_ref() else {
            return;
        };
        if !queue.should_enqueue_plugin_used(&tracking, &plugin) {
            return;
        }
        self.record_fact(AnalyticsFact::Custom(CustomAnalyticsFact::PluginUsed(
            crate::facts::PluginUsedInput { tracking, plugin },
        )));
    }

    pub fn track_plugin_install_requested(
        &self,
        tracking: TrackEventsContext,
        request: PluginInstallRequested,
    ) {
        self.record_fact(AnalyticsFact::Custom(
            CustomAnalyticsFact::PluginInstallRequested(PluginInstallRequestedInput {
                tracking,
                request,
            }),
        ));
    }

    pub fn track_compaction(&self, event: crate::facts::CodexCompactionEvent) {
        self.record_fact(AnalyticsFact::Custom(CustomAnalyticsFact::Compaction(
            Box::new(event),
        )));
    }

    pub fn track_goal_event(&self, event: CodexGoalEvent) {
        self.record_fact(AnalyticsFact::Custom(CustomAnalyticsFact::Goal(Box::new(
            event,
        ))));
    }

    pub fn track_image_preparation(&self, fact: ImagePreparationFact) {
        self.record_fact(AnalyticsFact::Custom(
            CustomAnalyticsFact::ImagePreparation(Box::new(fact)),
        ));
    }

    pub fn track_turn_resolved_config(&self, fact: TurnResolvedConfigFact) {
        self.record_fact(AnalyticsFact::Custom(
            CustomAnalyticsFact::TurnResolvedConfig(Box::new(fact)),
        ));
    }

    pub fn track_turn_token_usage(&self, fact: TurnTokenUsageFact) {
        self.record_fact(AnalyticsFact::Custom(CustomAnalyticsFact::TurnTokenUsage(
            Box::new(fact),
        )));
    }

    pub fn track_turn_profile(&self, fact: TurnProfileFact) {
        self.record_fact(AnalyticsFact::Custom(CustomAnalyticsFact::TurnProfile(
            Box::new(fact),
        )));
    }

    pub fn track_turn_codex_error(&self, fact: TurnCodexErrorFact) {
        self.record_fact(AnalyticsFact::Custom(CustomAnalyticsFact::TurnCodexError(
            Box::new(fact),
        )));
    }

    pub fn track_plugin_installed(&self, plugin: PluginTelemetryMetadata) {
        self.record_fact(AnalyticsFact::Custom(
            CustomAnalyticsFact::PluginStateChanged(PluginStateChangedInput {
                plugin,
                state: PluginState::Installed,
            }),
        ));
    }

    pub fn track_plugin_install_failed(
        &self,
        plugin: PluginTelemetryMetadata,
        source: PluginInstallSource,
        error_type: String,
        sub_error_type: Option<String>,
    ) {
        self.record_fact(AnalyticsFact::Custom(
            CustomAnalyticsFact::PluginInstallFailed(PluginInstallFailedInput {
                plugin,
                source,
                error_type,
                sub_error_type,
            }),
        ));
    }

    pub fn track_external_agent_config_import_completed(
        &self,
        input: ExternalAgentConfigImportCompletedInput,
    ) {
        self.record_fact(AnalyticsFact::Custom(
            CustomAnalyticsFact::ExternalAgentConfigImportCompleted(input),
        ));
    }

    pub fn track_external_agent_config_import_failure(
        &self,
        input: ExternalAgentConfigImportFailureInput,
    ) {
        self.record_fact(AnalyticsFact::Custom(
            CustomAnalyticsFact::ExternalAgentConfigImportFailure(input),
        ));
    }

    pub fn track_plugin_uninstalled(&self, plugin: PluginTelemetryMetadata) {
        self.record_fact(AnalyticsFact::Custom(
            CustomAnalyticsFact::PluginStateChanged(PluginStateChangedInput {
                plugin,
                state: PluginState::Uninstalled,
            }),
        ));
    }

    pub fn track_plugin_enabled(&self, plugin: PluginTelemetryMetadata) {
        self.record_fact(AnalyticsFact::Custom(
            CustomAnalyticsFact::PluginStateChanged(PluginStateChangedInput {
                plugin,
                state: PluginState::Enabled,
            }),
        ));
    }

    pub fn track_plugin_disabled(&self, plugin: PluginTelemetryMetadata) {
        self.record_fact(AnalyticsFact::Custom(
            CustomAnalyticsFact::PluginStateChanged(PluginStateChangedInput {
                plugin,
                state: PluginState::Disabled,
            }),
        ));
    }

    pub(crate) fn record_fact(&self, input: AnalyticsFact) {
        if let Some(queue) = self.queue.as_ref() {
            queue.try_send(input);
        }
    }

    pub fn track_response(
        &self,
        connection_id: u64,
        request_id: RequestId,
        response: &ClientResponsePayload,
    ) {
        self.track_response_inner(
            connection_id,
            request_id,
            response,
            /*thread_originator*/ None,
        );
    }

    pub fn track_response_with_thread_originator(
        &self,
        connection_id: u64,
        request_id: RequestId,
        response: &ClientResponsePayload,
        thread_originator: String,
    ) {
        self.track_response_inner(connection_id, request_id, response, Some(thread_originator));
    }

    fn track_response_inner(
        &self,
        connection_id: u64,
        request_id: RequestId,
        response: &ClientResponsePayload,
        thread_originator: Option<String>,
    ) {
        if !matches!(
            response,
            ClientResponsePayload::ThreadStart(_)
                | ClientResponsePayload::ThreadResume(_)
                | ClientResponsePayload::ThreadFork(_)
                | ClientResponsePayload::TurnStart(_)
                | ClientResponsePayload::TurnSteer(_)
                | ClientResponsePayload::TurnInterrupt(_)
        ) {
            return;
        }
        if serde_json::to_writer(std::io::sink(), response).is_err() {
            return;
        }
        self.record_fact(AnalyticsFact::ClientResponse {
            connection_id,
            request_id,
            response: Box::new(response.clone()),
            thread_originator,
        });
    }

    pub fn track_error_response(
        &self,
        connection_id: u64,
        request_id: RequestId,
        error: JSONRPCErrorError,
        error_type: Option<AnalyticsJsonRpcError>,
    ) {
        self.record_fact(AnalyticsFact::ErrorResponse {
            connection_id,
            request_id,
            error,
            error_type,
        });
    }

    pub fn track_server_request(&self, connection_id: u64, request: ServerRequest) {
        self.record_fact(AnalyticsFact::ServerRequest {
            connection_id,
            request: Box::new(request),
        });
    }

    pub fn track_server_response(&self, completed_at_ms: u64, response: ServerResponse) {
        self.record_fact(AnalyticsFact::ServerResponse {
            completed_at_ms,
            response: Box::new(response),
        });
    }

    pub fn track_effective_permissions_approval_response(
        &self,
        completed_at_ms: u64,
        request_id: RequestId,
        response: RequestPermissionsResponse,
    ) {
        self.record_fact(AnalyticsFact::EffectivePermissionsApprovalResponse {
            completed_at_ms,
            request_id,
            response: Box::new(response),
        });
    }

    pub fn track_server_request_aborted(&self, completed_at_ms: u64, request_id: RequestId) {
        self.record_fact(AnalyticsFact::ServerRequestAborted {
            completed_at_ms,
            request_id,
        });
    }

    /// Records analytics-relevant notifications without cloning ignored variants.
    pub fn track_notification(&self, notification: &ServerNotification) {
        if !matches!(
            notification,
            ServerNotification::ThreadArchived(_)
                | ServerNotification::ThreadClosed(_)
                | ServerNotification::ThreadUnarchived(_)
                | ServerNotification::TurnStarted(_)
                | ServerNotification::TurnCompleted(_)
                | ServerNotification::TurnDiffUpdated(_)
                | ServerNotification::ItemStarted(_)
                | ServerNotification::ItemCompleted(_)
                | ServerNotification::ItemGuardianApprovalReviewStarted(_)
                | ServerNotification::ItemGuardianApprovalReviewCompleted(_)
        ) {
            return;
        }
        self.record_fact(AnalyticsFact::Notification(Box::new(notification.clone())));
    }
}
