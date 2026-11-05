//! Whether a session request is handed the UI tool server.
//!
//! The memory tool server's offer ([`MemorySessionOffers`]) makes the
//! decision for both services, because both ride one token (see the module
//! doc); this is the UI half of it.
//!
//! [`MemorySessionOffers`]: crate::commands::memory_server::MemorySessionOffers

use super::NavigationGate;

/// Whether one session request is handed the UI tool server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UiOfferDecision {
    Included,
    /// Left out, and why.
    Omitted(&'static str),
}

impl UiOfferDecision {
    /// Included only for a connection that carries UI control, speaks HTTP
    /// MCP, while the user lets the agent act on the window and the server is
    /// running. Never decided by which agent it is.
    pub fn decide(
        http_mcp: bool,
        ui_control: bool,
        navigation_on: bool,
        server_running: bool,
    ) -> Self {
        if !http_mcp {
            Self::Omitted("agent did not advertise mcpCapabilities.http")
        } else if !ui_control {
            Self::Omitted("connection does not carry UI control")
        } else if !navigation_on {
            Self::Omitted("agent navigation is off in Settings")
        } else if !server_running {
            Self::Omitted("ui tool server is not running")
        } else {
            Self::Included
        }
    }

    /// The one log line per session request.
    pub fn log_line(self, agent: &str, http_mcp: bool, ui_control: bool) -> String {
        let head = format!(
            "ui tool server offer: agent={agent} http_mcp={http_mcp} ui_control={ui_control}"
        );
        match self {
            Self::Included => format!("{head} ui_server=included"),
            Self::Omitted(reason) => format!("{head} ui_server=omitted reason=\"{reason}\""),
        }
    }
}

/// The UI half of a session offer: the navigation setting it consults.
#[derive(Clone)]
pub struct UiOffer {
    gate: NavigationGate,
}

impl UiOffer {
    pub fn new(gate: NavigationGate) -> Self {
        Self { gate }
    }

    /// Decide for one request; the setting is read only when it can matter.
    pub fn decide(
        &self,
        http_mcp: bool,
        ui_control: bool,
        cwd: &str,
        server_running: bool,
    ) -> UiOfferDecision {
        let navigation_on = http_mcp && ui_control && (self.gate)(cwd);
        UiOfferDecision::decide(http_mcp, ui_control, navigation_on, server_running)
    }
}
