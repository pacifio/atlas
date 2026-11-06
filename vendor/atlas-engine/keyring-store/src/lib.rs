// Modified by Atlas from upstream OpenAI Codex (Apache-2.0). See CONTEXT.md.
use keyring_core::Entry;
use keyring_core::Error as KeyringError;
use std::error::Error;
use std::fmt;
use std::fmt::Debug;
use std::sync::Mutex;
use std::sync::PoisonError;
use tracing::trace;

/// Install the platform credential store as keyring-core's process-wide default, if
/// no store is installed yet. Idempotent and cheap once installed.
///
/// keyring 3 picked a store implicitly from its enabled features; keyring-core has
/// none until one is set, and every `Entry::new` before that fails with
/// `NoDefaultStore`. Every entry this workspace makes goes through here first
/// ([`DefaultKeyringStore`] below, and the app's agent-variable keychain), so there
/// is no start-up ordering to get wrong. A store a caller already installed (the
/// tests install mocks) is left alone. A failure to build the store is returned, not
/// cached: the next call tries again.
///
/// The store each platform gets reads and writes the same OS items keyring 3 did for
/// a given `(service, user)`:
/// - macOS: the login keychain, generic password, service = service, account = user.
/// - Windows: Credential Manager generic credential, target name `user.service`,
///   Enterprise persistence, UTF-16LE blob.
/// - Linux: Secret Service items with attributes `service` and `username`, in the
///   default collection. keyring 3.6's `linux-native-async-persistent` default
///   builder only ever built Secret Service credentials, never keyutils ones.
pub fn ensure_default_store() -> Result<(), KeyringError> {
    static INSTALL: Mutex<()> = Mutex::new(());
    if keyring_core::get_default_store().is_some() {
        return Ok(());
    }
    let _guard = INSTALL.lock().unwrap_or_else(PoisonError::into_inner);
    if keyring_core::get_default_store().is_some() {
        return Ok(());
    }
    keyring_core::set_default_store(platform_store()?);
    Ok(())
}

#[cfg(target_os = "macos")]
fn platform_store() -> Result<std::sync::Arc<keyring_core::CredentialStore>, KeyringError> {
    Ok(apple_native_keyring_store::keychain::Store::new()?)
}

#[cfg(target_os = "windows")]
fn platform_store() -> Result<std::sync::Arc<keyring_core::CredentialStore>, KeyringError> {
    Ok(windows_native_keyring_store::Store::new()?)
}

#[cfg(any(target_os = "linux", target_os = "freebsd", target_os = "openbsd"))]
fn platform_store() -> Result<std::sync::Arc<keyring_core::CredentialStore>, KeyringError> {
    Ok(zbus_secret_service_keyring_store::Store::new()?)
}

#[cfg(not(any(
    target_os = "macos",
    target_os = "windows",
    target_os = "linux",
    target_os = "freebsd",
    target_os = "openbsd"
)))]
fn platform_store() -> Result<std::sync::Arc<keyring_core::CredentialStore>, KeyringError> {
    Err(KeyringError::NotSupportedByStore(
        "no credential store for this platform".to_string(),
    ))
}

#[derive(Debug)]
pub enum CredentialStoreError {
    Other(KeyringError),
}

impl CredentialStoreError {
    pub fn new(error: KeyringError) -> Self {
        Self::Other(error)
    }

    pub fn message(&self) -> String {
        match self {
            Self::Other(error) => error.to_string(),
        }
    }

    pub fn into_error(self) -> KeyringError {
        match self {
            Self::Other(error) => error,
        }
    }
}

impl fmt::Display for CredentialStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Other(error) => write!(f, "{error}"),
        }
    }
}

impl Error for CredentialStoreError {}

/// Shared credential store abstraction for keyring-backed implementations.
pub trait KeyringStore: Debug + Send + Sync {
    fn load(&self, service: &str, account: &str) -> Result<Option<String>, CredentialStoreError>;
    fn save(&self, service: &str, account: &str, value: &str) -> Result<(), CredentialStoreError>;
    fn delete(&self, service: &str, account: &str) -> Result<bool, CredentialStoreError>;
}

#[derive(Debug, Clone, Copy)]
pub struct DefaultKeyringStore;

impl KeyringStore for DefaultKeyringStore {
    fn load(&self, service: &str, account: &str) -> Result<Option<String>, CredentialStoreError> {
        trace!("keyring.load start, service={service}, account={account}");
        ensure_default_store().map_err(CredentialStoreError::new)?;
        let entry = Entry::new(service, account).map_err(CredentialStoreError::new)?;
        match entry.get_password() {
            Ok(password) => {
                trace!("keyring.load success, service={service}, account={account}");
                Ok(Some(password))
            }
            Err(KeyringError::NoEntry) => {
                trace!("keyring.load no entry, service={service}, account={account}");
                Ok(None)
            }
            Err(error) => {
                trace!("keyring.load error, service={service}, account={account}, error={error}");
                Err(CredentialStoreError::new(error))
            }
        }
    }

