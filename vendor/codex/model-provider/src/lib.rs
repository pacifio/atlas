// Modified by Atlas from upstream OpenAI Codex (Apache-2.0). See CONTEXT.md.
#[cfg(feature = "aws")]
mod amazon_bedrock;
mod auth;
mod bearer_auth_provider;
mod models_endpoint;
mod provider;

#[cfg(feature = "aws")]
pub use amazon_bedrock::is_supported_amazon_bedrock_region;
/// Without the `aws` feature (Atlas fork default) no Bedrock region is
/// supported; the app-server's Bedrock sign-in path reports it as such.
#[cfg(not(feature = "aws"))]
pub fn is_supported_amazon_bedrock_region(_region: &str) -> bool {
    false
}
pub use auth::AgentIdentitySessionFallback;
pub use auth::ProviderAuthScope;
pub use auth::ResolvedProviderAuth;
pub use auth::auth_provider_from_auth;
pub use auth::auth_provider_from_auth_manager;
pub use auth::unauthenticated_auth_provider;
pub use bearer_auth_provider::BearerAuthProvider;
pub use bearer_auth_provider::BearerAuthProvider as CoreAuthProvider;
pub use codex_model_provider_info::AMAZON_BEDROCK_PROVIDER_ID;
pub use codex_model_provider_info::AMAZON_BEDROCK_RUNTIME_PROVIDER_ID;
pub use codex_model_provider_info::CHATGPT_CODEX_BASE_URL;
pub use codex_protocol::account::ProviderAccount;
pub use provider::ModelProvider;
pub use provider::ModelProviderFuture;
pub use provider::ProviderAccountError;
pub use provider::ProviderAccountResult;
pub use provider::ProviderAccountState;
pub use provider::ProviderCapabilities;
pub use provider::RemoteCompactionSupport;
pub use provider::SharedModelProvider;
pub use provider::create_model_provider;
