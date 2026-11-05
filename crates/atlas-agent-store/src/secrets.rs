//! Variables the user marked sensitive in Settings → Agents. The installed map
//! keeps only their names; the values live in the OS keychain, behind a
//! [`SecretSource`] the app provides, and are read when the agent starts — so
//! a value is never in a settings file and never held longer than a launch.

use std::collections::HashMap;
use std::sync::Arc;

/// Where sensitive values are read from: the OS keychain in the app.
pub trait SecretSource: Send + Sync {
    /// The value stored for `name` on `agent`, if any.
    fn read(&self, agent: &str, name: &str) -> Option<String>;
}

/// One agent's sensitive variables, resolved at launch.
#[derive(Clone, Default)]
pub struct SecretEnv {
    agent: String,
    names: Vec<String>,
    source: Option<Arc<dyn SecretSource>>,
}

impl SecretEnv {
    pub fn new(agent: &str, names: &[String], source: Option<Arc<dyn SecretSource>>) -> Self {
        Self {
            agent: agent.to_owned(),
            names: names.to_vec(),
            source,
        }
    }

    /// `env` with each stored value over it. A name with no stored value
    /// leaves `env` as it was: a missing secret is the agent's to report.
    pub async fn layer_over(&self, mut env: HashMap<String, String>) -> HashMap<String, String> {
        let Some(source) = self.source.clone() else {
            return env;
        };
        if self.names.is_empty() {
            return env;
        }
        let agent = self.agent.clone();
        let names = self.names.clone();
        // A keychain read can block on the OS, so it stays off the runtime.
        let values = tokio::task::spawn_blocking(move || {
            names
                .into_iter()
                .filter_map(|name| source.read(&agent, &name).map(|value| (name, value)))
                .collect::<Vec<_>>()
        })
        .await
        .unwrap_or_default();
        env.extend(values);
        env
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixed;
    impl SecretSource for Fixed {
        fn read(&self, agent: &str, name: &str) -> Option<String> {
            (agent == "a" && name == "TOKEN").then(|| "s3cret".to_owned())
        }
    }

    #[tokio::test]
    async fn stored_values_layer_over_and_missing_ones_leave_env_alone() {
        let secrets = SecretEnv::new(
            "a",
            &["TOKEN".to_owned(), "MISSING".to_owned()],
            Some(Arc::new(Fixed)),
        );
        let env = secrets
            .layer_over(HashMap::from([
                ("TOKEN".to_owned(), "plain".to_owned()),
                ("OTHER".to_owned(), "1".to_owned()),
            ]))
            .await;
        assert_eq!(env["TOKEN"], "s3cret");
        assert_eq!(env["OTHER"], "1");
        assert!(!env.contains_key("MISSING"));
    }
}
