//! Guard for renderer-directed save destinations.
//!
//! A handful of commands (`comms_save_recording`, `comms_save_attachment`,
//! `mission_control_write_file`) take an absolute `dest` from the renderer
//! and write bytes there. The path comes from a native save dialog in the
//! honest case — but the command cannot see the dialog, only the string, so
//! a compromised renderer could name `~/.ssh/authorized_keys` or a shell
//! profile and turn "save a recording" into persistence.
//!
//! This is a DENY-list of catastrophic targets rather than an allow-list of
//! nice ones, on purpose: a save dialog can legitimately point anywhere the
//! user manages (external drives included), and enumerating "allowed"
//! locations would break real saves. What it refuses:
//!
//!   - relative paths (a dialog always answers absolute),
//!   - any dot-directory under `$HOME` (`~/.ssh`, `~/.aws`, `~/.zshrc`,
//!     `~/.atlas`, …) — user-visible saves live in visible folders,
//!   - `~/Library` (keychains, LaunchAgents, app containers),
//!   - system roots (`/etc`, `/usr`, `/bin`, `/sbin`, `/var`, `/System`,
//!     `/Library`, `/Applications`, `/private/etc`).

use std::path::{Component, Path};

pub fn guard_save_dest(dest: &str) -> Result<(), String> {
    let path = Path::new(dest);
    if !path.is_absolute() {
        return Err("save destination must be an absolute path".into());
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("save destination must not contain '..'".into());
    }

    const SYSTEM_ROOTS: &[&str] = &[
        "/etc",
        "/usr",
        "/bin",
        "/sbin",
        "/var",
        "/System",
        "/Library",
        "/Applications",
        "/private/etc",
        "/private/var",
    ];
    for root in SYSTEM_ROOTS {
        if path.starts_with(root) {
            return Err(format!("refusing to write under {root}"));
        }
    }

    if let Some(home) = dirs::home_dir() {
        if let Ok(rel) = path.strip_prefix(&home) {
            let mut components = rel.components();
            if let Some(Component::Normal(first)) = components.next() {
                let first = first.to_string_lossy();
                if first.starts_with('.') {
                    return Err("refusing to write into a hidden directory in your home".into());
                }
                if first == "Library" {
                    return Err("refusing to write into ~/Library".into());
                }
            } else {
                // `dest == $HOME` itself, or something stranger. Refuse.
                return Err("refusing to overwrite your home directory".into());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::guard_save_dest;

    #[test]
    fn ordinary_save_targets_pass() {
        let home = dirs::home_dir().unwrap();
        for p in ["Downloads/track.webm", "Desktop/a.png", "Documents/x/y.pdf"] {
            let dest = home.join(p);
            assert!(guard_save_dest(&dest.to_string_lossy()).is_ok(), "{p}");
        }
        assert!(guard_save_dest("/tmp/scratch.bin").is_ok());
    }

    #[test]
    fn persistence_targets_are_refused() {
        let home = dirs::home_dir().unwrap();
        for p in [
            ".ssh/authorized_keys",
            ".zshrc",
            ".aws/credentials",
            ".atlas/auth/atlas-session.json",
            "Library/LaunchAgents/evil.plist",
            "Library/Keychains/login.keychain-db",
        ] {
            let dest = home.join(p);
            assert!(guard_save_dest(&dest.to_string_lossy()).is_err(), "{p}");
        }
        for p in ["/etc/pam.d/sudo", "/usr/local/bin/git", "relative/path.txt"] {
            assert!(guard_save_dest(p).is_err(), "{p}");
        }
    }
}
