//! A model that says exactly what a test tells it to.
//!
//! The turn loop, the tools, the permission policy and the whole event stream
//! are the real ones; only the thing on the other side of the network is not.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use cersei::provider::{
    CompletionRequest, CompletionStream, Provider, ProviderCapabilities,
};
use cersei::types::{Result as CerseiResult, StopReason, StreamEvent, Usage};

/// One scripted model response.
#[derive(Clone)]
pub struct Response {
    pub events: Vec<StreamEvent>,
}

impl Response {
    /// Plain assistant text, then end of turn.
    pub fn text(text: &str) -> Self {
        Self {
            events: vec![
                StreamEvent::MessageStart {
                    id: "msg-1".into(),
                    model: "scripted".into(),
                },
                StreamEvent::ContentBlockStart {
                    index: 0,
                    block_type: "text".into(),
                    id: None,
                    name: None,
                },
                StreamEvent::TextDelta {
                    index: 0,
                    text: text.into(),
                },
                StreamEvent::ContentBlockStop { index: 0 },
                StreamEvent::MessageDelta {
                    stop_reason: Some(StopReason::EndTurn),
                    usage: Some(Usage {
                        input_tokens: 11,
                        output_tokens: 7,
                        ..Default::default()
                    }),
                },
                StreamEvent::MessageStop,
            ],
        }
    }

    /// A single tool call, then end of turn.
    pub fn tool_call(id: &str, name: &str, input: serde_json::Value) -> Self {
        Self {
            events: vec![
                StreamEvent::MessageStart {
                    id: "msg-1".into(),
                    model: "scripted".into(),
                },
                StreamEvent::ContentBlockStart {
                    index: 0,
                    block_type: "tool_use".into(),
                    id: Some(id.into()),
                    name: Some(name.into()),
                },
                StreamEvent::InputJsonDelta {
                    index: 0,
                    partial_json: input.to_string(),
                },
                StreamEvent::ContentBlockStop { index: 0 },
                StreamEvent::MessageDelta {
                    stop_reason: Some(StopReason::ToolUse),
                    usage: None,
                },
                StreamEvent::MessageStop,
            ],
        }
    }
}

/// Plays one scripted [`Response`] per request, in order; the last one repeats
/// so a loop that asks once more than expected still terminates.
pub struct ScriptedProvider {
    responses: Mutex<std::collections::VecDeque<Response>>,
    last: Mutex<Response>,
}

impl ScriptedProvider {
    pub fn new(responses: Vec<Response>) -> Self {
        let last = responses
            .last()
            .cloned()
            .unwrap_or_else(|| Response::text(""));
        Self {
            responses: Mutex::new(responses.into()),
            last: Mutex::new(last),
        }
    }

    pub fn factory(responses: Vec<Response>) -> atlas_cersei::ProviderFactoryOverride {
        let responses = Arc::new(responses);
        Arc::new(move || Box::new(ScriptedProvider::new((*responses).clone())))
    }
}

#[async_trait]
impl Provider for ScriptedProvider {
    fn name(&self) -> &str {
        "scripted"
    }

    fn context_window(&self, _model: &str) -> u64 {
        200_000
    }

    fn capabilities(&self, _model: &str) -> ProviderCapabilities {
        ProviderCapabilities {
            streaming: true,
            tool_use: true,
            vision: false,
            thinking: false,
            system_prompt: true,
            caching: false,
        }
    }

    async fn complete(&self, _request: CompletionRequest) -> CerseiResult<CompletionStream> {
        let response = {
            let mut queue = self.responses.lock().unwrap();
            match queue.pop_front() {
                Some(response) => {
                    *self.last.lock().unwrap() = response.clone();
                    response
                }
                None => self.last.lock().unwrap().clone(),
            }
        };

        let (tx, rx) = tokio::sync::mpsc::channel(response.events.len().max(1));
        for event in response.events {
            tx.send(event).await.ok();
        }
        Ok(CompletionStream::new(rx))
    }
}
