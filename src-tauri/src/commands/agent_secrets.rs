//! The OS keychain behind agent variables marked sensitive in Settings →
//! Agents. The installed map keeps only a sensitive variable's name; its value
//! is written here, read back only when the agent starts
//! ([`atlas_agent_store::SecretEnv`]), and never sent to the webview.
//!
//! One item per variable: service [`SERVICE`], account `<agent id>/<NAME>`.

use atlas_agent_store::SecretSource;

const SERVICE: &str = "Atlas agent variables";

fn entry(agent: &str, name: &str) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, &format!("{agent}/{name}"))
}

/// The store's view of the keychain.
pub struct Keychain;

impl SecretSource for Keychain {
    fn read(&self, agent: &str, name: &str) -> Option<String> {
        match entry(agent, name).and_then(|e| e.get_password()) {
            Ok(value) => Some(value),
            Err(keyring::Error::NoEntry) => None,
            Err(e) => {
                tracing::warn!(
                    target: "atlas::agents",
                    agent, name, "couldn't read a sensitive variable from the keychain: {e}"
                );
                None
            }
        }
    }
}

/// Store a value. Blocking: call it from `spawn_blocking`.
pub fn write(agent: &str, name: &str, value: &str) -> Result<(), String> {
    entry(agent, name)
        .and_then(|e| e.set_password(value))
        .map_err(|e| format!("saving {name} to the keychain: {e}"))
}

/// Forget a value; one that was never stored is already forgotten.
/// Blocking: call it from `spawn_blocking`.
pub fn delete(agent: &str, name: &str) -> Result<(), String> {
    match entry(agent, name).and_then(|e| e.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("removing {name} from the keychain: {e}")),
    }
}
