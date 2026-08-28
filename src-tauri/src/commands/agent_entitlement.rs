//! Does this account have AI access? (spec D15a, acceptance bar item 14)
//!
//! A signed-in user whose organisation has not been granted AI access is not
//! having a failure — they are having a **setup problem**, and the gateway says
//! so in as many words: `403 no_entitlement` is "a setup problem, not a
//! failure". Rendered as an error toast it reads as something broken, and the
//! user goes looking for a switch to flip. There is no such switch; an admin
//! has to grant it.
//!
//! # Why this is asked before a turn rather than learned from one
//!
//! The alternative is to classify the error that comes back from a prompt. That
//! works, and it is too late: the user has already typed a message, watched it
//! send and watched it fail. The gateway's `GET /models` is entitlement-filtered
//! — it answers with exactly the set `POST /chat/completions` will accept, or
//! `403` when there is no grant at all — so the question can be answered before
//! anyone types anything.
//!
//! # Unknown is not the same as no-grant
//!
//! Offline, a timeout, or a shape the gateway has never returned all mean "we
//! could not find out". Rendering those as "your account needs AI access" would
//! send a user to their admin over a dropped Wi-Fi connection. Only an explicit
//! `403` says no.

use serde::Deserialize;
use serde::Serialize;

/// What the gateway said about this account's AI access.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum Entitlement {
    /// The account may use the gateway. Carries the models it may select,
    /// which is the entitlement-filtered set rather than the whole catalogue.
    Entitled { models: Vec<String> },
    /// A definite no: signed in, and the organisation has no AI grant.
    NoGrant { message: String },
    /// We could not find out. Never rendered as a refusal.
    Unknown { reason: String },
}

/// The gateway's stock-OpenAI list shape.
#[derive(Debug, Deserialize)]
struct ModelList {
    #[serde(default)]
    data: Vec<ModelRow>,
}

#[derive(Debug, Deserialize)]
struct ModelRow {
    #[serde(default)]
    id: String,
}

#[derive(Debug, Default, Deserialize)]
struct GatewayEnvelope {
    error: Option<GatewayError>,
}

#[derive(Debug, Default, Deserialize)]
struct GatewayError {
    #[serde(default)]
    message: String,
    #[serde(default)]
    code: Option<String>,
}

/// The default words for a caller with no grant.
///
/// Phrased as the next action rather than the failure: "ask your admin" is the
/// only thing that resolves it, and a user who is told what is wrong without
/// being told who can fix it will go looking through their own settings.
const NO_GRANT_MESSAGE: &str = "Your account needs AI access — ask your admin to enable it.";

/// Reads the gateway's answer to `GET /models`.
///
/// Branches on `code`, as the gateway instructs, and falls back to the status
/// so a changed error shape cannot turn a refusal into a success.
pub fn classify(status: u16, body: &str) -> Entitlement {
    if status == 200 {
        return match serde_json::from_str::<ModelList>(body) {
            Ok(list) if !list.data.is_empty() => Entitlement::Entitled {
                models: list.data.into_iter().map(|row| row.id).collect(),
            },
            // A 200 carrying no models is not a grant, but it is not the
            // documented refusal either — the gateway answers a caller with no
            // grant with `403`, not an empty list. Saying "ask your admin" here
            // would be a guess.
            Ok(_) => Entitlement::Unknown {
                reason: "the gateway listed no models".to_string(),
            },
            Err(err) => Entitlement::Unknown {
                reason: format!("unreadable model list: {err}"),
            },
        };
    }

    let error = serde_json::from_str::<GatewayEnvelope>(body)
        .ok()
        .and_then(|envelope| envelope.error)
        .unwrap_or_default();
    let message = if error.message.trim().is_empty() {
        NO_GRANT_MESSAGE.to_string()
    } else {
        error.message.clone()
    };

    match (status, error.code.as_deref().unwrap_or_default()) {
        // The two the gateway defines for "this caller may not use AI at all".
        // `org_not_covered` is the payer-coverage check, which fails the same
        // way from the user's side: nothing they can do, an admin can.
        (403, "no_entitlement" | "org_not_covered") => Entitlement::NoGrant { message },
        // A 403 whose code we do not recognise. Still a refusal about access,
        // so still a setup problem rather than an error.
        (403, _) => Entitlement::NoGrant { message },
        // Signed in as far as Atlas knows, rejected by the gateway. That is a
        // credential problem, not a grant problem, and telling the user to ask
        // an admin would send them to the wrong person.
        (401, _) => Entitlement::Unknown {
            reason: format!("the gateway rejected the token: {message}"),
        },
        _ => Entitlement::Unknown {
            reason: format!("the gateway answered {status}: {message}"),
        },
    }
}

/// The words shown when there is no grant.
pub fn no_grant_message() -> &'static str {
    NO_GRANT_MESSAGE
}


