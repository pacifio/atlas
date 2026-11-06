//! The app binary's own command line: `--version` / `--help`, and a single
//! directory argument that opens as a project.
//!
//! The directory argument is the seam a terminal launcher calls into: a cold
//! start reads it through `cli_take_initial_project_path`, and a release
//! build's single-instance plugin forwards a second launch's argv to the
//! running window as `atlas:cli-open-project`.
//!
//! The app no longer installs a shell command of its own. It used to write a
//! bash helper to `~/.local/bin/atlas` (`atl` on Linux) on every launch; that
//! name now belongs to the standalone Atlas CLI, whose installer replaces any
//! copy an earlier release left behind.

use parking_lot::Mutex;
use tauri::State;

/// Per-process state holding a path passed on argv at
/// launch (e.g. `atlas ~/Desktop/foo` → `~/Desktop/foo`). Consumed
/// exactly once by `cli_take_initial_project_path` — after that the
/// frontend's normal hydration path takes over so a window reload
/// doesn't re-trigger the open.
#[derive(Default)]
pub struct CliLaunchState {
    initial: Mutex<Option<String>>,
}

impl CliLaunchState {
    pub fn new(initial: Option<String>) -> Self {
        Self {
            initial: Mutex::new(initial),
        }
    }
}

/// A flag the binary answers on the terminal instead of launching the app.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InfoFlag {
    Version,
    Help,
}

/// Recognise `--version` / `--help` (and their short forms) as the first
/// argument. `args` must already have the program name stripped.
///
/// The binary is launched directly from a terminal — the system package's
/// `/usr/bin` entry on Linux, or a terminal pointed at the app bundle. Without
/// this, `--version` fell through `parse_project_path` (a flag,
/// so no project) and booted a full window, which could then swallow later
/// launches as second-instance forwards.
pub fn parse_info_flag(args: &[String]) -> Option<InfoFlag> {
    match args.first().map(String::as_str) {
        Some("--version" | "-v" | "-V") => Some(InfoFlag::Version),
        Some("--help" | "-h") => Some(InfoFlag::Help),
        _ => None,
    }
}

/// What the binary prints for an [`InfoFlag`].
pub fn info_flag_text(flag: InfoFlag) -> String {
    match flag {
        InfoFlag::Version => format!("atlas {}", env!("CARGO_PKG_VERSION")),
        InfoFlag::Help => "\
Usage:
  atlas              open Atlas
  atlas <path>       open the directory <path> in Atlas
  atlas --version    print the version and exit
  atlas --help       print this message and exit"
            .to_string(),
    }
}

/// Answer `--version` / `--help` on stdout and report whether the process
/// should exit. Called first thing in `lib.rs::run()`, before Tauri, logging
/// or any profile directory is touched.
pub fn handle_info_flag() -> bool {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match parse_info_flag(&args) {
        Some(flag) => {
            println!("{}", info_flag_text(flag));
            true
        }
        None => false,
    }
}

/// Parse the process argv for a project path. Called once at startup
/// from `lib.rs::run()` before Tauri builds. Returns `Some(abs_path)`
/// when:
///   - exactly one positional arg after the executable
///   - the arg is an existing directory
///
/// Otherwise `None` — the app boots into its normal hydrated state.
///
/// We intentionally don't pull in `clap` for one positional arg.
pub fn parse_initial_project() -> Option<String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    tracing::info!(target: "atlas::cli", "launch argv (positional): {args:?}");
    parse_project_path(&args)
}

/// Resolve a single positional directory argument to a canonical path.
/// Shared by the cold-start path (`parse_initial_project`) and the
/// single-instance callback (which receives a forwarded argv). `args` must
/// already have the program name stripped. Returns `Some(abs_dir)` only when
/// there's exactly one positional, it isn't a flag, and it's an existing dir.
pub fn parse_project_path(args: &[String]) -> Option<String> {
    if args.len() != 1 {
        // Zero (a plain launch) or multiple args — refuse rather than guess.
        return None;
    }
    let raw = &args[0];
    if raw.starts_with('-') {
        return None;
    }
    let abs = dunce::canonicalize(raw).ok()?;
    if abs.is_dir() {
        Some(abs.to_string_lossy().into_owned())
    } else {
        None
    }
}

#[tauri::command]
pub fn cli_take_initial_project_path(state: State<'_, CliLaunchState>) -> Option<String> {
    state.initial.lock().take()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn version_and_help_flags_are_recognised() {
        for flag in ["--version", "-v", "-V"] {
            assert_eq!(parse_info_flag(&args(&[flag])), Some(InfoFlag::Version));
        }
        for flag in ["--help", "-h"] {
            assert_eq!(parse_info_flag(&args(&[flag])), Some(InfoFlag::Help));
        }
    }

    #[test]
    fn anything_else_is_left_to_the_normal_launch() {
        assert_eq!(parse_info_flag(&args(&[])), None);
        assert_eq!(parse_info_flag(&args(&["."])), None);
        assert_eq!(parse_info_flag(&args(&["./--version"])), None);
        assert_eq!(parse_info_flag(&args(&["--verbose"])), None);
        assert_eq!(parse_info_flag(&args(&["some-dir", "--version"])), None);
    }

    #[test]
    fn version_line_names_the_build() {
        assert_eq!(
            info_flag_text(InfoFlag::Version),
            format!("atlas {}", env!("CARGO_PKG_VERSION"))
        );
        assert!(info_flag_text(InfoFlag::Help).starts_with("Usage:\n"));
    }
}
