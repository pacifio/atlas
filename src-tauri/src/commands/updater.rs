//! In-app auto-updater — platform dispatch.
//!
//! Atlas ships as an Apple-signed + notarized + stapled `.dmg` (no Tauri-updater
//! `.app.tar.gz`/minisign artifact), so we don't use the Tauri updater plugin.
//! That flow ([`updater_macos`]) only makes sense on macOS — mounting a DMG,
//! `codesign`/`spctl` verification, and swapping an `.app` bundle have no
//! Windows/Linux equivalent — so it's compiled in only there.
//!
//! Every other platform gets [`updater_stub`], a no-op with the same public
//! API, so `lib.rs` and the frontend's `invoke()` surface stay
//! platform-agnostic: the four commands still exist and return a well-formed
//! "nothing to do" response rather than failing to compile.
//!
//! Note this module is *only* the `#[cfg]` switch — see `updater_macos.rs` for
//! the staged-update design, the event contract (`atlas:update-*`), and the
//! Team-ID signature anchor.

#[cfg(target_os = "macos")]
#[path = "updater_macos.rs"]
mod imp;

#[cfg(not(target_os = "macos"))]
#[path = "updater_stub.rs"]
mod imp;

pub use imp::*;
