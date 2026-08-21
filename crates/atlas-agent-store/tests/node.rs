//! The managed Node runtime's pure parts: the npm version-ceiling rule, the
//! package-executable lookup, and the environment an npx agent is given.
//!
//! Downloading Node is not tested here — it is a 50 MB network fetch, and the
//! part of it worth pinning (that a broken install is detected and replaced)
//! needs a real Node to be meaningful.

use std::path::Path;

use atlas_agent_store::node::{
    bounded_npm_package_spec, npm_command_env, read_package_executable,
};
use atlas_agent_store::NodeRuntime;

/// A ceiling, not a pin — see the function's docs for why.
#[test]
fn builds_bounded_npm_package_specs() {
    assert_eq!(
        bounded_npm_package_spec("agent-package@1.2.3"),
        ("agent-package", "agent-package@0.0.0 - 1.2.3".to_string())
    );
    assert_eq!(
        bounded_npm_package_spec("@scope/agent-package@1.2.3-beta.1"),
        (
            "@scope/agent-package",
            "@scope/agent-package@0.0.0 - 1.2.3-beta.1".to_string()
        )
    );
    // No version: nothing to bound.
    assert_eq!(
        bounded_npm_package_spec("@scope/agent-package"),
        ("@scope/agent-package", "@scope/agent-package".to_string())
    );
    // A dist-tag is not a version, so it is passed through untouched.
    assert_eq!(
        bounded_npm_package_spec("agent-package@latest"),
        ("agent-package", "agent-package@latest".to_string())
    );
}

fn package(dir: &Path, name: &str, package_json: &str) {
    let package_dir = dir.join(name);
    std::fs::create_dir_all(&package_dir).unwrap();
    std::fs::write(package_dir.join("package.json"), package_json).unwrap();
}

#[tokio::test]
async fn reads_a_string_bin_field() {
    let dir = tempfile::tempdir().unwrap();
    package(dir.path(), "some-cli", r#"{"bin": "./dist/cli.js"}"#);

    assert_eq!(
        read_package_executable(dir.path(), "some-cli").await.unwrap(),
        dir.path().join("some-cli/./dist/cli.js")
    );
}

#[tokio::test]
async fn reads_a_named_bin_field() {
    let dir = tempfile::tempdir().unwrap();
    // One entry: its name does not have to match the package.
    package(dir.path(), "some-cli", r#"{"bin": {"whatever": "cli.js"}}"#);
    assert_eq!(
        read_package_executable(dir.path(), "some-cli").await.unwrap(),
        dir.path().join("some-cli/cli.js")
    );

    // Several: the one named after the package (unscoped) is ours.
    package(
        dir.path(),
        "@scope/other-cli",
        r#"{"bin": {"other-cli": "acp.js", "helper": "helper.js"}}"#,
    );
    assert_eq!(
        read_package_executable(dir.path(), "@scope/other-cli")
            .await
            .unwrap(),
        dir.path().join("@scope/other-cli/acp.js")
    );
}

#[tokio::test]
async fn a_package_with_no_executable_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    package(dir.path(), "some-cli", r#"{"name": "some-cli"}"#);
    assert!(read_package_executable(dir.path(), "some-cli").await.is_err());

    package(
        dir.path(),
        "other-cli",
        r#"{"bin": {"a": "a.js", "b": "b.js"}}"#,
    );
    assert!(read_package_executable(dir.path(), "other-cli").await.is_err());

    assert!(read_package_executable(dir.path(), "missing").await.is_err());
}

/// The managed Node has to win the `PATH` race: a package that shells out to
/// `node` must get ours, not whatever the user has.
#[test]
fn puts_the_managed_node_first_on_path() {
    let env = npm_command_env(Path::new("/opt/atlas/node/bin/node"));
    let path = env.get("PATH").expect("PATH is always set");
    assert!(
        path.starts_with("/opt/atlas/node/bin"),
        "managed node must come first, got {path}"
    );
}

#[tokio::test]
async fn an_unavailable_runtime_says_so() {
    let node = NodeRuntime::unavailable("disabled in this test");
    let error = node.binary_path().await.unwrap_err();
    assert!(
        error.to_string().contains("disabled in this test"),
        "unexpected error: {error:#}"
    );
}
