//! Whether a session request is handed the code tool server.
//!
//! The memory tool server's offer ([`MemorySessionOffers`]) makes the
//! decision for every Atlas service, because they all ride one token; this
//! is the code half of it.
//!
//! [`MemorySessionOffers`]: crate::commands::memory_server::MemorySessionOffers

use super::CodeToolsGate;

/// Whether one session request is handed the code tool server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodeOfferDecision {
    Included,
    /// Left out, and why.
    Omitted(&'static str),
}

impl CodeOfferDecision {
    /// Included for any agent a transport reaches (`reachable`: HTTP in
    /// process, the stdio bridge otherwise; ADR-0020), while the user lets
    /// agents use the code tools and the server is running. Not decided by
    /// the shared-memory toggle, nor by which agent it is.
    pub fn decide(reachable: bool, enabled: bool, server_running: bool) -> Self {
        if !reachable {
            Self::Omitted("no transport reaches the agent")
        } else if !enabled {
            Self::Omitted("code tools are off in Settings")
        } else if !server_running {
            Self::Omitted("code tool server is not running")
        } else {
            Self::Included
        }
    }

    /// The one log line per session request.
    pub fn log_line(self, agent: &str, http_mcp: bool) -> String {
        let head = format!("code tool server offer: agent={agent} http_mcp={http_mcp}");
        match self {
            Self::Included => format!("{head} code_server=included"),
            Self::Omitted(reason) => format!("{head} code_server=omitted reason=\"{reason}\""),
        }
    }
}

/// The code half of a session offer: the setting it consults.
#[derive(Clone)]
pub struct CodeOffer {
    gate: CodeToolsGate,
}

impl CodeOffer {
    pub fn new(gate: CodeToolsGate) -> Self {
        Self { gate }
    }

    /// Decide for one request; the setting is read only when it can matter.
    pub fn decide(&self, reachable: bool, server_running: bool) -> CodeOfferDecision {
        let enabled = reachable && (self.gate)();
        CodeOfferDecision::decide(reachable, enabled, server_running)
    }
}