/// Asks the gateway what this account may use.
///
/// One command with the switch inside rather than a `cfg`-gated pair: two
/// definitions of the same command name read as a duplicate registration to the
/// IPC contract guard, which cannot see that they are mutually exclusive.
#[tauri::command]
pub async fn native_agent_entitlement(
    state: tauri::State<'_, crate::commands::auth::AuthState>,
) -> Result<Entitlement, String> {
    // Unconditional since #54: the engine is the only native agent, so there is
    // always a gateway to ask. (The `ported-engine` branch this used to hide
    // behind was silently dead after the feature was deleted — a cfg on a
    // feature that no longer exists compiles to nothing — which made this
    // command answer Unknown forever and the no-grant pill unable to appear.)
    {
        let core = state.core();
        let token = match core.mint_access_token().await {
            Ok(token) => token,
            // No credential, or one the auth service would not honour. Either
            // way this says nothing about the AI grant.
            Err(err) => {
                return Ok(Entitlement::Unknown {
                    reason: format!("no account token: {err:?}"),
                });
            }
        };

        let url = format!(
            "{}/models",
            atlas_native_agent::engine::config::GATEWAY_BASE_URL.trim_end_matches('/'),
        );
        let mut request = reqwest::Client::new()
            .get(&url)
            .bearer_auth(&token)
            .timeout(std::time::Duration::from_secs(10));
        // The grant that filters this list belongs to the PAYER, not the user:
        // without the org header the gateway checks the caller's personal
        // grant, and an account whose access comes through its organisation
        // reads as having none — the pill would tell an entitled user to ask
        // their admin.
        if let crate::auth::AuthSnapshot::SignedIn {
            active_org_id: Some(org),
            ..
        } = core.snapshot()
        {
            request = request.header("atlas-org", org);
        }
        let response = match request.send().await {
            Ok(response) => response,
            Err(err) => {
                return Ok(Entitlement::Unknown {
                    reason: format!("could not reach the gateway: {err}"),
                });
            }
        };

        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        Ok(classify(status, &body))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_granted_account_gets_the_models_it_may_actually_select() {
        // The list is entitlement-filtered — exactly what `POST
        // /chat/completions` will accept — so it is worth keeping rather than
        // reducing to a yes/no.
        let body = r#"{"object":"list","data":[{"id":"claude-sonnet-4-6"},{"id":"gemini-3.6-flash"}]}"#;
        assert_eq!(
            classify(200, body),
            Entitlement::Entitled {
                models: vec!["claude-sonnet-4-6".to_string(), "gemini-3.6-flash".to_string()],
            },
        );
    }

    #[test]
    fn no_entitlement_is_a_setup_state_and_says_who_can_fix_it() {
        // Bar item 14. A user told what is wrong but not who can fix it goes
        // hunting through their own settings for a switch that does not exist.
        let body = r#"{"error":{"message":"No AI grant for this organisation.","type":"permission_error","code":"no_entitlement"}}"#;
        let Entitlement::NoGrant { message } = classify(403, body) else {
            panic!("403 no_entitlement must be a setup state");
        };
        assert_eq!(message, "No AI grant for this organisation.");
        assert!(no_grant_message().contains("admin"));
    }

    #[test]
    fn an_uncovered_org_reads_the_same_way_to_the_user() {
        // Different check, identical user experience: nothing they can do, an
        // admin can.
        let body = r#"{"error":{"message":"","code":"org_not_covered"}}"#;
        assert!(matches!(classify(403, body), Entitlement::NoGrant { .. }));
    }

    #[test]
    fn a_rejected_token_does_not_send_the_user_to_their_admin() {
        // A 401 is a credential problem, not a grant problem. Rendering it as
        // "ask your admin" points the user at the wrong person entirely.
        let body = r#"{"error":{"message":"token expired","code":"token_expired"}}"#;
        assert!(matches!(classify(401, body), Entitlement::Unknown { .. }));
    }

    #[test]
    fn not_knowing_is_never_rendered_as_a_refusal() {
        // Offline, a timeout, a 502 — all mean "could not find out". Telling a
        // user their account lacks access because their Wi-Fi dropped is worse
        // than telling them nothing.
        for (status, body) in [(502, "{}"), (500, ""), (200, "<html>")] {
            assert!(
                matches!(classify(status, body), Entitlement::Unknown { .. }),
                "{status} must not be reported as a missing grant",
            );
        }
    }

    #[test]
    fn a_body_that_is_not_the_expected_envelope_still_refuses_on_a_403() {
        // A gateway that changed its error shape must not turn a refusal into
        // an unexplained failure.
        assert!(matches!(
            classify(403, "<html>forbidden</html>"),
            Entitlement::NoGrant { .. },
        ));
    }

    #[test]
    fn an_empty_list_is_not_treated_as_a_missing_grant() {
        // The gateway refuses a caller with no grant with 403, not an empty
        // list — so an empty 200 is something else, and guessing would produce
        // the most confusing possible message.
        assert!(matches!(
            classify(200, r#"{"object":"list","data":[]}"#),
            Entitlement::Unknown { .. },
        ));
    }
}
