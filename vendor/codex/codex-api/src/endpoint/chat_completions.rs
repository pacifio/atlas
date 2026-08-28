// Modified by Atlas from upstream OpenAI Codex (Apache-2.0). See CONTEXT.md.
//! `POST {AI}/chat/completions` against the Atlas gateway (spec D3).
//!
//! Added by Atlas. The sibling `responses` client posts to a different path,
//! serialises a different body and hands the reply to a machine that cannot
//! read this wire, so none of it is reusable — but the plumbing around it (the
//! endpoint session, auth-per-request, telemetry, retry policy) is shared
//! wholesale, which is why this file is short.

use std::sync::Arc;
use std::time::Duration;

use codex_client::EncodedJsonBody;
use codex_client::HttpTransport;
use http::HeaderMap;
use http::HeaderValue;
use http::Method;
use tracing::instrument;

use crate::atlas_chat::request::ChatCompletionsRequest;
use crate::atlas_chat::sse::ChatDialect;
use crate::atlas_chat::sse::spawn_chat_stream;
use crate::auth::SharedAuthProvider;
use crate::common::ResponseStream;
use crate::endpoint::session::EndpointSession;
use crate::error::ApiError;
use crate::provider::Provider;
use crate::telemetry::SseTelemetry;

pub struct ChatCompletionsClient<T: HttpTransport> {
    session: EndpointSession<T>,
    sse_telemetry: Option<Arc<dyn SseTelemetry>>,
}

impl<T: HttpTransport> ChatCompletionsClient<T> {
    pub fn new(transport: T, provider: Provider, auth: SharedAuthProvider) -> Self {
        Self {
            session: EndpointSession::new(transport, provider, auth),
            sse_telemetry: None,
        }
    }

    pub fn with_telemetry(
        self,
        request: Option<Arc<dyn codex_client::RequestTelemetry>>,
        sse: Option<Arc<dyn SseTelemetry>>,
    ) -> Self {
        Self {
            session: self.session.with_request_telemetry(request),
            sse_telemetry: sse,
        }
    }

    fn path() -> &'static str {
        "chat/completions"
    }

    fn idle_timeout(&self) -> Duration {
        self.session.provider().stream_idle_timeout
    }

    #[instrument(
        name = "chat_completions.stream_request",
        level = "info",
        skip_all,
        fields(transport = "chat_http", http.method = "POST", api.path = "chat/completions")
    )]
    pub async fn stream_request(
        &self,
        request: ChatCompletionsRequest,
        extra_headers: HeaderMap,
        dialect: ChatDialect,
    ) -> Result<ResponseStream, ApiError> {
        let body = EncodedJsonBody::encode(&request).map_err(|err| {
            ApiError::Stream(format!("failed to encode the chat request: {err}"))
        })?;

        let stream_response = self
            .session
            .stream_encoded_json_with(
                Method::POST,
                Self::path(),
                extra_headers,
                Some(body),
                |req| {
                    req.headers.insert(
                        http::header::ACCEPT,
                        HeaderValue::from_static("text/event-stream"),
                    );
                },
            )
            .await?;

        Ok(spawn_chat_stream(
            stream_response,
            self.idle_timeout(),
            self.sse_telemetry.clone(),
            dialect,
        ))
    }
}
