//! Continue the turns a restart cut short.
//!
//! Atlas records each running turn on disk (`agent_host::open_turns`). A quit,
//! a crash or a restart to update leaves the running ones there; at the next
//! launch this sweep opens each of those sessions and tells its agent to carry
//! on, with a row in the transcript saying so. It goes through the same wake
//! path a pull request watch uses (`AgentHost::wake`): the session is opened
//! the way the sidebar would open it, and the prompt counts as Atlas's, not
//! the user's.
//!
//! A turn is left alone when:
//!
//! - `continueSessionsAfterRestart` is off;
//! - its session is settled or snoozed, or gone from history;
//! - it has already been continued [`MAX_CONTINUATIONS`] times in a row: a
//!   turn that keeps taking Atlas down with it must not do so forever.
//!
//! Every recorded turn is taken off the record at launch either way, so one
//! that is let go is not offered again.

use std::sync::Arc;
use std::time::Duration;

use atlas_thread_metadata::ThreadMetadata;
use tauri::{AppHandle, Manager};

use super::agent_host::{AgentHost, OpenTurn, PendingWake, WakeSource};
use crate::state::AtlasConfigHandle;

/// What the agent is told.
pub const CONTINUE_PROMPT: &str =
    "Atlas restarted while you were working. Continue where you left off.";

/// The transcript row's headline.
const SUMMARY: &str = "Atlas restarted and resumed this turn";

/// Continuations in a row before a turn is let go.
const MAX_CONTINUATIONS: u32 = 3;

/// How long after launch the sweep starts: the window and the sidebar come
/// up first, and the agents start behind them.
const LAUNCH_DELAY: Duration = Duration::from_secs(3);

/// Whether a turn left open by the last run is continued.
fn should_continue(thread: Option<&ThreadMetadata>, turn: &OpenTurn) -> bool {
    turn.continuations < MAX_CONTINUATIONS
        && thread.is_some_and(|thread| !thread.is_settled() && !thread.is_snoozed())
}

/// Once per launch, after wakes are wired up (`pull_request_watch::start`).
pub fn start(app: &AppHandle, host: Arc<AgentHost>) {
    let left = host.take_left_open_turns();
    if left.is_empty() {
        return;
    }
    let enabled = app
        .try_state::<AtlasConfigHandle>()
        .is_some_and(|config| config.lock().effective().continue_sessions_after_restart);
    if !enabled {
        tracing::info!(
            turns = left.len(),
            "not continuing turns cut short by the restart"
        );
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(LAUNCH_DELAY).await;
        for (thread_id, turn) in left {
            let thread = host
                .history()
                .and_then(|history| history.store().thread(thread_id));
            if !should_continue(thread.as_ref(), &turn) {
                tracing::info!(%thread_id, continuations = turn.continuations, "letting a cut-short turn go");
                continue;
            }
            host.expect_continuation(thread_id, turn.continuations + 1);
            let host = host.clone();
            tauri::async_runtime::spawn(async move {
                let wake = PendingWake {
                    source: WakeSource::Restart,
                    thread_id,
                    text: CONTINUE_PROMPT.to_owned(),
                    summary: SUMMARY.to_owned(),
                };
                if let Err(e) = host.wake(wake).await {
                    // Its next turn is the user's own, not a continuation.
                    host.expect_continuation(thread_id, 0);
                    tracing::warn!(%thread_id, error = %e, "could not continue a turn cut short by the restart");
                }
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use atlas_acp_thread::connection::AgentId;
    use atlas_thread_metadata::{PathList, ThreadId};
    use chrono::Utc;

    fn turn(continuations: u32) -> OpenTurn {
        OpenTurn {
            started_at: Utc::now(),
            continuations,
        }
    }

    fn thread() -> ThreadMetadata {
        ThreadMetadata::new(
            ThreadId::new(),
            AgentId::new("atlas-agent"),
            PathList::new(&[std::path::PathBuf::from("/work")]),
        )
    }

    #[test]
    fn a_live_session_continues_until_the_limit() {
        let live = thread();
        assert!(should_continue(Some(&live), &turn(0)));
        assert!(should_continue(Some(&live), &turn(MAX_CONTINUATIONS - 1)));
        assert!(!should_continue(Some(&live), &turn(MAX_CONTINUATIONS)));
    }

    #[test]
    fn settled_snoozed_or_deleted_sessions_are_let_go() {
        let mut settled = thread();
        settled.settled_at = Some(Utc::now());
        let mut snoozed = thread();
        snoozed.snoozed_until = Some(Utc::now());
        assert!(!should_continue(Some(&settled), &turn(0)));
        assert!(!should_continue(Some(&snoozed), &turn(0)));
        assert!(!should_continue(None, &turn(0)));
    }
}
