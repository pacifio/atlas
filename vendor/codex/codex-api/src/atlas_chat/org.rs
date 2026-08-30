// Modified by Atlas from upstream OpenAI Codex (Apache-2.0). See CONTEXT.md.
//! The paying organisation, on every gateway request.
//!
//! The gateway's `Atlas-Org` header names **who pays** (`docs/reference/
//! atlas-ai-api.md` §3.1). It is optional in the contract and load-bearing in
//! practice: omitted, the request is attributed to the caller *personally* —
//! and the grant that admits a request belongs to the payer, so an account
//! whose AI access comes through its organisation is refused
//! `403 no_entitlement` on every turn while its org sits fully entitled. The
//! org is never inferred server-side, because the payer is a billing decision.
//!
//! # Resolved per request, like the token
//!
//! The active organisation is app state the user can switch at any moment. A
//! header baked into provider config at connect time would bill the *old* org
//! for as long as the session lives — or start failing `403 org_not_covered`
//! after a token re-mint stops covering it. So the source is a callback, read
//! on each request, mirroring the D10 token provider's shape exactly.
//!
//! # Why a registration in a vendored crate
//!
//! The header has to be attached where the request is built, which is here;
//! the org lives in Atlas's auth state, which this crate must not depend on.
//! The same inversion `ExternalAuth` uses for the token, in miniature.

use std::sync::Arc;
use std::sync::RwLock;

/// Answers "which org pays right now?" — `None` means personal attribution.
pub type OrgSource = Arc<dyn Fn() -> Option<String> + Send + Sync>;

static ORG_SOURCE: RwLock<Option<OrgSource>> = RwLock::new(None);

/// Installs the host's org source. A later call replaces the earlier one,
/// which is also what lets each test bring its own.
pub fn set_org_source(source: OrgSource) {
    *ORG_SOURCE.write().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(source);
}

/// The paying org for a request being built now, if the host declared one.
pub fn current_org() -> Option<String> {
    let source = ORG_SOURCE
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()?;
    // An empty id is no org: sending `Atlas-Org:` with nothing in it is a
    // malformed header, not a personal request.
    source().filter(|org| !org.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_source_means_personal_attribution() {
        // Not an error: a caller with no org grant is the contract's
        // `org_none` case, and the header is simply absent.
        *ORG_SOURCE.write().unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        assert_eq!(current_org(), None);
    }

    #[test]
    fn the_source_is_consulted_per_call_so_an_org_switch_takes_effect() {
        // The whole reason this is a callback and not a config value: the user
        // can switch org mid-session, and the *next* request must bill the new
        // one.
        let org = Arc::new(std::sync::Mutex::new(Some("org_a".to_string())));
        let reader = org.clone();
        set_org_source(Arc::new(move || {
            reader.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
        }));
        assert_eq!(current_org().as_deref(), Some("org_a"));

        *org.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some("org_b".to_string());
        assert_eq!(current_org().as_deref(), Some("org_b"));
    }

    #[test]
    fn an_empty_org_id_is_absent_rather_than_a_malformed_header() {
        set_org_source(Arc::new(|| Some(String::new())));
        assert_eq!(current_org(), None);
    }
}
