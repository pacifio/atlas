//! The unified agent-connection trait and its optional-capability sub-traits.

use std::sync::Arc;

use async_trait::async_trait;
use atlas_acp::{AuthMethodWire, PermissionDecision, Result, SessionId};
use uuid::Uuid;

/// One live agent connection — a native Cersei runtime handle, or one ACP
/// subprocess. The session actor drives every turn through this trait and never
/// sees whether it's talking to an in-process agent or a subprocess.
///
/// Streamed content does not flow through the return value: the actor owns the
/// event stream (via the host's event routing) and finalizes the turn from it.
/// `prompt` returns the canonical snake_case stop-reason token ("end_turn",
/// "max_tokens", "cancelled", …) for the actor's own bookkeeping — the UI is
/// finalized when the actor drains the last streamed event, then this token.
#[async_trait]
pub trait AgentConnection: Send + Sync {
    /// Drive one prompt turn to completion; returns the stop-reason token.
    async fn prompt(&self, session: SessionId, text: String) -> Result<String>;

    /// Re-arm the session lifecycle guard before a new turn (clears a prior
    /// cancel so this turn's events flow). Returns the new turn epoch — the
    /// identity the backend will stamp onto this turn's events, which the
    /// actor matches to drop stale-turn stragglers.
    fn mark_turn_started(&self, session: &SessionId) -> Result<u64>;

    /// Cancel the in-flight turn. The turn's own terminal event still flows
    /// through the stream (stop_reason = "cancelled").
    fn cancel(&self, session: SessionId) -> Result<()>;

    /// Resolve a permission request the agent raised earlier.
    fn respond_permission(&self, request_id: Uuid, decision: PermissionDecision) -> Result<()>;

    /// Resolve every permission request still pending for the session as
    /// cancelled and return their ids. Called by the actor when a turn
    /// finalizes so no permission modal survives its turn. Default: none.
    fn sweep_permissions(&self, _session: &SessionId) -> Vec<Uuid> {
        Vec::new()
    }

    // ── Optional capabilities (Zed pattern: query once, have it or don't) ──────

    fn model_selector(&self) -> Option<Arc<dyn ModelSelector>> {
        None
    }
    fn session_modes(&self) -> Option<Arc<dyn SessionModes>> {
        None
    }
    fn session_config_options(&self) -> Option<Arc<dyn SessionConfigOptions>> {
        None
    }
    fn effort_control(&self) -> Option<Arc<dyn EffortControl>> {
        None
    }
    fn compression(&self) -> Option<Arc<dyn CompressionCtl>> {
        None
    }
    fn auth(&self) -> Option<Arc<dyn AuthFlow>> {
        None
    }
}

/// Select the session's model. ACP → `session/set_model` (or config option);
/// native → applied to the next turn.
#[async_trait]
pub trait ModelSelector: Send + Sync {
    async fn select(&self, session: &SessionId, model_id: String) -> Result<()>;
}

/// Switch the session's permission/interaction mode.
#[async_trait]
pub trait SessionModes: Send + Sync {
    async fn set(&self, session: &SessionId, mode_id: String) -> Result<()>;
}

/// Set one of the agent's advertised `session/set_config_option` values.
///
/// This is ACP's GENERAL settings mechanism — modes and models are just two
/// well-known option ids, and an agent may advertise any number of others
/// (reasoning effort, thinking budget, sandbox policy…). Zed's equivalent is
/// `AgentSessionConfigOptions`, and like Zed we treat the option list the
/// agent publishes as authoritative rather than enumerating ids ourselves.
#[async_trait::async_trait]
pub trait SessionConfigOptions: Send + Sync {
    async fn set(&self, session: &SessionId, option_id: String, value: serde_json::Value)
    -> Result<()>;
}

/// Set the reasoning-effort / thinking-budget level (native agent only today).
pub trait EffortControl: Send + Sync {
    fn set(&self, session: &SessionId, effort: String) -> Result<()>;
}

/// Toggle tool-output compression (native agent only today).
pub trait CompressionCtl: Send + Sync {
    fn set(&self, session: &SessionId, on: bool) -> Result<()>;
}

/// The agent's authentication flow (ACP agents only).
#[async_trait]
pub trait AuthFlow: Send + Sync {
    fn methods(&self) -> Vec<AuthMethodWire>;
    async fn authenticate(&self, method_id: String) -> Result<()>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// A connection with no optional capabilities — verifies the defaults.
    struct Bare;
    #[async_trait]
    impl AgentConnection for Bare {
        async fn prompt(&self, _s: SessionId, _t: String) -> Result<String> {
            Ok("end_turn".into())
        }
        fn mark_turn_started(&self, _s: &SessionId) -> Result<u64> {
            Ok(1)
        }
        fn cancel(&self, _s: SessionId) -> Result<()> {
            Ok(())
        }
        fn respond_permission(&self, _r: Uuid, _d: PermissionDecision) -> Result<()> {
            Ok(())
        }
    }

    struct Model(Arc<AtomicU64>);
    #[async_trait]
    impl ModelSelector for Model {
        async fn select(&self, _s: &SessionId, _m: String) -> Result<()> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    /// A connection that advertises model selection.
    struct WithModel(Arc<AtomicU64>);
    #[async_trait]
    impl AgentConnection for WithModel {
        async fn prompt(&self, _s: SessionId, _t: String) -> Result<String> {
            Ok("end_turn".into())
        }
        fn mark_turn_started(&self, _s: &SessionId) -> Result<u64> {
            Ok(1)
        }
        fn cancel(&self, _s: SessionId) -> Result<()> {
            Ok(())
        }
        fn respond_permission(&self, _r: Uuid, _d: PermissionDecision) -> Result<()> {
            Ok(())
        }
        fn model_selector(&self) -> Option<Arc<dyn ModelSelector>> {
            Some(Arc::new(Model(self.0.clone())))
        }
    }

    #[tokio::test]
    async fn defaults_report_no_capabilities() {
        let c = Bare;
        assert!(c.model_selector().is_none());
        assert!(c.session_modes().is_none());
        assert!(c.effort_control().is_none());
        assert!(c.compression().is_none());
        assert!(c.auth().is_none());
        assert_eq!(c.prompt(SessionId::new("s"), "hi".into()).await.unwrap(), "end_turn");
    }

    #[tokio::test]
    async fn advertised_capability_is_usable() {
        let hits = Arc::new(AtomicU64::new(0));
        let c = WithModel(hits.clone());
        let sel = c.model_selector().expect("model selector advertised");
        sel.select(&SessionId::new("s"), "opus".into()).await.unwrap();
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }
}