    fn save(&self, service: &str, account: &str, value: &str) -> Result<(), CredentialStoreError> {
        trace!(
            "keyring.save start, service={service}, account={account}, value_len={}",
            value.len()
        );
        ensure_default_store().map_err(CredentialStoreError::new)?;
        let entry = Entry::new(service, account).map_err(CredentialStoreError::new)?;
        match entry.set_password(value) {
            Ok(()) => {
                trace!("keyring.save success, service={service}, account={account}");
                Ok(())
            }
            Err(error) => {
                trace!("keyring.save error, service={service}, account={account}, error={error}");
                Err(CredentialStoreError::new(error))
            }
        }
    }

    fn delete(&self, service: &str, account: &str) -> Result<bool, CredentialStoreError> {
        trace!("keyring.delete start, service={service}, account={account}");
        ensure_default_store().map_err(CredentialStoreError::new)?;
        let entry = Entry::new(service, account).map_err(CredentialStoreError::new)?;
        match entry.delete_credential() {
            Ok(()) => {
                trace!("keyring.delete success, service={service}, account={account}");
                Ok(true)
            }
            Err(KeyringError::NoEntry) => {
                trace!("keyring.delete no entry, service={service}, account={account}");
                Ok(false)
            }
            Err(error) => {
                trace!("keyring.delete error, service={service}, account={account}, error={error}");
                Err(CredentialStoreError::new(error))
            }
        }
    }
}

pub mod tests {
    use super::CredentialStoreError;
    use super::KeyringStore;
    use keyring_core::Error as KeyringError;
    use keyring_core::api::CredentialApi as _;
    use keyring_core::mock::Cred as MockCredential;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::sync::Mutex;
    use std::sync::PoisonError;

    #[derive(Default, Clone, Debug)]
    pub struct MockKeyringStore {
        credentials: Arc<Mutex<HashMap<String, Arc<MockCredential>>>>,
    }

    impl MockKeyringStore {
        pub fn credential(&self, account: &str) -> Arc<MockCredential> {
            let mut guard = self
                .credentials
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            guard
                .entry(account.to_string())
                .or_insert_with(|| {
                    Arc::new(MockCredential {
                        specifiers: (String::new(), account.to_string()),
                        inner: Mutex::new(RefCell::new(Default::default())),
                    })
                })
                .clone()
        }

        pub fn saved_value(&self, account: &str) -> Option<String> {
            let credential = {
                let guard = self
                    .credentials
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner);
                guard.get(account).cloned()
            }?;
            credential.get_password().ok()
        }

        pub fn set_error(&self, account: &str, error: KeyringError) {
            let credential = self.credential(account);
            credential.set_error(error);
        }

        pub fn contains(&self, account: &str) -> bool {
            let guard = self
                .credentials
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            guard.contains_key(account)
        }
    }

    impl KeyringStore for MockKeyringStore {
        fn load(
            &self,
            _service: &str,
            account: &str,
        ) -> Result<Option<String>, CredentialStoreError> {
            let credential = {
                let guard = self
                    .credentials
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner);
                guard.get(account).cloned()
            };

            let Some(credential) = credential else {
                return Ok(None);
            };

            match credential.get_password() {
                Ok(password) => Ok(Some(password)),
                Err(KeyringError::NoEntry) => Ok(None),
                Err(error) => Err(CredentialStoreError::new(error)),
            }
        }

        fn save(
            &self,
            _service: &str,
            account: &str,
            value: &str,
        ) -> Result<(), CredentialStoreError> {
            let credential = self.credential(account);
            credential
                .set_password(value)
                .map_err(CredentialStoreError::new)
        }

        fn delete(&self, _service: &str, account: &str) -> Result<bool, CredentialStoreError> {
            let credential = {
                let guard = self
                    .credentials
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner);
                guard.get(account).cloned()
            };

            let Some(credential) = credential else {
                return Ok(false);
            };

            let removed = match credential.delete_credential() {
                Ok(()) => Ok(true),
                Err(KeyringError::NoEntry) => Ok(false),
                Err(error) => Err(CredentialStoreError::new(error)),
            }?;

            let mut guard = self
                .credentials
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            guard.remove(account);
            Ok(removed)
        }
    }
}
