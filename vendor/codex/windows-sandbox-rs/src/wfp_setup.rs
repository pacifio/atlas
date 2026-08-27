use crate::install_wfp_filters_for_account;
use std::panic;

// Upstream emitted WFP setup success/failure counters from this helper, and
// **only** over the built-in Statsig route — the parent process passed the
// resolved Statsig environment down through the elevation payload, and the
// comment on the old `build_wfp_metrics_provider` said other exporters were
// "intentionally omitted from this helper path".
//
// That made this a third phone-home site, independent of core's default
// exporter and of the analytics client: an elevated helper reporting firewall
// setup outcomes to a hardcoded endpoint. #43 (spec D2) removes the route, so
// the emission has nothing left to reach and is gone with it. The outcomes are
// still reported — through the `log` callback the caller already supplies,
// which stays on the machine.

fn panic_payload_to_string(panic_payload: Box<dyn std::any::Any + Send>) -> String {
    match panic_payload.downcast::<String>() {
        Ok(message) => *message,
        Err(panic_payload) => match panic_payload.downcast::<&'static str>() {
            Ok(message) => (*message).to_string(),
            Err(_) => "unknown panic payload".to_string(),
        },
    }
}

pub fn install_wfp_filters<F>(offline_username: &str, mut log: F)
where
    F: FnMut(&str),
{
    match panic::catch_unwind(panic::AssertUnwindSafe(|| {
        install_wfp_filters_for_account(offline_username)
    })) {
        Ok(Ok(installed_filter_count)) => {
            log(&format!(
                "WFP setup succeeded for {offline_username} with {installed_filter_count} installed filters"
            ));
        }
        Ok(Err(err)) => {
            let error = err.to_string();
            log(&format!(
                "WFP setup failed for {offline_username}: {error}; continuing elevated setup"
            ));
        }
        Err(panic_payload) => {
            let error = panic_payload_to_string(panic_payload);
            log(&format!(
                "WFP setup panicked for {offline_username}: {error}; continuing elevated setup"
            ));
        }
    }
}
