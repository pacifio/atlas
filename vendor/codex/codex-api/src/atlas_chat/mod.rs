// Modified by Atlas from upstream OpenAI Codex (Apache-2.0). See CONTEXT.md.
//! The OpenAI Chat Completions dialect, against the Atlas gateway (spec D3).
//!
//! Added by Atlas. This is the only genuinely new engine code in the port: the
//! engine speaks exactly one wire format, and Chat Completions was *removed*
//! upstream rather than never built, so there is nothing here to resurrect.
//!
//! Three pieces, and they only work together:
//!
//! - [`request`] builds a body carrying nothing the gateway would refuse, with
//!   an explicit `max_tokens`;
//! - [`sse`] reads the reply, whose success sentinel is `data: [DONE]` and
//!   whose failures arrive in-stream;
//! - [`crate::atlas_gateway`] decides what an error means, which is what keeps
//!   a filled spend cap from being retried against for weeks.
//!
//! The engine's internal item and event vocabulary is untouched: everything
//! here lands on the same `ResponseItem`/`ResponseEvent` types the Responses
//! dialect produces, which is what lets the turn loop, resumption and history
//! stay exactly as they are.

pub mod org;
pub mod request;
pub mod sse;

pub use request::BuiltChatRequest;
pub use request::ChatCompletionsRequest;
pub use request::ChatRequestInput;
pub use request::DEFAULT_MAX_OUTPUT_TOKENS;
pub use request::OUTPUT_TOKEN_CLAMP;
pub use request::build_chat_request;
pub use request::is_claude_model;
pub use sse::ChatDialect;
pub use sse::spawn_chat_stream;
