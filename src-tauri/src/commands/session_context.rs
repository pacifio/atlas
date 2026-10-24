//! What the session context overlay needs that no other command answers:
//! the name of the machine a session runs on.
//!
//! Every Atlas session runs on this machine today (the thread row's
//! `remote_connection` slot is reserved and unread), so the environment is
//! the local host, named the way the user knows it: the short host name,
//! without the `.local` mDNS suffix macOS appends.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEnvironment {
    /// `m4-pro`, `DESKTOP-1234`. Empty when the system would not say.
    pub name: String,
    /// `local` today; a remote environment would name its own kind.
    pub kind: &'static str,
}

#[tauri::command]
pub async fn session_environment() -> Result<SessionEnvironment, String> {
    Ok(SessionEnvironment {
        name: short_host_name(&raw_host_name()),
        kind: "local",
    })
}

#[cfg(unix)]
fn raw_host_name() -> String {
    let mut buf = [0u8; 256];
    // SAFETY: the buffer is valid for `buf.len()` bytes and `gethostname`
    // writes at most that many; the result is read only up to its NUL.
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) };
    if rc != 0 {
        return String::new();
    }
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..end]).into_owned()
}

#[cfg(not(unix))]
fn raw_host_name() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_default()
}

/// The first label: `m4-pro.local` → `m4-pro`, `box.corp.example` → `box`.
fn short_host_name(raw: &str) -> String {
    raw.trim().split('.').next().unwrap_or_default().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_host_name_is_its_first_label() {
        assert_eq!(short_host_name("m4-pro.local"), "m4-pro");
        assert_eq!(short_host_name("box.corp.example\n"), "box");
        assert_eq!(short_host_name("plain"), "plain");
        assert_eq!(short_host_name(""), "");
    }
}
