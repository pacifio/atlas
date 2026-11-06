//! Ask before quitting while an agent is mid-turn (`confirmQuitWhileRunning`).
//!
//! Quitting stops every running turn, so a ⌘Q aimed at another window must not
//! cost an hour of agent work. Rust can stop the exit but cannot tell a running
//! turn from an idle chat — the frontend's chat store can. So:
//!
//! 1. A user quit (`ExitRequested` with no exit code: ⌘Q, the menu's Quit), or
//!    closing the main window, which ends Atlas too, is held while the setting
//!    is on, the window is up, and the frontend has said it is listening.
//!    Atlas emits [`QUIT_REQUESTED_EVENT`].
//! 2. The frontend answers at once when nothing is running, and otherwise asks
//!    the user; either way it calls [`quit_guard_answer`].
//! 3. A second quit while the question is open quits anyway. That is also the
//!    way out if the frontend never answers.
//!
//! A programmatic exit (`app.exit`, a restart for an update) carries a code
//! and is never held.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::state::AtlasConfigHandle;

pub const QUIT_REQUESTED_EVENT: &str = "atlas:quit-requested";

#[derive(Default)]
pub struct QuitGuardState {
    /// The frontend's listener is installed, so a held quit gets an answer.
    ready: AtomicBool,
    /// A question is open; the next quit goes through.
    asking: AtomicBool,
}

/// Whether to hold this user quit. `true` means the caller prevents the exit
/// and the frontend has been asked.
pub fn hold_quit(app: &AppHandle) -> bool {
    let Some(guard) = app.try_state::<QuitGuardState>() else {
        return false;
    };
    let enabled = app
        .try_state::<AtlasConfigHandle>()
        .is_some_and(|config| config.lock().effective().confirm_quit_while_running);
    // With the window gone there is nobody to ask: closing the last window
    // already ended the frontend.
    let window_up = app.get_webview_window("main").is_some();
    if !enabled || !window_up || !guard.ready.load(Ordering::SeqCst) {
        return false;
    }
    // The second quit while asking: let it through.
    if guard.asking.swap(true, Ordering::SeqCst) {
        return false;
    }
    if app.emit(QUIT_REQUESTED_EVENT, ()).is_err() {
        guard.asking.store(false, Ordering::SeqCst);
        return false;
    }
    true
}

/// The frontend's listener is installed.
#[tauri::command]
pub fn quit_guard_ready(guard: State<'_, QuitGuardState>) {
    guard.ready.store(true, Ordering::SeqCst);
}

/// The answer to [`QUIT_REQUESTED_EVENT`]: quit now, or stay.
#[tauri::command]
pub fn quit_guard_answer(app: AppHandle, guard: State<'_, QuitGuardState>, quit: bool) {
    guard.asking.store(false, Ordering::SeqCst);
    if quit {
        app.exit(0);
    }
}
